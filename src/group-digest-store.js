// 群聊近况摘要（D）—— 纯逻辑模块，无 IO、无副作用。
//
// 为什么需要它：
//   她在群里聊天时，上下文里只有那个群的最近 100 条；跟主人私聊时，
//   上下文里只有主人私聊的 100 条 + 共享记忆里被人为 remember 过的条目。
//   中间没有通道 —— 主人问「群里刚才怎么样」，她其实答不上来。
//
// 设计边界（主人 m03982 定的）：
//   · 只回答「主人问起」这一种场景。不主动汇报、不定时推送。
//   · 只给被问到的**那一个群**，不批量灌所有群。
//   · 这是只读视图 —— 读最近 N 条拼摘要，不发消息、不唤醒、不改会话状态。
//
// 为什么判定要严：
//   主人私聊里大半时间在聊正事（修 bug、问配置）。如果「群里」两个字一出现
//   就往 prompt 里塞几百字群聊记录，那不是在帮他，是在打断他。
//   所以宁可漏（他没得到群近况，再问一次就好），也不要误命中。

/** 摘要里每个群最多给几条消息。 */
export const DIGEST_MAX_MESSAGES = 8;
/** 每条消息正文最多保留多少字。 */
export const DIGEST_MSG_CHARS = 60;
/** 单条摘要总字数上限（超出就截断消息条数，不截断句子）。 */
export const DIGEST_MAX_CHARS = 700;
/** 超过这么久的消息不算「刚才」，只当背景。 */
export const DIGEST_STALE_MS = 6 * 60 * 60 * 1000;

/**
 * 把一条消息压成一行。空消息、纯媒体消息给占位，别让摘要里出现空洞。
 * @param {{sender?: string, plain?: string, text?: string, isSelf?: boolean, isOwner?: boolean, hasMedia?: boolean}} msg
 * @returns {string}
 */
export function oneLineMessage(msg) {
  if (!msg || typeof msg !== 'object') return '';
  const raw = String(msg.plain ?? msg.text ?? '').replace(/\s+/g, ' ').trim();
  const clipped = raw.length > DIGEST_MSG_CHARS ? raw.slice(0, DIGEST_MSG_CHARS) + '…' : raw;
  if (!clipped) {
    if (msg.hasMedia) return msg.isSelf ? '（我发了一张图）' : `（${msg.sender || '有人'}发了一张图）`;
    return '';
  }
  if (msg.isSelf) return `我：${clipped}`;
  const who = String(msg.sender ?? '').trim() || '有人';
  return `${who}：${clipped}`;
}

/**
 * 判断一句话是不是在问群里的情况。
 *
 * 两道闸，都过才算：
 *   1. 有「群」这个锚点，或者有指向别处的代词（他们/那边/群里）；
 *   2. 是疑问/询问的口吻。
 *
 * 只有锚点没有疑问（「他们那群人真菜」）不算 —— 那是在吐槽，不是要情报。
 * 只有疑问没有锚点（「今天怎么样」）也不算 —— 那多半在问他自己。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function asksAboutGroups(text) {
  const s = String(text ?? '').toLowerCase().trim();
  if (!s || s.length > 200) return false;
  // 锚点：明确提到群/他们/那边/大家
  const anchor = /群|他们|她们|那边|其他人|别人|大伙|大家|群里|群聊|水群/.test(s);
  if (!anchor) return false;
  // 疑问口吻
  const asking = /[?？吗呢]|怎么样|咋样|如何|说了什么|说什么|聊什么|聊了啥|干啥|干什么|干了什么|发生了|怎么了|有什么|有没有|有啥|动静|新鲜事|在聊|在说|最近|情况/.test(s);
  if (!asking) return false;
  // 反向排除：明显在说群配置/功能（「群聊功能好了吗」「群里那事你别管」）
  if (/(配置|设置|权限|白名单|开关|功能|代码|部署|重启|报错|bug|群号是多少)/.test(s)) return false;
  return true;
}

/**
 * 从这句话里猜主人指的是哪个群。
 *
 * 只在有多个候选群时才需要猜，所以：
 *   · 只有一个群有消息 → 直接给那个；
 *   · 句子里出现某个群的成员昵称 → 给那个群；
 *   · 句子里出现群号 → 给那个群；
 *   · 都判断不出来 → 给最近说话最多的那个（最可能被问到的）。
 *
 * @param {string} text 主人说的话
 * @param {Array<{key: string, name?: string, count: number, lastAt: number, senders?: string[]}>} candidates
 * @returns {string|null} 群 key
 */
export function pickGroupFor(text, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => c && c.key && c.count > 0) : [];
  if (!list.length) return null;
  if (list.length === 1) return list[0].key;
  const s = String(text ?? '');
  // 群号直接命中
  for (const c of list) {
    const id = String(c.key).split(':')[1] ?? '';
    if (id && s.includes(id)) return c.key;
  }
  // 成员昵称命中（长名字优先，避免「小鲸鱼」抢了「小鲸鱼在潜水」）
  const hits = [];
  for (const c of list) {
    for (const who of (c.senders ?? [])) {
      const name = String(who ?? '').trim();
      if (name.length >= 2 && s.includes(name)) hits.push({ key: c.key, len: name.length });
    }
  }
  if (hits.length) {
    hits.sort((a, b) => b.len - a.len);
    return hits[0].key;
  }
  // 兜底：最近最活跃的
  const sorted = [...list].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || (b.count || 0) - (a.count || 0));
  return sorted[0].key ?? null;
}

/**
 * 生成一段群近况文本。
 *
 * 输出形如：
 * ```
 * 【群里的近况】906710082
 * 半小时前
 *   超大肥鱼：主人？谁封的，我认吗
 *   我：对，你别认就行
 * ```
 * 没有任何可说的返回空串（调用方据空串决定不注入）。
 *
 * @param {{key: string, messages: Array, now?: number}} input
 * @returns {string}
 */
export function formatGroupDigest({ key, messages, now = Date.now() } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  if (!key || !list.length) return '';
  const gid = String(key).split(':')[1] ?? key;
  // 取最后 DIGEST_MAX_MESSAGES 条，从新往旧累积到字数上限
  const tail = list.slice(-DIGEST_MAX_MESSAGES);
  const lines = [];
  let used = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = oneLineMessage(tail[i]);
    if (!line) continue;
    if (used + line.length > DIGEST_MAX_CHARS) break;
    lines.unshift(line);
    used += line.length;
  }
  if (!lines.length) return '';
  const oldestAt = Number(tail[0]?.time ?? 0);
  const ageMs = oldestAt > 0 ? Math.max(0, now - oldestAt) : 0;
  let when = '';
  if (ageMs > 0) {
    const min = Math.round(ageMs / 60000);
    if (min >= 60) when = `约 ${Math.round(min / 60)} 小时前起`;
    else if (min >= 1) when = `约 ${min} 分钟前起`;
    else when = '刚刚';
    if (ageMs > DIGEST_STALE_MS) when += '（这些已经有一阵子了，说的时候带上「之前」）';
  }
  const head = `【群里的近况】群 ${gid}${when ? '，' + when : ''}`;
  return head + '\n' + lines.map((l) => '  ' + l).join('\n');
}

/**
 * 把 Map / 普通对象 / 数组三种会话容器统一成 [key, conv] 迭代。
 *
 * ⚠️ 这里必须容 Map：bridge.js 里 `socialV2.conversations` 是 **Map**，
 * 而 `Object.entries(Map)` 恒返回 `[]` —— 只写 Object.entries 的话，
 * 线上调用会永远拿不到候选群，且**不报错**（静默返回空数组）。
 * 这个坑是在隔离副本跑真数据时才暴露的：纯逻辑单测传的是普通对象，全绿。
 */
function conversationEntries(conversations) {
  if (!conversations) return [];
  if (conversations instanceof Map) return [...conversations.entries()];
  if (Array.isArray(conversations)) return conversations;
  if (typeof conversations === 'object') return Object.entries(conversations);
  return [];
}

/**
 * 从会话容器里挑出可以当「群近况」来源的候选。
 * 只算群，不算私聊；空群（没有任何消息）跳过。
 *
 * @param {Map<string, {recentMessages?: Array}>|Record<string, {recentMessages?: Array}>} conversations
 * @returns {Array<{key: string, count: number, lastAt: number, senders: string[]}>}
 */
export function listGroupCandidates(conversations) {
  const out = [];
  for (const [key, conv] of conversationEntries(conversations)) {
    if (!/^group:\d+$/.test(String(key))) continue;
    const msgs = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    if (!msgs.length) continue;
    const senders = new Set();
    let lastAt = 0;
    for (const m of msgs) {
      const who = String(m?.sender ?? '').trim();
      // 「我」「私聊」「对方」是占位符，不是人，不能当昵称线索
      if (who && who !== '我' && who !== '私聊' && who !== '对方') senders.add(who);
      const t = Number(m?.time ?? 0);
      if (Number.isFinite(t) && t > lastAt) lastAt = t;
    }
    out.push({ key, count: msgs.length, lastAt, senders: [...senders] });
  }
  return out;
}

// ── 睡眠整合（每天一次回顾）─────────────────────────────────────────────
//
// 图里写的是「凌晨 4 点回顾今天：翻聊天 / 补日记 / 补好感度 / 只是提醒不强制」。
// 关键取舍：**4 点整不叫醒她**。她凌晨四点大概率在潜水，硬叫醒会打断睡眠。
// 所以做成「4 点之后她第一次自然醒来时顺带注入」，跟日程结算同一套路。

/** 几点之后才允许回顾（与 schedule-store 的 REVIEW_START_HOUR 一致）。 */
export const SLEEP_REVIEW_HOUR = 4;
/** 回顾注入里最多列几个会话。 */
export const REVIEW_MAX_CONVERSATIONS = 6;
/** 每个会话最多给几条最后消息。 */
export const REVIEW_MSGS_PER_CONVERSATION = 3;
/** 回顾素材总字数上限。 */
export const REVIEW_MAX_CHARS = 1200;

/** 本地日期 YYYY-MM-DD（服务器已是 Asia/Shanghai）。 */
export function localDayOf(d = new Date()) {
  const dt = d instanceof Date ? d : new Date(d);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

/**
 * 今天该不该做睡眠回顾。
 *
 * 三个条件全满足才返回 true：
 *   1. 当前时间 >= SLEEP_REVIEW_HOUR
 *   2. 今天还没回顾过
 *   3. 昨天（或今天早些时候）确实有活动 —— 什么都没发生的一天不值得回顾
 *
 * @param {{reviewDays?: Record<string,string>}} state
 * @param {{key?: string, now?: Date, hasActivity?: boolean}} opts
 * @returns {boolean}
 */
export function shouldSleepReview(state, { key = '*', now = new Date(), hasActivity = true } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  if (dt.getHours() < SLEEP_REVIEW_HOUR) return false;
  if (!hasActivity) return false;
  const today = localDayOf(dt);
  const k = String(key || '*');
  if (state?.reviewDays?.[k] === today) return false;
  return true;
}

/** 标记今天已回顾。 */
export function markSleepReviewed(state, { key = '*', now = new Date() } = {}) {
  const dt = now instanceof Date ? now : new Date(now);
  if (!state.reviewDays || typeof state.reviewDays !== 'object') state.reviewDays = {};
  const day = localDayOf(dt);
  state.reviewDays[String(key || '*')] = day;
  return day;
}

/**
 * 收集「今天发生过什么」的素材，拼成一段给她回顾的文本。
 *
 * 给摘要不给全文 —— 16 个会话 × 100 条直接塞进去就是几万字。
 * 每个会话只给最后几句 + 一句「你说了几句」。
 *
 * @param {{
 *   conversations: Record<string, {recentMessages?: Array}>,
 *   now?: number,
 *   dayStartMs?: number
 * }} input
 * @returns {string}
 */
export function formatSleepReviewMaterial({ conversations, now = Date.now(), dayStartMs } = {}) {
  if (!conversations || typeof conversations !== 'object') return '';
  // 没有传就是「今天 0 点起」
  const start = Number.isFinite(dayStartMs) ? dayStartMs : (() => {
    const d = new Date(now);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  })();
  const blocks = [];
  for (const [key, conv] of Object.entries(conversations)) {
    if (!/^(group|private):\d+$/.test(String(key))) continue;
    const msgs = Array.isArray(conv?.recentMessages) ? conv.recentMessages : [];
    const todayMsgs = msgs.filter((m) => Number(m?.time ?? 0) >= start);
    if (!todayMsgs.length) continue;
    const selfCount = todayMsgs.filter((m) => m?.isSelf).length;
    const others = new Set(todayMsgs.filter((m) => !m?.isSelf).map((m) => String(m?.sender ?? '')));
    const tail = todayMsgs.slice(-REVIEW_MSGS_PER_CONVERSATION);
    const lines = tail.map((m) => oneLineMessage(m)).filter(Boolean);
    if (!lines.length) continue;
    const label = key.startsWith('group:') ? `群 ${key.split(':')[1]}` : `私聊 ${key.split(':')[1]}`;
    const stat = `（今天 ${todayMsgs.length} 条消息${others.size ? `，${others.size} 个人` : ''}，你说了 ${selfCount} 句）`;
    blocks.push(`${label}${stat}\n` + lines.map((l) => '  ' + l).join('\n'));
  }
  if (!blocks.length) return '';
  blocks.sort((a, b) => b.length - a.length);
  const kept = [];
  let used = 0;
  for (const b of blocks) {
    if (kept.length >= REVIEW_MAX_CONVERSATIONS) break;
    if (used + b.length > REVIEW_MAX_CHARS) break;
    kept.push(b);
    used += b.length;
  }
  return kept.join('\n');
}
