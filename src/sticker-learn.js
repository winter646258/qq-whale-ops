// 表情包「自己学会」—— 从群里高频出现的图里自动挑几张收进自己的库。
//
// 为什么要有它：
//   `state/sticker-sightings.json` 已经记了群里哪些图在反复出现（500 条观测），
//   但**没有任何东西会去用它**。策略提示里写着「让 AI 自己调 qq_collect_sticker」，
//   可她没有理由在聊天中途停下来收藏表情，实测一张都没收藏过。
//   所以这里补上「自己动手」的那一半：观测到够多次数 → 自动收藏 → 记下语境。
//
// 关键约束（都是踩过的坑，别改）：
//   1. **sightings 里的 url 不能用**。那是入站时的签名地址，几小时就失效，
//      实测 `safeFetchRaw` 直下 3/3 全部 HTTP 400。能用的是
//      `social-v2.json` 的 recentMessages[].media（网关 get_image 能换出新鲜 url）。
//   2. **recentMessages 每会话只留 100 条**，所以候选必须「观测次数达标」+
//      「还留在 recentMessages 里」两个条件同时成立，缺一个就只能等下次。
//   3. 收藏走 add_custom_face 原生通道（和她手动收藏同一条路），
//      不能自己拼 image 段，否则对方看到的是「可下载的图片」不是表情。
//   4. 备注（desc）写的是**语境不是用法**。用法得她自己看图后写（qq_sticker_note），
//      这里擅自猜「什么时候用」只会污染提示词。
//
// 这个模块只做纯逻辑（候选挑选、限流、记账），IO 全在 bridge.js 里。

export const LEARN_DEFAULTS = {
  enabled: true,
  minCount: 3,          // 观测到几次才算「群里的常客」
  maxPerDay: 5,         // 一天最多自动学几张，防刷屏式囤图
  minIntervalMs: 3600_000, // 两次学习之间至少隔多久
  maxPerTick: 2,        // 一次 tick 最多收几张（get_image + add_custom_face 各一次往返，别堵）
  retryAfterMs: 6 * 3600_000, // 失败过的图多久后允许再试
  remarkMaxChars: 20
};

/** 从 media.file（`<MD5>.jpg`）或 media.md5 取大写哈希。和 sticker-sightings 同口径。 */
export function hashOfMedia(media) {
  if (!media || typeof media !== 'object') return '';
  if (String(media.kind || '') !== 'image') return '';
  const m = /^([0-9A-Fa-f]{32})\./.exec(String(media.file || ''));
  if (m) return m[1].toUpperCase();
  const md5 = String(media.md5 || '');
  return /^[0-9A-Fa-f]{32}$/.test(md5) ? md5.toUpperCase() : '';
}

/** 把各会话的 recentMessages 摊平成 hash → {key, media, text} 。后来的覆盖先前的（更新的会话状态优先）。 */
export function buildRecentIndex(conversations) {
  const index = new Map();
  for (const [key, conv] of Object.entries(conversations || {})) {
    const msgs = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    for (let i = 0; i < msgs.length; i += 1) {
      const msg = msgs[i];
      const media = Array.isArray(msg?.media) ? msg.media : [];
      const images = media.filter((x) => hashOfMedia(x));
      // 一条消息里有多张图时**整条跳过**：collectStickerV2 取的是 mediaList[0]，
      // 多图消息会让「想收藏 A 结果收了 B」，宁可不学也不能学错。
      if (images.length !== 1) continue;
      const item = images[0];
      const hash = hashOfMedia(item);
      if (!hash) continue;
      // 图片消息本身的文本恒为「[图片]」，没有信息量；拿上一条的文字当语境。
      const own = String(msg?.plain || msg?.text || '').trim();
      const prev = i > 0 ? String(msgs[i - 1]?.plain || msgs[i - 1]?.text || '').trim() : '';
      const text = /^\[图片\]$/.test(own) ? prev : own;
      index.set(hash, {
        key,
        media: item,
        text,
        at: Number(msg?.time) || 0,
        sender: String(msg?.sender || ''),
        // 收藏要走现成的 collectStickerV2(key, messageRef, remark)，
        // 它按 messageId / seq 在 recentMessages 里找那条消息 —— 所以这里必须带上。
        messageId: String(msg?.messageId ?? msg?.seq ?? ''),
        isSelf: Boolean(msg?.isSelf)
      });
    }
  }
  return index;
}

function dayKey(now) {
  // 和别的模块一致：UTC+8 自然日
  return new Date(now + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 今日已学几张 / 是否还在冷却。record 是 state/sticker-learn.json 的内容。 */
export function learnQuota(record, opts, now = Date.now()) {
  const cfg = { ...LEARN_DEFAULTS, ...(opts || {}) };
  const today = dayKey(now);
  const days = record?.days && typeof record.days === 'object' ? record.days : {};
  const usedToday = Math.max(0, Number(days[today]) || 0);
  const lastAt = Math.max(0, Number(record?.lastAt) || 0);
  const waitMs = lastAt ? Math.max(0, cfg.minIntervalMs - (now - lastAt)) : 0;
  const leftToday = Math.max(0, cfg.maxPerDay - usedToday);
  return {
    today,
    usedToday,
    leftToday,
    waitMs,
    can: cfg.enabled !== false && leftToday > 0 && waitMs === 0
  };
}

/**
 * 挑这一轮该学哪几张。
 *
 * @param sightings  sticker-sightings.json 的 items 数组
 * @param library    state/stickers.json（本地表情库）
 * @param recentIndex buildRecentIndex 的结果
 * @param record     state/sticker-learn.json（失败记录 + 日配额）
 * @returns 候选数组，按观测次数从高到低；调用方按 maxPerTick 截断
 */
export function pickLearnCandidates({ sightings, library, recentIndex, record, now = Date.now(), opts } = {}) {
  const cfg = { ...LEARN_DEFAULTS, ...(opts || {}) };
  if (cfg.enabled === false) return [];
  const quota = learnQuota(record, cfg, now);
  if (!quota.can) return [];

  const libHashes = new Set();
  for (const entry of Array.isArray(library) ? library : []) {
    const md5 = String(entry?.md5 || '').toUpperCase();
    if (/^[0-9A-F]{32}$/.test(md5)) libHashes.add(md5);
  }

  const tried = record?.tried && typeof record.tried === 'object' ? record.tried : {};
  const out = [];
  for (const item of Array.isArray(sightings) ? sightings : []) {
    const hash = String(item?.hash || '').toUpperCase();
    if (!/^[0-9A-F]{32}$/.test(hash)) continue;
    const count = Number(item?.count) || 0;
    if (count < Math.max(1, Number(cfg.minCount) || 3)) continue;
    if (libHashes.has(hash)) continue;              // 已经在库
    const hit = recentIndex instanceof Map ? recentIndex.get(hash) : null;
    if (!hit) continue;                              // 缓存里已经滚掉了，取不到字节
    if (hit.isSelf) continue;                        // 我自己发的表情，本来就在库里
    if (!hit.messageId) continue;                    // 没有 messageId 收不了（collectStickerV2 靠它定位）
    const last = tried[hash];
    const lastAt = Number(last?.at) || 0;
    if (last && !last.ok && now - lastAt < cfg.retryAfterMs) continue; // 刚失败过，别重试
    if (last && last.ok && now - lastAt < cfg.retryAfterMs) continue;    // 刚成功过（sync 还没回来）
    out.push({
      hash,
      count,
      key: hit.key,
      file: String(hit.media?.file || ''),
      media: hit.media,
      messageId: hit.messageId,
      context: String(hit.text || '').slice(0, 60),
      sender: hit.sender
    });
  }
  out.sort((a, b) => b.count - a.count);
  return out;
}

/**
 * 给一张自动学来的表情起个备注（写进网关的 desc，会跟着 sync 回到本地库）。
 *
 * 只描述**来源与语境**，不假装懂它的用法：
 * 「群里常见(N次)：<语境片段>」——语境是她以后判断「什么时候用」的唯一线索。
 * 语境里如果带着明显的人名/id 噪声就丢掉，只留一句干净的话。
 */
export function buildLearnRemark(candidate, opts) {
  const cfg = { ...LEARN_DEFAULTS, ...(opts || {}) };
  const max = Math.max(4, Number(cfg.remarkMaxChars) || 20);
  const ctx = String(candidate?.context || '')
    .replace(/^[^：:]{1,20}[：:]/, '')       // 去掉「昵称：」前缀
    .replace(/\s+/g, ' ')
    .trim();
  const head = `群里常见${Number(candidate?.count) || 0}次`;
  // 语境本身也是占位（连发两张图时上一条就是「[图片]」）时只写次数 ——
  // 「群里常见6次：[图片]」这种备注进提示词等于噪声，还不如短。
  const placeholder = !ctx || /^(\[图片\]|\[表情\]|\[动画表情\]|\[视频\]|\[文件\])$/.test(ctx);
  if (placeholder) return head.slice(0, max);
  const room = Math.max(0, max - head.length - 1);
  if (room < 2) return head.slice(0, max);
  return `${head}：${ctx.slice(0, room)}`.slice(0, max);
}

/** 记一笔结果，返回新的 record（纯函数，调用方负责落盘）。 */
export function recordLearnAttempt(record, hash, { ok, error, now = Date.now() } = {}) {
  const base = record && typeof record === 'object' ? record : {};
  const tried = base.tried && typeof base.tried === 'object' ? { ...base.tried } : {};
  tried[String(hash || '').toUpperCase()] = {
    at: now,
    ok: Boolean(ok),
    error: error ? String(error).slice(0, 120) : ''
  };
  // 只留最近 200 条尝试记录，别让这个文件无限长大
  const entries = Object.entries(tried).sort((a, b) => (Number(b[1]?.at) || 0) - (Number(a[1]?.at) || 0));
  const trimmed = Object.fromEntries(entries.slice(0, 200));
  const today = dayKey(now);
  const days = base.days && typeof base.days === 'object' ? { ...base.days } : {};
  // 只保留最近 14 天的计数
  const keptDays = Object.entries(days)
    .filter(([d]) => Math.abs(Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) <= 14 * 86400_000)
    .map(([d, n]) => [d, Number(n) || 0]);
  const dayMap = Object.fromEntries(keptDays);
  if (ok) dayMap[today] = (Number(dayMap[today]) || 0) + 1;
  return {
    version: 1,
    updatedAt: now,
    lastAt: ok ? now : Number(base.lastAt) || 0,
    days: dayMap,
    tried: trimmed
  };
}
