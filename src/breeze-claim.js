// Breeze Blue 每日 400 credits 签到：观测 + 可选自动领取。
//
// ===== 2026-11-02 实测确认的事实，别再重新猜 =====
// 开发者 API（api.breeze.blue/v1）没有 claim 端点，/v1/*claim* 全部 404。
// 网页 BFF 有（来自 https://breezeblue.ai/app 的 Next.js chunk，claimDailyCredits）：
//   POST https://breezeblue.ai/api/credits/daily-claim   可选 body {reward_tier}
//   GET  https://breezeblue.ai/api/credits/summary
// 认证只认登录 cookie（Firebase 会话，cookie 名 breeze_blue_session）。
// 裸打或带 xi-api-key 都是 401 —— web BFF 不认开发者 key。
//
// GET /api/credits/summary 的真实返回（2026-11-02T07:29 实测，一字不差）：
// {
//   "balance": 2593.3, "granted_total": 2800, "consumed_total": 206.7,
//   "generation_unit_cost": 0, "generations_left": 0,
//   "daily_claim_amount": 400,            // 实际能领多少
//   "daily_claim_discord_amount": 400,    // 绑了 Discord 的额度
//   "daily_claim_standard_amount": 100,   // 没绑的额度
//   "daily_claim_available": false,       // ← 「现在能不能领」就是这个字段
//   "daily_claim_claimed_today": true,    // ← 今天领过没
//   "daily_claim_next_reset_at": "2026-11-02T00:00:00+00:00"  // ← 重置 = UTC 零点 = 北京 08:00
// }
// 账本侧（GET /v1/balance 的 topups）对应条目：
//   {"amount":400,"description":"daily claim credits","created_at":"2026-11-01T10:52:24.510201+00:00"}
//
// ===== 判据分两档，别混用 =====
// 有 cookie：**summary 说了算** —— daily_claim_available 为 true 才领。
//            重置时刻是 UTC 零点（北京 08:00），checkHours 默认 0.5 小时，
//            最多晚半小时领到，不用猜。
// 没 cookie：只能读 balance，用「距上次成功 > alertAfterHours」判断，纯提醒。
//
// 设计纪律：网络调用走注入的 fetchImpl，时间走注入的 now，纯函数不碰 fs。

export const BREEZE_CLAIM_DEFAULTS = {
  enabled: true,
  apiHost: 'https://api.breeze.blue',
  webHost: 'https://breezeblue.ai',
  // 有 cookie 时重置时刻已知（UTC 零点），这个间隔只为「半小时内领到」；
  // 没 cookie 时每半小时一次只读 balance 也几乎零成本（一天 48 个请求）。
  checkHours: 0.5,
  // 没 cookie 时的提醒阈值：距上次成功领取超过这么多小时就提醒。
  alertAfterHours: 20,
  alertCooldownHours: 8,
  quietStart: 23,
  quietEnd: 8,
  timeoutMs: 15000,
  autoClaim: true,
  dailyAmount: 400,
  escalateAfter: 2,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 只接受正数；0 和负数都当「没填」。 */
function positiveNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const s = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(s)) return true;
    if (['0', 'false', 'no', 'off'].includes(s)) return false;
    return fallback;
  }
  return fallback;
}

/** 把配置归一成可用形状。认不出的项一律回落默认值，不抛。 */
export function normalizeClaimCfg(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = BREEZE_CLAIM_DEFAULTS;
  const hour = (v, fb) => {
    const n = num(v, fb);
    return n >= 0 && n <= 24 ? n : fb;
  };
  return {
    enabled: bool(r.enabled, d.enabled),
    apiHost: String(r.apiHost || d.apiHost).replace(/\/+$/, ''),
    webHost: String(r.webHost || d.webHost).replace(/\/+$/, ''),
    checkHours: positiveNum(r.checkHours, d.checkHours),
    alertAfterHours: positiveNum(r.alertAfterHours, d.alertAfterHours),
    alertCooldownHours: Math.max(0, num(r.alertCooldownHours, d.alertCooldownHours)),
    quietStart: hour(r.quietStart, d.quietStart),
    quietEnd: hour(r.quietEnd, d.quietEnd),
    timeoutMs: Math.max(3000, num(r.timeoutMs, d.timeoutMs)),
    autoClaim: bool(r.autoClaim, d.autoClaim),
    dailyAmount: Math.max(0, num(r.dailyAmount, d.dailyAmount)),
    escalateAfter: Math.max(1, num(r.escalateAfter, d.escalateAfter)),
  };
}

/** ISO 时间串 → 毫秒。解析不出来返回 0（调用方必须把 0 当「不知道」）。 */
export function parseIsoMs(value) {
  // 数字入参：<=0 一律当「不知道」。不能往下走 String()，因为 Date.parse("0") = 2000-01-01。
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const s = String(value ?? '').trim();
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/** 从 balance 的 topups 里找最后一次「每日签到」。 */
export function findLastDailyClaim(topups) {
  const list = Array.isArray(topups) ? topups : [];
  let best = null;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const desc = String(item.description ?? item.reason ?? '').toLowerCase();
    if (!/daily[\s_-]*claim/.test(desc)) continue;
    const at = parseIsoMs(item.created_at ?? item.createdAt ?? item.at);
    if (!at) continue;
    const amount = num(item.amount ?? item.credits, 0);
    if (!best || at > best.at) best = { at, amount, description: String(item.description ?? '') };
  }
  return best;
}

/** 一个时间戳落在哪个「本地小时」。 */
export function hourOf(now) {
  const d = new Date(Number(now) || Date.now());
  const h = d.getHours();
  return Number.isFinite(h) ? h : 0;
}

export function inQuietHours(now, cfg) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const h = hourOf(now);
  const s = c.quietStart;
  const e = c.quietEnd;
  if (s === e) return false;
  return s > e ? h >= s || h < e : h >= s && h < e;
}

/** 没 cookie 时的粗判据。 */
export function decideClaim({ lastClaimAt = 0, now = Date.now(), cfg } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const last = Number(lastClaimAt) || 0;
  if (!last) return { needClaim: false, hoursSinceLast: null, reason: 'unknown' };
  const hours = (Number(now) - last) / 3600000;
  if (!Number.isFinite(hours) || hours < 0) return { needClaim: false, hoursSinceLast: 0, reason: 'fresh' };
  if (hours >= c.alertAfterHours) {
    return { needClaim: true, hoursSinceLast: Math.round(hours * 10) / 10, reason: 'stale' };
  }
  return { needClaim: false, hoursSinceLast: Math.round(hours * 10) / 10, reason: 'fresh' };
}

/** 提醒节流：冷却过了才说，且半夜不说。 */
export function shouldAlert({ now = Date.now(), cfg, lastAlertAt = 0, inQuiet = null } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const quiet = inQuiet === null ? inQuietHours(now, c) : !!inQuiet;
  if (quiet) return { alert: false, reason: 'quiet' };
  const gap = c.alertCooldownHours * 3600000;
  const last = Number(lastAlertAt) || 0;
  if (last > 0 && Number(now) - last < gap) return { alert: false, reason: 'cooldown' };
  return { alert: true, reason: 'ok' };
}

/** session 文件的内容可能是字符串，也可能是 {cookie}，也可能直接是 cookie 列表。 */
export function cookieHeaderFromSession(session) {
  if (!session) return '';
  if (typeof session === 'string') return session.trim();
  if (typeof session !== 'object') return '';
  const raw = Array.isArray(session) ? session : (session.cookie ?? session.cookies ?? session.header ?? '');
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (!c) return '';
        if (typeof c === 'string') return c;
        const name = String(c.name ?? '').trim();
        const value = String(c.value ?? '').trim();
        return name && value ? `${name}=${value}` : '';
      })
      .filter(Boolean)
      .join('; ');
  }
  return String(raw || '').trim();
}

/** cookie 里有名字就必须有值；只有名字没有值等于失效。 */
export function sessionLooksUsable(session) {
  const header = cookieHeaderFromSession(session);
  if (!header) return false;
  const parts = header.split(';').map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return false;
  return parts.every((p) => {
    const i = p.indexOf('=');
    return i > 0 && p.slice(i + 1).trim().length > 0;
  });
}

function withTimeout(fetchImpl, cfg) {
  const f = fetchImpl || globalThis.fetch;
  if (typeof f !== 'function') throw new Error('没有可用的 fetch');
  return (url, init = {}) => {
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : null;
    const opts = { ...init };
    if (ctrl) opts.signal = ctrl.signal;
    return Promise.resolve(f(url, opts)).finally(() => {
      if (timer) clearTimeout(timer);
    });
  };
}

async function readJson(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { __raw: text.slice(0, 400) };
  }
}

/** 读 summary 的真实字段。只认实测见过的字段，其余留 null（不猜）。 */
export function parseSummary(json) {
  if (!json || typeof json !== 'object') return null;
  const available = typeof json.daily_claim_available === 'boolean' ? json.daily_claim_available : null;
  const claimedToday = typeof json.daily_claim_claimed_today === 'boolean' ? json.daily_claim_claimed_today : null;
  let canClaim = available;
  if (canClaim === null && claimedToday !== null) canClaim = !claimedToday;
  return {
    canClaim,
    claimedToday,
    nextResetAt: parseIsoMs(json.daily_claim_next_reset_at),
    amount: num(json.daily_claim_amount, 0),
    balance: num(json.balance, 0),
  };
}

/** 兼容式读法：优先 summary 真实字段，认不出返回 null（不猜着领）。 */
export function canClaimFromSummary(json) {
  const info = parseSummary(json);
  if (info && typeof info.canClaim === 'boolean') return info.canClaim;
  if (!json || typeof json !== 'object') return null;
  for (const v of [json.canClaim, json.can_claim]) if (typeof v === 'boolean') return v;
  return null;
}

/** 只读账本。 */
export async function fetchBalance({ apiKey, cfg, fetchImpl } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const key = String(apiKey || '').trim();
  if (!key) return { ok: false, error: '没有 BREEZE_API_KEY' };
  try {
    const res = await withTimeout(fetchImpl, c)(`${c.apiHost}/v1/balance`, {
      method: 'GET',
      headers: { 'xi-api-key': key, accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    const json = await readJson(res);
    const topups = Array.isArray(json?.topups) ? json.topups : [];
    return { ok: true, topups, raw: json };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 网页 BFF：今天还能不能领。只读。 */
export async function fetchCreditSummary({ cookie, cfg, fetchImpl } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const header = cookieHeaderFromSession(cookie);
  if (!header) return { ok: false, error: '没有登录 cookie' };
  try {
    const res = await withTimeout(fetchImpl, c)(`${c.webHost}/api/credits/summary`, {
      method: 'GET',
      headers: {
        cookie: header,
        accept: 'application/json',
        origin: c.webHost,
        referer: `${c.webHost}/app/home`,
      },
    });
    const json = await readJson(res);
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 真正领取。**唯一有副作用的调用**。 */
export async function postDailyClaim({ cookie, rewardTier, cfg, fetchImpl } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const header = cookieHeaderFromSession(cookie);
  if (!header) return { ok: false, error: '没有登录 cookie' };
  const init = {
    method: 'POST',
    headers: {
      cookie: header,
      accept: 'application/json',
      'content-type': 'application/json',
      origin: c.webHost,
      referer: `${c.webHost}/app/home`,
    },
  };
  if (rewardTier !== undefined && rewardTier !== null && String(rewardTier).trim() !== '') {
    init.body = JSON.stringify({ reward_tier: rewardTier });
  }
  try {
    const res = await withTimeout(fetchImpl, c)(`${c.webHost}/api/credits/daily-claim`, init);
    const json = await readJson(res);
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 提醒文案。 */
export function buildAlertText({ hoursSinceLast, missedCount = 1, cfg, sessionUsable = false, sessionError = '' } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const hours = Number(hoursSinceLast);
  const span = Number.isFinite(hours) && hours > 0 ? `${Math.round(hours)} 小时` : '好几天';
  const heavy = Number(missedCount) >= c.escalateAfter;
  if (sessionUsable || sessionError) {
    return `Breeze 那 ${c.dailyAmount} credits 该领了，但自动领取没成功${sessionError ? `（${sessionError}）` : ''}。已经 ${span}没到账，要看一眼吗？`;
  }
  if (heavy) {
    return `Breeze 每日 ${c.dailyAmount} credits 又没领，连着 ${missedCount} 次了，距上次成功 ${span}。cookie 失效了还是没放？`;
  }
  return `Breeze 今天那 ${c.dailyAmount} credits 还没领（距上次成功 ${span}）。cookie 给我就能自动领，不然我只能提醒。`;
}

/**
 * 一次完整的 tick。返回 {changed, state, alert, actions}，不抛异常。
 */
export async function runClaimTick({
  state = {},
  cfg,
  apiKey,
  session = null,
  now = Date.now(),
  fetchImpl,
  rewardTier,
} = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const actions = [];
  if (!c.enabled) return { changed: false, state, alert: null, actions: ['disabled'] };

  const next = { ...state };
  next.version = 1;
  next.updatedAt = Number(now);

  // ---- ① 账本（恒做，顺便验证 key 还活着）----
  const bal = await fetchBalance({ apiKey, cfg: c, fetchImpl });
  if (!bal.ok) {
    actions.push(`balance:${bal.error || 'fail'}`);
    return { changed: true, state: next, alert: null, actions };
  }
  next.lastBalanceAt = Number(now);
  const last = findLastDailyClaim(bal.topups);
  if (last && last.at > (Number(next.lastClaimAt) || 0)) {
    next.lastClaimAt = last.at;
    next.lastClaimAmount = last.amount || c.dailyAmount;
    next.missedCount = 0;
    actions.push('claimed:observed');
  }

  const usable = sessionLooksUsable(session);

  // ---- ② 有 cookie：summary 说了算 ----
  if (usable && c.autoClaim) {
    const sum = await fetchCreditSummary({ cookie: session, cfg: c, fetchImpl });
    if (sum.ok) {
      const info = parseSummary(sum.json);
      next.lastSummaryAt = Number(now);
      next.canClaim = info?.canClaim ?? null;
      next.claimedToday = info?.claimedToday ?? null;
      next.claimAmount = info?.amount || c.dailyAmount;
      if (info?.nextResetAt) next.nextResetAt = info.nextResetAt;
      actions.push(`summary:canClaim=${info?.canClaim}`);

      if (info?.canClaim === true) {
        const res = await postDailyClaim({ cookie: session, rewardTier, cfg: c, fetchImpl });
        actions.push(`claim:${res.status ?? res.error ?? 'ok'}`);
        if (res.ok) {
          next.lastClaimAt = Number(now);
          next.lastClaimAmount = num(res.json?.amount ?? res.json?.credits, c.dailyAmount);
          next.missedCount = 0;
          next.lastError = '';
          next.canClaim = false;
          next.claimedToday = true;
          next.lastClaimResponse = JSON.stringify(res.json ?? {}).slice(0, 300);
          actions.push('claimed:now');
          return { changed: true, state: next, alert: null, actions };
        }
        next.lastError = res.status === 401 || res.status === 403 ? 'cookie 失效' : `领取失败 HTTP ${res.status ?? '?'}`;
        // 领失败 → 落到提醒分支
      } else {
        // 今天领过了 / 还没到重置点：确定没问题，不提醒。
        next.missedCount = 0;
        next.lastError = '';
        return { changed: true, state: next, alert: null, actions };
      }
    } else {
      actions.push(`summary:${sum.status ?? sum.error ?? 'fail'}`);
      if (sum.status === 401 || sum.status === 403) next.lastError = 'cookie 失效';
    }
  }

  // ---- ③ 提醒（没 cookie，或有 cookie 但领取失败）----
  const decision = decideClaim({ lastClaimAt: next.lastClaimAt || 0, now, cfg: c });
  next.lastDecision = decision;
  if (!decision.needClaim) return { changed: true, state: next, alert: null, actions };

  const throttled = shouldAlert({ now, cfg: c, lastAlertAt: next.lastAlertAt || 0 });
  if (!throttled.alert) {
    actions.push(`alert:${throttled.reason}`);
    return { changed: true, state: next, alert: null, actions };
  }
  next.missedCount = (Number(next.missedCount) || 0) + 1;
  next.lastAlertAt = Number(now);
  const text = buildAlertText({
    hoursSinceLast: decision.hoursSinceLast,
    missedCount: next.missedCount,
    cfg: c,
    sessionUsable: usable,
    sessionError: next.lastError || '',
  });
  actions.push('alert:sent');
  return { changed: true, state: next, alert: { text, hoursSinceLast: decision.hoursSinceLast }, actions };
}

/** 下一次 tick 该在多久之后。 */
export function nextCheckDelayMs(cfg) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  return Math.max(60 * 1000, c.checkHours * 3600 * 1000);
}
