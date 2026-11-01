// Breeze Blue 每日 400 credits 签到：观测 + 可选自动领取。
//
// 事实（2026-11-02 实测确认，别再重新猜）：
//   - 开发者 API（api.breeze.blue/v1）**没有** claim 端点，/v1/*claim* 全部 404。
//   - 网页 BFF 有：POST https://breezeblue.ai/api/credits/daily-claim（可选 body {reward_tier}）
//                  GET  https://breezeblue.ai/api/credits/summary
//     来自 https://breezeblue.ai/app 的 Next.js chunk：
//       "claimDailyCredits",0,function(e){return(0,i.typedFetch)("/api/credits/daily-claim",{method:"POST",...})}
//   - 认证只认登录 cookie（Firebase 会话）。裸打或带 xi-api-key 都是 401。
//   - 官方定价页：「Free: Claim 400 free credits daily」「Daily credits must be claimed manually」。
//   - 账本证据：GET /v1/balance 的 topups 里有
//       {"amount":400,"description":"daily claim credits","created_at":"2026-11-01T10:52:24Z"}
//
// 所以本模块分两段，互不依赖：
//   ① 观测：只读 balance，判断「距上次 daily claim 多久」，超阈值就提醒主人。
//   ② 自动领取：**只有存在 state/breeze-session.json 且没标过期时才会发生**。
//      cookie 缺失 / 失效一律退回 ①，绝不猜、绝不用开发者 key 硬试。
//
// 设计纪律：所有网络调用走注入的 fetchImpl，所有时间走注入的 now，纯函数部分不碰 fs。

export const BREEZE_CLAIM_DEFAULTS = {
  enabled: true,
  apiHost: 'https://api.breeze.blue',
  webHost: 'https://breezeblue.ai',
  checkHours: 6,
  // 距上次成功领取超过这么多小时就算「今天没领」。
  // 刻意不用「日历日」判断：官方没公开重置时刻（UTC 还是东八区日界未确认），
  // 用「间隔」判断对边界免疫 —— 每天领一次时间隔约 24h，> 20h 必然命中。
  alertAfterHours: 20,
  // 提醒冷却：同一条消息别每 6 小时都说一遍。
  alertCooldownHours: 8,
  quietStart: 23,
  quietEnd: 8,
  timeoutMs: 15000,
  autoClaim: true,
  dailyAmount: 400,
  // 连续这么多次「观测到没领」才升级措辞（前几次轻描淡写）。
  escalateAfter: 2,
};

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 只接受正数；0 和负数都当「没填」。用于小时级阈值 —— 它们允许 >24（隔几天没领）。 */
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

/** ISO 时间串 → 毫秒。解析不出来返回 0（调用方必须把 0 当「不知道」，不能当 1970）。 */
export function parseIsoMs(value) {
  // 数字入参：<=0 一律当「不知道」。不能往下走 String()，因为 Date.parse("0") = 2000-01-01。
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : 0;
  const s = String(value ?? '').trim();
  if (!s) return 0;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * 从 balance 的 topups 里找最后一次「每日签到」。
 * 官方 description 就是 "daily claim credits"，用大小写不敏感匹配，
 * 顺手兼容 "Daily Claim Credits" / "daily-claim" 这类写法变化。
 */
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

/** 一个时间戳落在哪个「本地小时」—— 提醒要避开半夜。 */
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

/**
 * 核心判断：现在该不该去领 / 该不该提醒。
 * 返回 {needClaim, hoursSinceLast, reason}
 *   reason: 'never'（从没观测到）| 'stale'（超过阈值）| 'fresh'（刚领过）| 'unknown'（lastClaimAt=0 且不可信）
 */
export function decideClaim({ lastClaimAt = 0, now = Date.now(), cfg } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const last = Number(lastClaimAt) || 0;
  if (!last) {
    // 从没拿到过账本（还没成功读过 balance）—— 不能说「该领」，也不能说「刚领过」。
    // 用 'unknown' 让调用方区分「确实没领」和「我们不知道」。
    return { needClaim: false, hoursSinceLast: null, reason: 'unknown' };
  }
  const hours = (Number(now) - last) / 3600000;
  if (!Number.isFinite(hours) || hours < 0) {
    return { needClaim: false, hoursSinceLast: 0, reason: 'fresh' };
  }
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

/** session 文件的内容可能是字符串，也可能是 {cookie, savedAt, expiresAt}。 */
export function cookieHeaderFromSession(session) {
  if (!session) return '';
  if (typeof session === 'string') return session.trim();
  if (typeof session !== 'object') return '';
  // session 本身就可以是一个 cookie 列表（[{name,value}] 或 ["a=1"]）。
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

/** 只读账本。这是「零风险观测」的全部依赖。 */
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

/** 网页 BFF：今天还能不能领。只读，不改任何东西。 */
export async function fetchCreditSummary({ cookie, cfg, fetchImpl } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const header = cookieHeaderFromSession(cookie);
  if (!header) return { ok: false, error: '没有登录 cookie' };
  try {
    const res = await withTimeout(fetchImpl, c)(`${c.webHost}/api/credits/summary`, {
      method: 'GET',
      headers: { cookie: header, accept: 'application/json' },
    });
    const json = await readJson(res);
    return { ok: res.ok, status: res.status, json };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 真正领取。**唯一有副作用的调用**，调用前必须已经确认 session 可用。 */
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
      // 官方前端打字面量 POST 且不带 body（未指定 rewardTier 时）；带 origin 更像真人。
      origin: c.webHost,
      referer: `${c.webHost}/app`,
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

/**
 * 从 summary 的响应里尽量读出「能不能领」。
 * 响应形状没公开，所以这里**只认确定字段、其余返回 null**，不猜。
 */
export function canClaimFromSummary(json) {
  if (!json || typeof json !== 'object') return null;
  const candidates = [
    json.canClaim, json.can_claim, json.claimed === undefined ? undefined : !json.claimed,
    json.available === undefined ? undefined : json.available,
    json.alreadyClaimed === undefined ? undefined : !json.alreadyClaimed,
    json.already_claimed === undefined ? undefined : !json.already_claimed,
  ];
  for (const v of candidates) {
    if (typeof v === 'boolean') return v;
  }
  return null;
}

/** 提醒文案。分两档：轻（刚超阈值）和重（连续多次）。 */
export function buildAlertText({ hoursSinceLast, missedCount = 1, cfg, sessionUsable = false, sessionError = '' } = {}) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  const hours = Number(hoursSinceLast);
  const span = Number.isFinite(hours) && hours > 0 ? `${Math.round(hours)} 小时` : '好几天';
  const heavy = Number(missedCount) >= c.escalateAfter;
  if (sessionUsable) {
    // 有 session 却还是没领成 —— 说明领取那一步出错了，不是「忘了」。
    return `Breeze 的每日 ${c.dailyAmount} credits 已经 ${span}没到账，cookie 还在但领取失败${sessionError ? `（${sessionError}）` : ''}。要不要我看一眼？`;
  }
  if (heavy) {
    return `Breeze 每日 ${c.dailyAmount} credits 又没领，已经连着 ${missedCount} 次了，距上次成功 ${span}。给我一个登录 cookie 我就自动领（state/breeze-session.json）。`;
  }
  return `Breeze 今天那 ${c.dailyAmount} credits 还没领（距上次成功 ${span}）。要自动领就把登录 cookie 给我，不然我只能提醒到这。`;
}

/**
 * 一次完整的 tick。
 * 返回 {changed, state, alert, actions}，不抛异常（内部全兜住），
 * 让 bridge 侧只需要「调一下 + 必要时发消息」。
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

  // ---- ① 观测 ----
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

  const decision = decideClaim({ lastClaimAt: next.lastClaimAt || 0, now, cfg: c });
  next.lastDecision = decision;

  // ---- ② 自动领取（只在 session 可用且确实该领时）----
  const usable = sessionLooksUsable(session);
  if (decision.needClaim && c.autoClaim && usable) {
    const summary = await fetchCreditSummary({ cookie: session, cfg: c, fetchImpl });
    actions.push(`summary:${summary.status ?? summary.error ?? 'ok'}`);
    const can = canClaimFromSummary(summary.json);
    if (summary.ok && can === false) {
      // summary 明确说今天领过了，但账本里还没出现 —— 不做第二次领取，等下一轮观测。
      actions.push('claim:skip-already');
    } else {
      const res = await postDailyClaim({ cookie: session, rewardTier, cfg: c, fetchImpl });
      actions.push(`claim:${res.status ?? res.error ?? 'ok'}`);
      if (res.ok) {
        next.lastClaimAt = Number(now);
        next.lastClaimAmount = num(res.json?.amount ?? res.json?.credits, c.dailyAmount);
        next.missedCount = 0;
        next.lastError = '';
        actions.push('claimed:now');
        return { changed: true, state: next, alert: null, actions };
      }
      next.lastError = res.status === 401 || res.status === 403 ? 'cookie 失效' : `领取失败 HTTP ${res.status ?? '?'}`;
    }
  }

  // ---- ②b 有 cookie 时不信「间隔」，直接问 summary ----
  // 官方没公开重置时刻，所以「间隔 20 小时」只是提醒用的粗判据。
  // 有登录态时一律以 summary 的 canClaim 为准：能领就领，不等间隔。
  if (!decision.needClaim && c.autoClaim && usable) {
    const summary = await fetchCreditSummary({ cookie: session, cfg: c, fetchImpl });
    const can = canClaimFromSummary(summary.json);
    actions.push(`summary2:${summary.status ?? summary.error ?? 'ok'}:${can}`);
    if (summary.ok && can === true) {
      const res = await postDailyClaim({ cookie: session, rewardTier, cfg: c, fetchImpl });
      actions.push(`claim:${res.status ?? res.error ?? 'ok'}`);
      if (res.ok) {
        next.lastClaimAt = Number(now);
        next.lastClaimAmount = num(res.json?.amount ?? res.json?.credits, c.dailyAmount);
        next.missedCount = 0;
        next.lastError = '';
        actions.push('claimed:now');
        return { changed: true, state: next, alert: null, actions };
      }
      next.lastError = res.status === 401 || res.status === 403 ? 'cookie 失效' : `领取失败 HTTP ${res.status ?? '?'}`;
    }
  }

  // ---- ③ 提醒 ----
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

/** 下一次 tick 该在多久之后 —— 给 bridge 侧算 interval 用。 */
export function nextCheckDelayMs(cfg) {
  const c = cfg || BREEZE_CLAIM_DEFAULTS;
  return Math.max(60 * 1000, c.checkHours * 3600 * 1000);
}
