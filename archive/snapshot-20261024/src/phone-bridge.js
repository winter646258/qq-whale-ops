/**
 * 浏览器桥（服务器侧）—— phone-bridge.js
 *
 * 为什么需要它：服务器上的阿里云 IP 已经被 B 站拉黑。
 *
 *   2026-10-23 实测（同一组请求，只换出口 IP）：
 *                            阿里云服务器      主人的 Windows
 *     nav                    200              200
 *     x/web-interface/view   -412 banned      200
 *     x/v2/reply             重定向成 HTML     200
 *
 * 所以站点请求必须**借浏览器的 IP 发**。这个模块做三件事：
 *   1. 任务队列：服务器把「要请求什么」放进去
 *   2. 长轮询端点：浏览器扩展来领任务、回传响应
 *   3. 在线判定：扩展 60 秒没来轮询就算离线
 *
 * 设计上刻意**不接收、不转发、不存储任何 Cookie**：
 * 扩展发回来的只有「服务器指定 URL 的响应体」。登录态始终在主人的浏览器里，
 * 服务器从数据结构上就拿不到它 —— 不是靠约定，是靠字段不存在。
 */

const MAX_PENDING = 8;               // 排队 + 在途的总上限，防止浏览器失联后无限堆积
const TASK_TIMEOUT_MS = 30_000;      // 单个请求从入队到超时（覆盖排队 + 执行两段）
const EXTENSION_OFFLINE_MS = 60_000; // 扩展多久没轮询算离线
const MAX_RESULT_BYTES = 2 * 1024 * 1024;
const POLL_WAIT_MS = 20_000;         // 长轮询挂起时长

/** 允许浏览器访问的站点（白名单，写死不放开）。 */
const ALLOWED_ORIGINS = [
  'https://api.bilibili.com',
  'https://www.bilibili.com',
  'https://api.xiaoheihe.cn',
  'https://www.xiaoheihe.cn'
];

/**
 * 白名单请求头。**故意不含 Cookie / Authorization** ——
 * 就算上层传了，这里也会过滤掉，让「服务器不留 Cookie」成为结构保证而非口头约定。
 */
const HEADER_ALLOW = new Set([
  'accept',
  'accept-language',
  'content-type',
  'referer',
  'origin',
  'user-agent',
  'x-requested-with'
]);

function sanitizeHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h)) {
    const key = String(k).toLowerCase();
    if (!HEADER_ALLOW.has(key)) continue;
    if (typeof v !== 'string') continue;
    out[key] = v.slice(0, 1000);
  }
  return out;
}

function shortUrl(u) {
  try {
    const x = new URL(u);
    return `${x.host}${x.pathname}`.slice(0, 80);
  } catch {
    return String(u).slice(0, 80);
  }
}

export class PhoneBridge {
  /**
   * @param {object} opts
   * @param {Function} [opts.log] 日志函数
   * @param {Function} [opts.now] 时间源（测试注入）
   */
  constructor(opts = {}) {
    this.log = opts.log ?? (() => {});
    this.now = opts.now ?? (() => Date.now());
    /** 还没被领走的：id -> {id,url,method,headers,body,createdAt,timer,resolve,reject} */
    this.pending = new Map();
    /** 已交给扩展、等回包的：id -> {id,url,createdAt,timer,resolve,reject} */
    this.inflight = new Map();
    /** 挂起中的长轮询者 */
    this.waiters = [];
    this.seq = 0;
    this.lastPollAt = 0;
    this.lastResultAt = 0;
    this.stats = { enqueued: 0, completed: 0, timedOut: 0, rejected: 0, dropped: 0 };
  }

  /** 扩展是否在线（60 秒内有轮询）。 */
  isOnline() {
    if (!this.lastPollAt) return false;
    return this.now() - this.lastPollAt < EXTENSION_OFFLINE_MS;
  }

  /** URL 是否在白名单里（只放 https + 精确 origin）。 */
  static isAllowedUrl(raw) {
    try {
      const u = new URL(raw);
      if (u.protocol !== 'https:') return false;
      return ALLOWED_ORIGINS.includes(u.origin);
    } catch {
      return false;
    }
  }

  /**
   * 入队一个请求，返回 promise，由扩展执行后 resolve。
   * @param {{url: string, method?: string, headers?: object, body?: string}} req
   * @returns {Promise<{status: number, body: string, headers: object}>}
   */
  request(req) {
    const url = String(req?.url ?? '');
    if (!PhoneBridge.isAllowedUrl(url)) {
      return Promise.reject(new Error(`不在允许的站点范围内：${url}`));
    }
    const method = String(req?.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') {
      return Promise.reject(new Error(`只允许 GET/POST，收到 ${method}`));
    }
    if (this.pending.size + this.inflight.size >= MAX_PENDING) {
      this.stats.dropped += 1;
      return Promise.reject(new Error(`浏览器桥队列已满（${this.pending.size + this.inflight.size}），稍后再试`));
    }

    const id = `ph${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const task = {
      id,
      url,
      method,
      headers: sanitizeHeaders(req?.headers),
      body: typeof req?.body === 'string' ? req.body : undefined,
      createdAt: this.now()
    };

    const promise = new Promise((resolve, reject) => {
      task.resolve = resolve;
      task.reject = reject;
      task.timer = setTimeout(() => {
        const wasPending = this.pending.delete(id);
        const wasInflight = this.inflight.delete(id);
        if (!wasPending && !wasInflight) return;
        this.stats.timedOut += 1;
        this.log(`[phone] 任务超时 ${id}：${shortUrl(url)}`);
        reject(new Error('浏览器没在 30 秒内完成这个请求（扩展没开，或站点被风控）'));
      }, TASK_TIMEOUT_MS);
      if (task.timer.unref) task.timer.unref();
    });
    // 避免「promise 已 reject 但调用方没 await」时冒出 unhandledRejection
    promise.catch(() => {});

    this.pending.set(id, task);
    this.stats.enqueued += 1;
    this.#wakeWaiter();
    return promise;
  }

  /** 从 pending 里摘最早的一个并登记进 inflight。空了返回 null。 */
  #takeOldest() {
    let oldest = null;
    for (const t of this.pending.values()) {
      if (!oldest || t.createdAt < oldest.createdAt) oldest = t;
    }
    if (!oldest) return null;
    this.pending.delete(oldest.id);
    this.inflight.set(oldest.id, oldest);
    return {
      id: oldest.id,
      url: oldest.url,
      method: oldest.method,
      headers: oldest.headers,
      body: oldest.body
    };
  }

  /**
   * 扩展来领任务（长轮询）。没有任务就挂起最多 POLL_WAIT_MS 再返回 null。
   * @returns {Promise<{id,url,method,headers,body}|null>}
   */
  async poll() {
    this.lastPollAt = this.now();
    const immediate = this.#takeOldest();
    if (immediate) return immediate;

    return new Promise((resolve) => {
      const waiter = { resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(null); // 超时返回空，扩展立刻发起下一次轮询
      }, POLL_WAIT_MS);
      if (waiter.timer.unref) waiter.timer.unref();
      this.waiters.push(waiter);
    });
  }

  /** 有新任务时叫醒一个挂着的轮询者。 */
  #wakeWaiter() {
    if (this.waiters.length === 0) return;
    const next = this.#takeOldest();
    if (!next) return;
    const waiter = this.waiters.shift();
    clearTimeout(waiter.timer);
    waiter.resolve(next);
  }

  /**
   * 扩展回传结果。
   * @param {{id: string, status?: number, body?: string, headers?: object, error?: string}} result
   */
  submitResult(result) {
    this.lastResultAt = this.now();
    const id = String(result?.id ?? '');
    if (!id) return { ok: false, error: '缺少 id' };

    const entry = this.inflight.get(id);
    if (!entry) {
      // 任务已超时被清掉：扩展那边不知道服务器放弃了，静默丢弃
      this.stats.rejected += 1;
      return { ok: false, error: '任务不存在或已超时' };
    }
    this.inflight.delete(id);
    clearTimeout(entry.timer);
    this.stats.completed += 1;

    if (result?.error) {
      entry.reject(new Error(`浏览器侧失败：${String(result.error).slice(0, 300)}`));
      return { ok: true };
    }

    const body = typeof result?.body === 'string' ? result.body : '';
    if (Buffer.byteLength(body, 'utf8') > MAX_RESULT_BYTES) {
      entry.reject(new Error('回传内容超过 2MB'));
      return { ok: true };
    }

    entry.resolve({
      status: Number(result?.status) || 0,
      body,
      headers: sanitizeHeaders(result?.headers)
    });
    return { ok: true };
  }

  /** 状态快照，给控制台 / 健康检查看。 */
  status() {
    return {
      online: this.isOnline(),
      lastPollAgoMs: this.lastPollAt ? this.now() - this.lastPollAt : null,
      lastResultAgoMs: this.lastResultAt ? this.now() - this.lastResultAt : null,
      pending: this.pending.size,
      inflight: this.inflight.size,
      stats: { ...this.stats }
    };
  }
}
