/**
 * B 站只读客户端 —— site-bili.js
 *
 * 三件事：WBI 签名、调接口、把 JSON 整理成人能读的摘要。
 *
 * 出口有两条，由 `egress()` 选：**直连优先，浏览器桥兜底**。
 *
 * 老版本只有桥一条路，理由是「服务器 IP 已被风控，view 接口 -412」。
 * 2026-10-29 实测发现那个结论只对「走桥」成立：桥那边（主人浏览器所在网络）
 * 打 view 一律 412，而**这台服务器直连 view 是 code 0**，推荐流、playurl 全通，
 * 只要补一个 buvid3 cookie（见 bili-direct.js）。所以现在直连是首选，
 * 桥留着是为了直连哪天被风控时还有条退路。
 *
 * 一期只做只读：推荐流、视频详情、评论、搜索。
 * 点赞/投币/发评论等写操作二期再说，且必须过安全闸门。
 */

const WBI_MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 常见接口错误码 → 人话 */
const CODE_HUMAN = {
  0: '成功',
  '-101': '账号未登录',
  '-352': '风控校验失败（签名或 IP 有问题）',
  '-412': '请求被风控拦截',
  '-400': '请求参数错误',
  '-404': '啥都没有',
  '-509': '请求过于频繁',
  '62002': '稿件不可见',
  '62004': '稿件审核中',
  '62012': '仅 UP 主自己可见'
};

/**
 * WBI 签名。
 * @param {object} params 原始查询参数
 * @param {number} imgKey
 * @param {number} subKey
 * @param {number} [nowSec]
 * @returns {object} 带 wts 与 w_rid 的新参数表
 */
export function signWbi(params, imgKey, subKey, nowSec = Math.floor(Date.now() / 1000)) {
  const mixinKey = WBI_MIXIN_TAB
    .map((n) => String(imgKey) + String(subKey).charAt(n))
    .join('')
    .slice(0, 32);

  const withTs = { ...params, wts: nowSec };

  const query = Object.keys(withTs)
    .sort()
    .map((k) => {
      // 官方实现对值里的 !'()* 做了过滤
      const v = String(withTs[k]).replace(/[!'()*]/g, '');
      return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
    })
    .join('&');

  const wRid = md5Hex(query + mixinKey);
  return { ...withTs, w_rid: wRid };
}

/** 从 wbi_img 的 URL 里抠出 key（文件名去掉扩展名）。 */
export function keyFromUrl(u) {
  const m = /\/([0-9a-f]{32})\.png/i.exec(String(u ?? ''));
  return m ? m[1] : '';
}

// ── 一个极简 md5（不引依赖，bridge.js 是零外部依赖风格） ──
export function md5Hex(input) {
  return md5Bytes(new TextEncoder().encode(input));
}

function md5Bytes(bytes) {
  const K = new Int32Array(64);
  for (let i = 0; i < 64; i += 1) K[i] = (Math.abs(Math.sin(i + 1)) * 0x100000000) | 0;

  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  const ml = bytes.length;
  const withPad = new Uint8Array((((ml + 8) >>> 6) + 1) << 6);
  withPad.set(bytes);
  withPad[ml] = 0x80;
  const bitLen = ml * 8;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 0x100000000), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;

  const M = new Int32Array(16);
  for (let off = 0; off < withPad.length; off += 64) {
    for (let i = 0; i < 16; i += 1) M[i] = dv.getInt32(off + i * 4, true);

    let A = a0; let B = b0; let C = c0; let D = d0;
    for (let i = 0; i < 64; i += 1) {
      let F;
      let g;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) & 15; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) & 15; }
      else { F = C ^ (B | ~D); g = (7 * i) & 15; }
      F = (F + A + K[i] + M[g]) | 0;
      A = D;
      D = C;
      C = B;
      const sh = S[i];
      B = (B + ((F << sh) | (F >>> (32 - sh)))) | 0;
    }
    a0 = (a0 + A) | 0;
    b0 = (b0 + B) | 0;
    c0 = (c0 + C) | 0;
    d0 = (d0 + D) | 0;
  }

  const out = new Uint8Array(16);
  const odv = new DataView(out.buffer);
  odv.setInt32(0, a0, true);
  odv.setInt32(4, b0, true);
  odv.setInt32(8, c0, true);
  odv.setInt32(12, d0, true);
  return Array.from(out).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class BiliClient {
  /**
   * @param {object} opts
   * @param {{request: Function}} [opts.phone] 浏览器桥（兜底出口）
   * @param {{request: Function}} [opts.direct] 直连出口（首选，见 bili-direct.js）
   * @param {Function} [opts.log]
   * @param {Function} [opts.now]
   */
  constructor(opts = {}) {
    this.phone = opts.phone;
    this.direct = opts.direct;
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    this.wbiKeys = null;
    this.wbiAt = 0;
  }

  /**
   * 选出口。
   *
   * 直连优先是 2026-10-29 实测的结论：同一台机器上，直连能拿到 view 的 cid、
   * 推荐流、playurl，而走桥连 view 都是 412。桥只在直连不可用时才顶上。
   *
   * @returns {null | {via: {request: Function}, kind: 'direct'|'bridge'}}
   */
  egress() {
    if (this.direct && typeof this.direct.request === 'function') {
      return { via: this.direct, kind: 'direct' };
    }
    if (this.phone && typeof this.phone.request === 'function') {
      return { via: this.phone, kind: 'bridge' };
    }
    return null;
  }

  /**
   * 取 WBI key（缓存 1 小时）。
   *
   * 注意：未登录时 nav 返回 `code: -101 账号未登录`，但 **data.wbi_img 照样给了**。
   * 所以这里必须走 lenient 路径 —— 用严格模式会把「未登录」当成「拿不到 key」，
   * 连带推荐流、搜索全部失败（2026-10-23 实测踩过）。
   */
  async ensureWbi() {
    const ONE_HOUR = 3600_000;
    if (this.wbiKeys && this.now() - this.wbiAt < ONE_HOUR) return this.wbiKeys;

    const res = await this.raw('/x/web-interface/nav', {}, { lenient: true });
    const img = keyFromUrl(res?.data?.wbi_img?.img_url);
    const sub = keyFromUrl(res?.data?.wbi_img?.sub_url);
    if (!img || !sub) throw new Error('拿不到 WBI 签名 key（nav 接口没给 wbi_img）');
    this.wbiKeys = { imgKey: img, subKey: sub };
    this.wbiAt = this.now();
    return this.wbiKeys;
  }

  /**
   * 发请求并解析 JSON。会被风控的情况给出人话。
   * @param {object} [opts]
   * @param {boolean} [opts.lenient] true 时容忍非 0 的 bili code（只用于取 WBI key 这类
   *   「报了错但数据照样给」的接口），仍然对 412 / 非 JSON 报错。
   */
  async raw(path, params = {}, opts = {}) {
    // 早报错：两条出口都没有就等于没有网络，别等到 `.request of undefined` 这种
    // 看不出所以然的错（2026-10-23 端到端验证时踩过）。
    const gate = this.egress();
    if (!gate) {
      throw new Error('B 站请求发不出去：直连出口（bili-direct）和浏览器桥都没配。'
        + '检查 createBiliDirect() 有没有注入，或者访问 /api/phone/status 看扩展在不在线。');
    }
    const url = new URL(path.startsWith('http') ? path : `https://api.bilibili.com${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const res = await gate.via.request({
      url: url.toString(),
      headers: {
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://www.bilibili.com/',
        'origin': 'https://www.bilibili.com',
        'user-agent': UA
      }
    });

    if (res.status === 412) throw new Error('B 站风控拦截了这个请求（HTTP 412）');
    if (!res.body) throw new Error(`空响应（HTTP ${res.status}）`);

    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      // 被重定向成 HTML 页面是风控的典型表现
      const isHtml = /^\s*<(!doctype|html)/i.test(res.body);
      throw new Error(isHtml
        ? `B 站返回了网页而不是数据（HTTP ${res.status}），说明被风控了`
        : `返回的不是 JSON（HTTP ${res.status}）：${res.body.slice(0, 120)}`);
    }

    if (json.code !== 0 && !opts.lenient) {
      const human = CODE_HUMAN[String(json.code)] ?? json.message ?? '未知错误';
      const err = new Error(`B 站接口报错 ${json.code}：${human}`);
      err.biliCode = json.code;
      throw err;
    }
    return json;
  }

  /** 带 WBI 签名的请求。 */
  async signed(path, params = {}) {
    const { imgKey, subKey } = await this.ensureWbi();
    const signedParams = signWbi(params, imgKey, subKey, Math.floor(this.now() / 1000));
    return this.raw(path, signedParams);
  }

  // ───────────────────────── 只读接口 ─────────────────────────

  /** 首页推荐流。 */
  async recommend(ps = 10) {
    const json = await this.signed('/x/web-interface/wbi/index/top/feed/rcmd', {
      ps: Math.min(30, Math.max(1, ps)),
      fresh_type: 3,
      feed_version: 'V8'
    });
    const items = json?.data?.item ?? [];
    return items.map(normalizeVideoCard).filter(Boolean);
  }

  /**
   * 视频详情。
   *
   * **直连时走真 `/x/web-interface/view`，走桥时退回搜索。**
   *
   * 历史：2026-10-23 实测，view 那条路径即使带 WBI 签名、即使是在「扩展所在的网络」里，
   * B 站依然一律回 412（WBI 三个变体 `/x/web-interface/wbi/view`、`/wbi/view/detail`、
   * `/view/detail` 同样 412），所以改走「按 BV 号搜索」绕路 —— 搜索结果是被人肉点过的，
   * 不会被拦。代价是搜索结果**没有 cid**，也没有分P/币/藏。
   *
   * 2026-10-29 实测：这台服务器**直连 view 是 code 0**，aid/cid/duration/videos/desc 全给。
   * cid 是 playurl 的前置（没 cid 取不到流），所以直连可用时必须走真详情。
   *
   * `aid` 一定要拿到：评论接口只认 aid。
   */
  async videoDetail(bvid) {
    const id = String(bvid ?? '').trim();
    if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error(`不是合法的 BV 号：${id}`);

    if (this.egress()?.kind === 'direct') {
      try {
        const json = await this.raw('/x/web-interface/view', { bvid: id });
        const d = json?.data ?? {};
        if (d.bvid) return normalizeDetail({ ...d, bvid: id });
      } catch (error) {
        // 直连突然被风控时别把整个详情功能带死，落回搜索那条老路
        this.log(`[bili] 直连取详情失败，退回搜索：${error?.message ?? error}`);
      }
    }

    const list = await this.search(id, { ps: 10 });
    const hit = list.find((v) => v.bvid === id);
    if (!hit) throw new Error(`没搜到这个视频：${id}（可能是私密/已删除，或者标题里没出现 BV 号）`);
    return normalizeDetail({ ...hit, bvid: id });
  }

  /**
   * 热门评论。
   *
   * `/x/v2/reply` 走**签名版**是 2026-10-23 实测出来的：不带 WBI 时这条路径
   * 会被重定向成 HTML，带上 WBI 签名才 code 0。别改回 `this.raw`。
   */
  async comments(aid, { ps = 10, sort = 2 } = {}) {
    const oid = Number(aid);
    if (!Number.isFinite(oid) || oid <= 0) throw new Error(`aid 不合法：${aid}`);
    const json = await this.signed('/x/v2/reply', {
      type: 1,
      oid,
      ps: Math.min(20, Math.max(1, ps)),
      sort, // 2 = 热度
      pn: 1
    });
    const replies = json?.data?.replies ?? [];
    return replies.map((r) => ({
      user: r?.member?.uname ?? '',
      text: String(r?.content?.message ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
      likes: Number(r?.like ?? 0),
      replies: Number(r?.rcount ?? 0)
    }));
  }

  /** 搜索。 */
  async search(keyword, { page = 1, ps = 10 } = {}) {
    const word = String(keyword ?? '').trim();
    if (!word) throw new Error('搜索词不能为空');
    const json = await this.signed('/x/web-interface/wbi/search/type', {
      search_type: 'video',
      keyword: word.slice(0, 100),
      page: Math.min(50, Math.max(1, page)),
      page_size: Math.min(30, Math.max(1, ps))
    });
    const items = json?.data?.result ?? [];
    return items.filter((x) => x?.bvid).map((x) => ({
      bvid: x.bvid,
      // aid 必须留着：评论接口只认它（2026-10-23 加）
      aid: Number(x.aid ?? x.id ?? 0),
      title: stripTags(x.title),
      author: String(x.author ?? ''),
      mid: Number(x.mid ?? 0),
      play: Number(x.play ?? 0),
      like: Number(x.like ?? 0),
      danmaku: Number(x.video_review ?? 0),
      // 搜索结果里的时长是 "12:34" 字符串，详情那边要的是秒数——这里顺手换掉
      duration: parseDurationText(x.duration),
      pubdate: Number(x.pubdate ?? 0),
      description: stripTags(x.description ?? '').slice(0, 160)
    }));
  }
}

// ───────────────────────── 整理成人话 ─────────────────────────

function stripTags(s) {
  return String(s ?? '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 把 B 站那种 "12:34" / "1:02:03" 的时长文本换成秒数。
 * 数字原样透传，认不出来的给 0（宁给 0 也不给 NaN）。
 */
function parseDurationText(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  const s = String(v ?? '').trim();
  if (!s) return 0;
  const parts = s.split(':').map((x) => Number(x));
  if (parts.some((n) => !Number.isFinite(n))) return 0;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function normalizeVideoCard(it) {
  if (!it) return null;
  if (it.goto !== 'av' || !it.bvid) return null; // 只留视频，广告/直播先跳过
  return {
    bvid: it.bvid,
    aid: it.id,
    cid: it.cid,
    title: stripTags(it.title),
    author: String(it.owner?.name ?? ''),
    mid: Number(it.owner?.mid ?? 0),
    duration: Number(it.duration ?? 0),
    pubdate: Number(it.pubdate ?? 0),
    desc: stripTags(it.desc ?? '').slice(0, 200),
    view: Number(it.stat?.view ?? 0),
    like: Number(it.stat?.like ?? 0),
    danmaku: Number(it.stat?.danmaku ?? 0),
    reason: String(it.rcmd_reason?.content ?? '') || stripTags(it.reason ?? '')
  };
}

/**
 * 统一成「详情」的形状。
 *
 * 输入可能来自两个地方：老的真详情接口 `/x/web-interface/view`（`owner.name`、
 * `stat.view`、`desc`），或者 2026-10-23 改用的搜索结果（`author`、`play`、
 * `like`、`description`）。两边字段名不一样，这里都认，缺的给 0/空串。
 */
function normalizeDetail(d) {
  const v = d ?? {};
  return {
    bvid: v.bvid,
    aid: Number(v.aid ?? 0),
    cid: Number(v.cid ?? 0),
    title: stripTags(v.title),
    author: String(v.owner?.name ?? v.author ?? ''),
    mid: Number(v.owner?.mid ?? v.mid ?? 0),
    desc: String(v.desc ?? v.description ?? '').trim().slice(0, 2000),
    duration: parseDurationText(v.duration),
    pubdate: Number(v.pubdate ?? 0),
    view: Number(v.stat?.view ?? v.view ?? v.play ?? 0),
    like: Number(v.stat?.like ?? v.like ?? 0),
    coin: Number(v.stat?.coin ?? 0),
    favorite: Number(v.stat?.favorite ?? 0),
    share: Number(v.stat?.share ?? 0),
    danmaku: Number(v.stat?.danmaku ?? v.danmaku ?? 0),
    reply: Number(v.stat?.reply ?? 0),
    tname: String(v.tname ?? ''),
    copyright: Number(v.copyright ?? 0) === 2 ? '转载' : '自制',
    // 分P 只给个数，不铺开
    pageCount: Array.isArray(v.pages) ? v.pages.length : 1
  };
}

/** 时长秒 → 12:34 / 1:02:03 */
export function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
}

/** 播放量 → 1.2万 / 3.4亿 */
export function fmtCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e8) return `${(v / 1e8).toFixed(1)}亿`;
  if (v >= 1e4) return `${(v / 1e4).toFixed(1)}万`;
  return String(v);
}

/** 时间戳 → 「3 小时前」 */
export function fmtAgo(sec, nowMs = Date.now()) {
  const t = Number(sec) || 0;
  if (!t) return '';
  const diff = Math.max(0, Math.floor(nowMs / 1000 - t));
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${Math.floor(diff / (86400 * 365))} 年前`;
}

// ───────────────────────── 给人看的文本（端点 / 工具共用） ─────────────────────────
//
// 为什么不直接在 MCP 工具里拼：同一段话可能既出现在工具返回里、又出现在
// 「浏览器桥离线」的提示里；两处各写一份必然漂移。这里出唯一版本。

/** 一条推荐流的卡 → 两三行话 */
function cardToText(v) {
  const bits = [];
  if (v.author) bits.push(`up：${v.author}`);
  if (v.view) bits.push(`${fmtCount(v.view)}播放`);
  if (v.duration) bits.push(fmtDuration(v.duration));
  if (v.pubdate) bits.push(fmtAgo(v.pubdate));
  const head = `「${v.title}」`;
  const meta = bits.length ? `（${bits.join(' · ')}）` : '';
  const why = v.reason ? `\n    ${v.reason}` : '';
  return `${head}${meta}${why}\n    ${v.bvid}`;
}

/**
 * 把一次 B 站只读查询变成一段人话。
 * @param {string} action recommend / video / comments / search
 * @param {any} data 对应 client 方法的返回值（search 传 {list, keyword}）
 * @returns {string}
 */
export function describeBiliResult(action, data) {
  if (action === 'recommend') {
    const list = Array.isArray(data) ? data : [];
    if (!list.length) return '推荐流这次是空的（可能被风控降级了），过一会儿再试。';
    return `首页推荐 ${list.length} 条：\n\n` + list.map((v, i) => `${i + 1}. ${cardToText(v)}`).join('\n\n');
  }

  if (action === 'search') {
    const list = Array.isArray(data?.list) ? data.list : [];
    const kw = data?.keyword ?? '';
    if (!list.length) return `搜「${kw}」没有结果（可能是词太冷门，或者被风控降级了）。`;
    const rows = list.map((v, i) => {
      const bits = [];
      if (v.author) bits.push(`up：${v.author}`);
      if (v.play) bits.push(`${fmtCount(v.play)}播放`);
      if (v.duration) bits.push(v.duration);
      if (v.pubdate) bits.push(fmtAgo(v.pubdate));
      return `${i + 1}. 「${v.title}」${bits.length ? `（${bits.join(' · ')}）` : ''}\n    ${v.bvid}`;
    });
    return `搜「${kw}」找到 ${list.length} 条：\n\n` + rows.join('\n');
  }

  if (action === 'video') {
    const v = data ?? {};
    const rows = [
      `「${v.title}」`,
      `up：${v.author}${v.mid ? `（uid ${v.mid}）` : ''}`,
      `${fmtCount(v.view)}播放 · ${fmtCount(v.danmaku)}弹幕 · ${fmtCount(v.like)}点赞`,
      `时长 ${fmtDuration(v.duration)}${v.pubdate ? ` · ${fmtAgo(v.pubdate)}` : ''}`,
      `编号 ${v.bvid}${v.aid ? ` / aid ${v.aid}` : ''}`
    ];
    if (v.desc) rows.push('', `简介：${v.desc.slice(0, 300)}`);
    return rows.join('\n');
  }

  if (action === 'comments') {
    const list = Array.isArray(data) ? data : [];
    if (!list.length) return '这条视频还没有评论（或者评论接口被风控降级了）。';
    return `${list.length} 条热门评论：\n\n` + list.map((c, i) =>
      `${i + 1}. ${c.user}：${c.text}${c.likes ? `（${fmtCount(c.likes)}赞）` : ''}`
    ).join('\n\n');
  }

  return '不认识的查询类型。';
}

/**
 * 两条出口都不通时给模型看的话（别让它以为是 B 站挂了）。
 *
 * 注意：老文案说「IP 被拉黑」是错的 —— 2026-10-29 实测直连 view/推荐流/playurl 全通，
 * 缺的只有 buvid3。所以现在只有「直连也失败」才会走到这句。
 */
export function describePhoneOffline() {
  return 'B 站现在两条路都不通：直连（buvid3 + WBI）和浏览器桥都没成功。'
    + '先跟主人说一句「我这边现在够不到 B 站」，别反复重试。'
    + '如果只是浏览器扩展没开，直连本来应该也能用 —— 那说明是 B 站风控或者这台机器的网络出了问题。';
}

