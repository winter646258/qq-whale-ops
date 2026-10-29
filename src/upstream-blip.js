// MARKER: upstream-blip
// 上游网关的「偶发抖一下」和「真坏了」，在日志里长得几乎一样 —— 都是一句 error。
// 但对人的意义完全不同：前者六秒后自愈，主人不该为它被叫醒；后者要人管。
//
// 实测 2026-10-29 11:27:15 与 11:27:21：Cloudflare 在 ai.windking.shop 前面回了两张
// HTML 502 页（DSH 的 provider 插件把它转成
// 「the gateway's front proxy answered HTTP 502 with an HTML error page…」），
// 6 秒后自己好了 —— 11:28:23 的唤醒一次成功。
// 那两条例行通知都发到了主人私聊，除了打扰没有别的用处。
//
// 所以这里只做一件小事：把「同一类上游抖动」在时间窗内折叠成一条。
// 不重试、不改消息流 —— 重试要判断「这一轮到底发出去几条」，
// 判断错了就是重复发言，比漏一条回复更难看。

/**
 * 上游抖动 / 网关在前面挡了一下 —— 值得折叠的特征。
 *
 * 这里刻意只收「连接层与网关层」的说法：4xx、额度、地区限制、签名被改
 * 都属于真问题，必须一条一条报给主人看。
 */
const BLIP_PATTERNS = [
  /front proxy answered HTTP\s+5\d\d/i,
  /front proxy answered HTTP\s+\d+\s+with an HTML error page/i,
  /answered HTTP\s+52[0-9]\b/i,
  // 有的路径只留一句简短说法（没有 "answered" 前缀），也得认
  /HTTP\s+52[0-9]\s+with an HTML error page/i,
  /Service temporarily unavailable/i,
  /upstream returned no body/i,
  /^terminated$/i,
  /socket hang up/i,
  /ECONNRESET/,
  /other side closed/i,
];

/**
 * @param {unknown} message
 * @returns {boolean} 是否属于「上游抖了一下」这一类
 */
export function isUpstreamBlip(message) {
  const text = String(message ?? '').trim();
  if (!text) return false;
  return BLIP_PATTERNS.some((re) => re.test(text));
}

export const BLIP_DEFAULTS = Object.freeze({
  enabled: true,
  // 窗口多长之内算「同一段抖动」
  quietMs: 30 * 60 * 1000,
  // 窗口内到第几次就发一条汇总（不然真坏掉的时候主人一直收不到）
  escalateAt: 3,
  // 记多少个 key 的账，防内存无界
  maxKeys: 64,
});

/**
 * 折叠器：一个进程内共享一份就够。
 *
 * 语义（窗口从第一条抖动开始算，过期自动重开）：
 * - 不是抖动 → 永远 notify（这是真问题，一条都不能少）
 * - 窗口内第 1 次 → notify（他要知情）
 * - 第 2 次 → 静默（同一个毛病的回声）
 * - 第 3 次 → notify，并带上「30 分钟内第 3 次」（升级成「它在持续」）
 * - 第 4 次起 → 静默（已经提醒过在持续，别再刷）
 */
export function createBlipTracker(options = {}) {
  const cfg = { ...BLIP_DEFAULTS, ...options };
  const seen = new Map(); // key -> { count, firstAt, lastAt, escalated }

  function trim() {
    if (seen.size <= cfg.maxKeys) return;
    // 丢最久没动的那些
    const ordered = [...seen.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0));
    for (const [k] of ordered.slice(0, Math.max(0, seen.size - cfg.maxKeys))) seen.delete(k);
  }

  return {
    /**
     * @param {string} key 会话键
     * @param {string} message 错误文案
     * @param {number} now
     * @returns {{blip:boolean, notify:boolean, count:number, escalate:boolean, quietMin:number}}
     */
    hit(key, message, now = Date.now()) {
      const quietMin = Math.round(cfg.quietMs / 60000);
      const blip = cfg.enabled && isUpstreamBlip(message);
      if (!blip) return { blip: false, notify: true, count: 0, escalate: false, quietMin };

      const id = String(key ?? '');
      let rec = seen.get(id);
      if (!rec || now - rec.firstAt > cfg.quietMs) {
        rec = { count: 0, firstAt: now, lastAt: now, escalated: false };
        seen.set(id, rec);
        trim();
      }
      rec.count += 1;
      rec.lastAt = now;

      if (rec.count === 1) return { blip: true, notify: true, count: 1, escalate: false, quietMin };
      if (rec.count >= cfg.escalateAt && !rec.escalated) {
        rec.escalated = true;
        return { blip: true, notify: true, count: rec.count, escalate: true, quietMin };
      }
      return { blip: true, notify: false, count: rec.count, escalate: false, quietMin };
    },

    /** 测试与排障用：看某个 key 现在的账 */
    peek(key) {
      const rec = seen.get(String(key ?? ''));
      return rec ? { ...rec } : null;
    },

    reset() {
      seen.clear();
    },
  };
}
