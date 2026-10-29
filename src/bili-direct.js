/**
 * B 站直连客户端 —— bili-direct.js
 *
 * 为什么需要它：site-bili.js 的 BiliClient 原本硬依赖 phoneBridge（浏览器桥），
 * 桥一离线整个 B 站功能就一句都发不出去，日志里躺着一排
 * 「[phone] 浏览器扩展离线：站点请求（B站/小黑盒）暂时发不出去」。
 *
 * 2026-10-29 实测推翻了那个前提 —— **这台服务器直连 B 站完全可行**，
 * 缺的只是 buvid3 cookie（WBI 签名早就实现好了）。实测链路：
 *
 *   /x/frontend/finger/spi        → 200 code 0，拿到 b_3/b_4
 *   /x/web-interface/nav          → 200 code -101（未登录），但 wbi_img 照样给
 *   /x/web-interface/wbi/index/top/feed/rcmd → 200 code 0，8 条推荐
 *   /x/web-interface/view?bvid=   → 200 code 0，拿到 cid（playurl 必需）
 *   /x/player/wbi/playurl         → 200 code 0，DASH 4 档视频流
 *   upos CDN 带 Referer 下载      → 206，3MB/156ms
 *
 * 所以旧的「服务器 IP 被 B 站拉黑（-412）」说的是**走浏览器桥时扩展所在网络**
 * 的表现，不是这台机器的。直连反而比走桥更能拿到东西（view 接口桥那边一律 412）。
 *
 * 设计上只暴露一个和 phoneBridge 同形状的 `request({url, headers})` → `{status, body}`，
 * 这样 BiliClient.raw() 一行都不用改就能换出口。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** 实测能过的 UA。别换成 node 默认的 undici —— 那个连 nav 都不给 wbi_img。 */
export const DIRECT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** buvid3 缓存多久。B 站不要求登录，但同一台机频繁换 buvid 容易被记成可疑设备。 */
const COOKIE_TTL_MS = 12 * 3600_000;

/** 单次接口请求超时。 */
const REQUEST_TIMEOUT_MS = 15000;

/**
 * 从 playurl 的 dash 里挑一档视频流。
 *
 * 抽帧只需要「能看清画面」——360p/480p 足够，再高就是白花流量和解码时间
 * （实测 640x360 的 8 分 57 秒视频 17.5MB，抽出来的拼图字都能看清）。
 *
 * 编码优先 avc1（H.264）：兼容性最好、ffmpeg 解最快。没有 avc1 才退到 hvc1，
 * 实测本机 ffmpeg 4.4.2 解 hvc1 也正常。
 *
 * @param {object} dash playurl 返回的 data.dash
 * @param {{maxBandwidth?: number}} [opts]
 * @returns {null | {url: string, width: number, height: number, bandwidth: number, codecs: string, qualityId: number, codec: 'avc1'|'hvc1'|'other'}}
 */
export function pickVideoStream(dash, opts = {}) {
  const maxBandwidth = Number(opts.maxBandwidth) || 900_000;
  const list = Array.isArray(dash?.video) ? dash.video : [];
  const usable = list.filter((v) => v && (v.baseUrl || v.base_url));
  if (!usable.length) return null;

  const codecOf = (v) => {
    const c = String(v.codecs ?? v.codecs ?? '');
    if (c.startsWith('avc1')) return 'avc1';
    if (c.startsWith('hvc1') || c.startsWith('hev1')) return 'hvc1';
    return 'other';
  };
  const rank = { avc1: 0, hvc1: 1, other: 2 };

  // 先按编码分组（avc1 → hvc1 → other），组内再按码率升序
  const sorted = [...usable].sort((a, b) => {
    const d = rank[codecOf(a)] - rank[codecOf(b)];
    if (d) return d;
    return (Number(a.bandwidth) || 0) - (Number(b.bandwidth) || 0);
  });

  // 在首选编码里找「不超上限的最大一档」；都超就退到最小的一档
  const bestCodec = codecOf(sorted[0]);
  const group = sorted.filter((v) => codecOf(v) === bestCodec);
  const within = group.filter((v) => (Number(v.bandwidth) || 0) <= maxBandwidth);
  const chosen = within.length ? within[within.length - 1] : group[0];

  return {
    url: String(chosen.baseUrl ?? chosen.base_url),
    width: Number(chosen.width ?? 0),
    height: Number(chosen.height ?? 0),
    bandwidth: Number(chosen.bandwidth ?? 0),
    codecs: String(chosen.codecs ?? ''),
    qualityId: Number(chosen.id ?? 0),
    codec: codecOf(chosen)
  };
}

/** 挑流结果 → 一句人话（写日志用）。 */
export function describeStream(s) {
  if (!s) return '没有可用的视频流';
  const mb = s.bandwidth ? `${(s.bandwidth / 8 / 1000).toFixed(0)}KB/s` : '码率未知';
  return `${s.width}x${s.height} ${s.codec} ${mb}`;
}

/**
 * 造一个走直连的 B 站出口。
 *
 * 返回的对象形状刻意对齐 phoneBridge：只要 `.request({url, headers})` → `{status, body}`，
 * 所以能直接被 BiliClient 当成 phone 用（见 site-bili.js 的 raw）。
 *
 * @param {object} [opts]
 * @param {string} [opts.stateFile] buvid3 缓存文件路径（默认 <cwd>/state/bili-cookie.json）
 * @param {Function} [opts.log]
 * @param {Function} [opts.now]
 * @param {Function} [opts.fetchImpl] 注入 fetch（测试用）
 */
export function createBiliDirect(opts = {}) {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const stateFile = opts.stateFile ?? path.join(process.cwd(), 'state', 'bili-cookie.json');

  let cookie = null; // { buvid3, buvid4, at }
  let pending = null; // 并发去重：同时在跑的 ensureCookie 只发一次请求
  let lastError = '';

  async function readCache() {
    try {
      const raw = await fs.readFile(stateFile, 'utf8');
      const j = JSON.parse(raw);
      if (j && j.buvid3) return { buvid3: String(j.buvid3), buvid4: String(j.buvid4 ?? ''), at: Number(j.at) || 0 };
    } catch {
      // 没有缓存是正常起点，不报错
    }
    return null;
  }

  async function writeCache(c) {
    try {
      await fs.mkdir(path.dirname(stateFile), { recursive: true });
      await fs.writeFile(stateFile, JSON.stringify(c, null, 2), 'utf8');
    } catch (error) {
      // 写不进去不影响功能，下次重新申请就是了
      log(`[bili-direct] 缓存 buvid3 失败（不影响使用）：${error?.message ?? error}`);
    }
  }

  async function fetchCookie() {
    const r = await fetchImpl('https://api.bilibili.com/x/frontend/finger/spi', {
      headers: {
        'user-agent': DIRECT_UA,
        'accept': 'application/json, text/plain, */*',
        'referer': 'https://www.bilibili.com/'
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (r.status !== 200) throw new Error(`拿 buvid3 失败（HTTP ${r.status}）`);
    const j = await r.json();
    const buvid3 = j?.data?.b_3;
    if (!buvid3) throw new Error('拿 buvid3 失败（响应里没有 b_3）');
    const c = { buvid3: String(buvid3), buvid4: String(j?.data?.b_4 ?? ''), at: now() };
    await writeCache(c);
    log(`[bili-direct] 拿到新的 buvid3 ${String(buvid3).slice(0, 8)}…`);
    return c;
  }

  /** 取 cookie；缓存过期或没缓存就重新申请。并发的调用共享同一个请求。 */
  async function ensureCookie(force = false) {
    if (!force) {
      if (cookie && now() - cookie.at < COOKIE_TTL_MS) return cookie;
      if (!cookie) {
        const cached = await readCache();
        if (cached && now() - cached.at < COOKIE_TTL_MS) {
          cookie = cached;
          return cookie;
        }
      }
    }
    if (pending) return pending;
    pending = (async () => {
      try {
        cookie = await fetchCookie();
        lastError = '';
        return cookie;
      } catch (error) {
        lastError = error?.message ?? String(error);
        // 申请失败但手上有旧 cookie 时，先用旧的顶着
        if (cookie) return cookie;
        throw error;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  /**
   * 对齐 phoneBridge 的接口。
   *
   * 注意 `accept` 之类头会被 BiliClient 传进来覆盖默认值；
   * **cookie 不允许被覆盖**——那是直连能不能通的关键。
   */
  async function request(req = {}) {
    const { url, headers = {} } = req;
    if (!url) throw new Error('request 缺少 url');
    const c = await ensureCookie();
    const merged = {
      'user-agent': DIRECT_UA,
      'accept': 'application/json, text/plain, */*',
      'referer': 'https://www.bilibili.com/',
      'origin': 'https://www.bilibili.com',
      ...headers,
      'user-agent': headers['user-agent'] || DIRECT_UA,
      cookie: `buvid3=${c.buvid3}; buvid4=${c.buvid4}`
    };
    const r = await fetchImpl(url, {
      headers: merged,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    const body = await r.text();
    return { status: r.status, body };
  }

  /**
   * 取播放地址。必须带 cid —— 这个只有 `/x/web-interface/view` 给，
   * 而 BiliClient 老版本走搜索绕路是拿不到 cid 的（所以看画面要先修详情）。
   *
   * @param {string} bvid
   * @param {number} cid
   * @param {{qn?: number}} [opts]
   */
  async function playurl(bvid, cid, opts = {}) {
    const { signWbi, keyFromUrl } = await import('./site-bili.js');
    const keys = await wbiKeys();
    const params = signWbi(
      { bvid, cid, qn: Number(opts.qn) || 32, fnval: 16, fourk: 0 },
      keys.imgKey,
      keys.subKey
    );
    const url = `https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(params)}`;
    const res = await request({ url });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`playurl 返回的不是 JSON（HTTP ${res.status}）：${res.body.slice(0, 160)}`);
    }
    if (json?.code !== 0) {
      throw new Error(`playurl 报错 ${json?.code}：${json?.message ?? '未知'}`);
    }
    void keyFromUrl;
    return json.data ?? {};
  }

  /** WBI key（缓存 1 小时）。nav 未登录也照样给 wbi_img，所以不要求 cookie 带登录态。 */
  let wbiCache = null;
  async function wbiKeys() {
    if (wbiCache && now() - wbiCache.at < 3600_000) return wbiCache;
    const { keyFromUrl } = await import('./site-bili.js');
    const res = await request({ url: 'https://api.bilibili.com/x/web-interface/nav' });
    let json;
    try {
      json = JSON.parse(res.body);
    } catch {
      throw new Error(`nav 返回的不是 JSON（HTTP ${res.status}）`);
    }
    const imgKey = keyFromUrl(json?.data?.wbi_img?.img_url);
    const subKey = keyFromUrl(json?.data?.wbi_img?.sub_url);
    if (!imgKey || !subKey) throw new Error('nav 没给 wbi_img，拿不到签名 key');
    wbiCache = { imgKey, subKey, at: now() };
    return wbiCache;
  }

  /**
   * 下载一段字节。走 CDN 必须带 Referer，否则 403。
   * @param {string} url
   * @param {{maxBytes?: number, timeoutMs?: number}} [opts]
   */
  async function download(url, opts = {}) {
    const maxBytes = Number(opts.maxBytes) || 64 * 1024 * 1024;
    const timeoutMs = Number(opts.timeoutMs) || 60000;
    const r = await fetchImpl(url, {
      headers: {
        'user-agent': DIRECT_UA,
        'referer': 'https://www.bilibili.com/',
        'origin': 'https://www.bilibili.com',
        'accept': '*/*',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (r.status !== 200 && r.status !== 206) {
      throw new Error(`下载视频流失败（HTTP ${r.status}）`);
    }
    const declared = Number(r.headers.get('content-length') ?? 0);
    if (declared && declared > maxBytes) {
      throw new Error(`视频流有 ${(declared / 1048576).toFixed(1)}MB，超过上限 ${(maxBytes / 1048576).toFixed(0)}MB`);
    }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) {
      throw new Error(`视频流下载后 ${(buf.length / 1048576).toFixed(1)}MB，超过上限`);
    }
    if (!buf.length) throw new Error('视频流是空的');
    return buf;
  }

  return {
    request,
    playurl,
    download,
    wbiKeys,
    ensureCookie,
    /** 能不能用（申请过一次 cookie 没炸就算能） */
    available: () => Boolean(cookie) || !lastError,
    lastError: () => lastError,
    stateFile
  };
}
