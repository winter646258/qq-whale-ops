// Breeze 签到模块单测：纯函数 + runClaimTick（fetch 全部注入，不打真网）。
// 跑法：node scripts/test-breeze-claim.mjs
import assert from 'node:assert/strict';
import {
  BREEZE_CLAIM_DEFAULTS,
  buildAlertText,
  canClaimFromSummary,
  cookieHeaderFromSession,
  decideClaim,
  findLastDailyClaim,
  inQuietHours,
  nextCheckDelayMs,
  normalizeClaimCfg,
  parseIsoMs,
  postDailyClaim,
  runClaimTick,
  sessionLooksUsable,
  shouldAlert,
} from '../src/breeze-claim.js';

let pass = 0;
let fail = 0;
function eq(actual, expected, msg) {
  try {
    assert.deepEqual(actual, expected);
    pass += 1;
  } catch {
    fail += 1;
    console.log(`  ✗ ${msg}\n    实得 ${JSON.stringify(actual)}\n    期望 ${JSON.stringify(expected)}`);
  }
}
function ok(v, msg) {
  try {
    assert.ok(v);
    pass += 1;
  } catch {
    fail += 1;
    console.log(`  ✗ ${msg}`);
  }
}
function group(name) {
  console.log(`\n【${name}】`);
}

// 用「本地 12:00」构造基准，避免时区差异把 quiet 判定带跑偏。
const NOON = new Date(2026, 10, 2, 12, 0, 0).getTime();
const HOUR = 3600000;

// ---------------------------------------------------------------- 1. 配置归一
group('1. normalizeClaimCfg');
{
  const d = normalizeClaimCfg(undefined);
  eq(d.enabled, true, '缺省 enabled');
  eq(d.alertAfterHours, 20, '缺省 alertAfterHours');
  eq(d.autoClaim, true, '缺省 autoClaim');
  eq(d.apiHost, 'https://api.breeze.blue', '缺省 apiHost');

  const trimmed = normalizeClaimCfg({ apiHost: 'https://x.test///', webHost: 'https://y.test///' });
  eq(trimmed.apiHost, 'https://x.test', 'apiHost 去掉尾部斜杠');
  eq(trimmed.webHost, 'https://y.test', 'webHost 去掉尾部斜杠');

  eq(normalizeClaimCfg({ enabled: 'off' }).enabled, false, '字符串 off 认成 false');
  eq(normalizeClaimCfg({ enabled: 'yes' }).enabled, true, '字符串 yes 认成 true');
  eq(normalizeClaimCfg({ enabled: '随便' }).enabled, true, '认不出的字符串回落默认');

  eq(normalizeClaimCfg({ alertAfterHours: -3 }).alertAfterHours, 20, '负阈值回落默认');
  eq(normalizeClaimCfg({ alertAfterHours: '99' }).alertAfterHours, 99, '大于 24 小时是合法的（隔几天没领）');
  eq(normalizeClaimCfg({ alertAfterHours: 30 }).alertAfterHours, 30, '合法值保留');
  eq(normalizeClaimCfg({ checkHours: 0 }).checkHours, 6, 'checkHours 0 当没填 → 回落默认 6');
  eq(normalizeClaimCfg({ checkHours: 2 }).checkHours, 2, 'checkHours 合法值保留');
  eq(normalizeClaimCfg({ timeoutMs: 10 }).timeoutMs, 3000, 'timeoutMs 下限 3000');
  eq(normalizeClaimCfg({ quietStart: 25 }).quietStart, 23, 'hour 超范围回落');
  ok(BREEZE_CLAIM_DEFAULTS.dailyAmount === 400, '默认每日 400');
}

// ---------------------------------------------------------------- 2. 时间解析
group('2. parseIsoMs');
{
  eq(parseIsoMs('2026-11-01T10:52:24Z'), Date.parse('2026-11-01T10:52:24Z'), 'ISO 解析');
  eq(parseIsoMs(1700000000000), 1700000000000, '数字直通');
  eq(parseIsoMs(''), 0, '空串 0');
  eq(parseIsoMs('不是时间'), 0, '垃圾 0');
  eq(parseIsoMs(null), 0, 'null 0');
  eq(parseIsoMs(0), 0, '0 返回 0（调用方要当「不知道」）');
}

// ---------------------------------------------------------------- 3. 找最后一次签到
group('3. findLastDailyClaim');
{
  const topups = [
    { amount: 400, description: 'daily claim credits', created_at: '2026-10-31T10:00:00Z' },
    { amount: 1000, description: 'topup purchase', created_at: '2026-11-01T09:00:00Z' },
    { amount: 400, description: 'Daily Claim Credits', created_at: '2026-11-01T10:52:24Z' },
    { amount: 400, description: 'daily-claim bonus', created_at: '2026-11-02T01:00:00Z' },
  ];
  const hit = findLastDailyClaim(topups);
  eq(hit.at, Date.parse('2026-11-02T01:00:00Z'), '取最新那条（三种写法都认）');
  eq(hit.amount, 400, '带出金额');

  eq(findLastDailyClaim([]), null, '空数组 null');
  eq(findLastDailyClaim(null), null, 'null 输入 null');
  eq(
    findLastDailyClaim([{ description: 'daily claim credits', created_at: '瞎写' }]),
    null,
    '日期解析不了就跳过，不返回 1970',
  );
  eq(
    findLastDailyClaim([{ description: 'topup purchase', created_at: '2026-11-01T00:00:00Z' }]),
    null,
    '非签到条目不算',
  );
}

// ---------------------------------------------------------------- 4. 该不该领
group('4. decideClaim');
{
  eq(decideClaim({ lastClaimAt: 0, now: NOON }).reason, 'unknown', '没观测过 = unknown（不是 needClaim）');
  eq(decideClaim({ lastClaimAt: 0, now: NOON }).needClaim, false, 'unknown 时不催');

  const fresh = decideClaim({ lastClaimAt: NOON - 1 * HOUR, now: NOON });
  eq(fresh.needClaim, false, '1 小时前领过 → 不催');
  eq(fresh.reason, 'fresh', 'reason fresh');

  const stale = decideClaim({ lastClaimAt: NOON - 20 * HOUR, now: NOON });
  eq(stale.needClaim, true, '正好 20 小时 → 催');
  eq(stale.reason, 'stale', 'reason stale');
  eq(stale.hoursSinceLast, 20, '小时数四舍五入到 0.1');

  const justUnder = decideClaim({ lastClaimAt: NOON - 19.9 * HOUR, now: NOON });
  eq(justUnder.needClaim, false, '19.9 小时 → 还没到');

  eq(decideClaim({ lastClaimAt: NOON + 5 * HOUR, now: NOON }).needClaim, false, '未来时间当 fresh，不催');
}

// ---------------------------------------------------------------- 5. 提醒节流
group('5. shouldAlert');
{
  eq(shouldAlert({ now: NOON, cfg: BREEZE_CLAIM_DEFAULTS, lastAlertAt: 0 }).alert, true, '没提醒过 → 说');
  eq(
    shouldAlert({ now: NOON, cfg: BREEZE_CLAIM_DEFAULTS, lastAlertAt: NOON - 2 * HOUR }).reason,
    'cooldown',
    '2 小时前提醒过 → 冷却',
  );
  eq(
    shouldAlert({ now: NOON, cfg: BREEZE_CLAIM_DEFAULTS, lastAlertAt: NOON - 9 * HOUR }).alert,
    true,
    '9 小时前提醒过 → 可以说',
  );
  eq(shouldAlert({ now: NOON, cfg: BREEZE_CLAIM_DEFAULTS, inQuiet: true }).reason, 'quiet', '半夜不说');

  const night = new Date(2026, 10, 2, 2, 0, 0).getTime();
  eq(inQuietHours(night, BREEZE_CLAIM_DEFAULTS), true, '凌晨 2 点在静默期');
  eq(inQuietHours(NOON, BREEZE_CLAIM_DEFAULTS), false, '中午不在静默期');
  const noQuiet = normalizeClaimCfg({ quietStart: 0, quietEnd: 0 });
  eq(inQuietHours(night, noQuiet), false, 'quietStart==quietEnd 等于没静默');
}

// ---------------------------------------------------------------- 6. cookie 归一
group('6. cookieHeaderFromSession');
{
  eq(cookieHeaderFromSession('a=1; b=2'), 'a=1; b=2', '字符串原样');
  eq(cookieHeaderFromSession({ cookie: 'a=1' }), 'a=1', '对象取 cookie');
  eq(cookieHeaderFromSession({ cookies: 'a=1' }), 'a=1', '对象取 cookies');
  eq(
    cookieHeaderFromSession([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]),
    'a=1; b=2',
    '数组对象拼成 header',
  );
  eq(cookieHeaderFromSession(['a=1', 'b=2']), 'a=1; b=2', '数组字符串直接接');
  eq(cookieHeaderFromSession(null), '', 'null 空串');
  eq(cookieHeaderFromSession({}), '', '空对象空串');
}

group('7. sessionLooksUsable');
{
  eq(sessionLooksUsable(null), false, 'null 不可用');
  eq(sessionLooksUsable({}), false, '空对象不可用');
  eq(sessionLooksUsable('a=1; b=2'), true, '有名字有值 → 可用');
  eq(sessionLooksUsable('a=; b=2'), false, '有空值就判不可用');
  eq(sessionLooksUsable('novalue'), false, '没有等号判不可用');
  eq(sessionLooksUsable('  '), false, '空白不可用');
}

// ---------------------------------------------------------------- 8. summary 读法
group('8. canClaimFromSummary');
{
  eq(canClaimFromSummary({ canClaim: true }), true, 'canClaim true');
  eq(canClaimFromSummary({ can_claim: false }), false, 'can_claim false');
  eq(canClaimFromSummary({ claimed: false }), true, 'claimed=false → 能领');
  eq(canClaimFromSummary({ alreadyClaimed: true }), false, 'alreadyClaimed=true → 不能领');
  eq(canClaimFromSummary({ credits: 400 }), null, '没有确定字段 → null（不猜）');
  eq(canClaimFromSummary(null), null, 'null → null');
}

// ---------------------------------------------------------------- 9. 文案
group('9. buildAlertText');
{
  const light = buildAlertText({ hoursSinceLast: 22, missedCount: 1, cfg: BREEZE_CLAIM_DEFAULTS });
  ok(light.includes('400'), '轻档带金额');
  ok(light.includes('cookie'), '轻档告诉他要 cookie');
  ok(!light.includes('连着'), '轻档不升级措辞');

  const heavy = buildAlertText({ hoursSinceLast: 70, missedCount: 3, cfg: BREEZE_CLAIM_DEFAULTS });
  ok(heavy.includes('连着 3 次'), '重档说次数');

  const broken = buildAlertText({
    hoursSinceLast: 30,
    missedCount: 1,
    cfg: BREEZE_CLAIM_DEFAULTS,
    sessionUsable: true,
    sessionError: 'cookie 失效',
  });
  ok(broken.includes('cookie 失效'), '有 session 却失败时说明是领取出错，不是忘了');
  ok(!broken.includes('给我'), '这种情况不再要 cookie');
}

// ---------------------------------------------------------------- 10. tick 全链路
group('10. runClaimTick');
{
  const apiKey = 'brz_test';
  const session = 'session=abc; uid=1';

  function mkFetch({ topupHoursAgo, summary, claim, base = NOON }) {
    const calls = [];
    const fake = async (url, init) => {
      calls.push({ url, method: (init && init.method) || 'GET', body: init && init.body });
      if (url.endsWith('/v1/balance')) {
        const topups =
          topupHoursAgo === null
            ? []
            : [
                {
                  amount: 400,
                  description: 'daily claim credits',
                  created_at: new Date(base - topupHoursAgo * HOUR).toISOString(),
                },
              ];
        return { ok: true, status: 200, text: async () => JSON.stringify({ topups }) };
      }
      if (url.endsWith('/api/credits/summary')) {
        return { ok: true, status: 200, text: async () => JSON.stringify(summary ?? { canClaim: true }) };
      }
      if (url.endsWith('/api/credits/daily-claim')) {
        const c = claim ?? { ok: true, status: 200, json: { amount: 400 } };
        return {
          ok: c.ok,
          status: c.status,
          text: async () => JSON.stringify(c.json ?? {}),
        };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };
    fake.calls = calls;
    return fake;
  }

  // 10.1 关掉就什么都不做
  {
    const f = mkFetch({ topupHoursAgo: 30 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({ enabled: false }), apiKey, now: NOON, fetchImpl: f });
    eq(r.actions, ['disabled'], 'disabled 直接返回');
    eq(f.calls.length, 0, '关掉时不发任何请求');
  }

  // 10.2 没 key
  {
    const f = mkFetch({ topupHoursAgo: 30 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey: '', now: NOON, fetchImpl: f });
    ok(r.actions[0].startsWith('balance:'), '没 key 记录 balance 失败');
    eq(r.alert, null, '没 key 不提醒（是配置问题，不是忘领）');
  }

  // 10.3 刚领过 → 静默
  {
    const f = mkFetch({ topupHoursAgo: 2 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, now: NOON, fetchImpl: f });
    eq(r.alert, null, '刚领过不提醒');
    eq(r.state.missedCount, 0, 'missedCount 归零');
    ok(r.state.lastClaimAt > 0, '记下 lastClaimAt');
  }

  // 10.4 该领 + 没 session → 只提醒，绝不尝试领取
  {
    const f = mkFetch({ topupHoursAgo: 25 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: NOON, fetchImpl: f });
    ok(r.alert && r.alert.text.includes('cookie'), '没 session 时提醒要 cookie');
    ok(!f.calls.some((c) => c.url.includes('daily-claim')), '没 session 绝不调领取接口');
    ok(!f.calls.some((c) => c.url.includes('credits/summary')), '没 session 也不调 summary');
    eq(r.state.missedCount, 1, '记一次未领');
  }

  // 10.5 该领 + session 可用 + 领取成功
  {
    const f = mkFetch({ topupHoursAgo: 25 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(r.actions.includes('claimed:now'), '记录 claimed:now');
    eq(r.alert, null, '领到就不提醒');
    eq(r.state.lastClaimAmount, 400, '记下金额');
    const post = f.calls.find((c) => c.url.endsWith('/api/credits/daily-claim'));
    ok(post && post.method === 'POST', '确实发了 POST');
    eq(post.body, undefined, '不带 reward_tier 时不发 body（和官方前端一致）');
  }

  // 10.6 带 rewardTier 时才发 body
  {
    const f = mkFetch({ topupHoursAgo: 25 });
    await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f, rewardTier: 't1' });
    const post = f.calls.find((c) => c.url.endsWith('/api/credits/daily-claim'));
    eq(JSON.parse(post.body), { reward_tier: 't1' }, 'reward_tier 进 body');
  }

  // 10.7 summary 说今天领过了 → 不重复领
  {
    const f = mkFetch({ topupHoursAgo: 25, summary: { canClaim: false } });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(r.actions.includes('claim:skip-already'), 'summary 说领过就跳过');
    ok(!f.calls.some((c) => c.url.endsWith('/api/credits/daily-claim')), '没发领取请求');
  }

  // 10.8 领取 401 → 记下来并提醒（说明 cookie 失效）
  {
    const f = mkFetch({ topupHoursAgo: 25, claim: { ok: false, status: 401, json: {} } });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    eq(r.state.lastError, 'cookie 失效', '401 记成 cookie 失效');
    ok(r.alert && r.alert.text.includes('cookie 失效'), '提醒里说清是 cookie 问题');
  }

  // 10.9 半夜不提醒，但状态照记
  {
    const night = new Date(2026, 10, 2, 2, 0, 0).getTime();
    const f = mkFetch({ topupHoursAgo: 25, base: night });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: night, fetchImpl: f });
    eq(r.alert, null, '凌晨不打扰');
    ok(r.actions.includes('alert:quiet'), '记录 quiet');
  }

  // 10.10 冷却期内第二次 tick 不重复喊
  {
    const f = mkFetch({ topupHoursAgo: 25 });
    const first = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: NOON, fetchImpl: f });
    ok(first.alert, '第一次提醒');
    const second = await runClaimTick({
      state: first.state,
      cfg: normalizeClaimCfg({}),
      apiKey,
      session: null,
      now: NOON + 1 * HOUR,
      fetchImpl: f,
    });
    eq(second.alert, null, '一小时后不重复');
    ok(second.actions.includes('alert:cooldown'), '记录 cooldown');
    const third = await runClaimTick({
      state: second.state,
      cfg: normalizeClaimCfg({}),
      apiKey,
      session: null,
      now: NOON + 9 * HOUR,
      fetchImpl: f,
    });
    ok(third.alert, '九小时后可以再说');
    ok(third.alert.text.includes('连着'), '第二次起升级措辞');
  }

  // 10.10b 有 cookie 时不看间隔：summary 说能领就领
  {
    const f = mkFetch({ topupHoursAgo: 2, summary: { canClaim: true } });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(r.actions.includes('claimed:now'), '刚领过也能在 summary 允许时立刻补领');
    eq(r.alert, null, '领到不提醒');
  }

  // 10.10c 有 cookie 但 summary 说不能领 → 什么都不做
  {
    const f = mkFetch({ topupHoursAgo: 2, summary: { canClaim: false } });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(!r.actions.includes('claimed:now'), 'summary 说不能领就不领');
    ok(!f.calls.some((c) => c.url.endsWith('/api/credits/daily-claim')), '没发领取请求');
    eq(r.alert, null, '也不提醒');
  }

  // 10.10d 有 cookie 但 summary 形状不认识（can=null）→ 也不能乱领
  {
    const f = mkFetch({ topupHoursAgo: 2, summary: { credits: 400 } });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(!r.actions.includes('claimed:now'), '形状不认识时不猜着领');
  }
  // 10.11 nextCheckDelayMs
  {
    eq(nextCheckDelayMs(BREEZE_CLAIM_DEFAULTS), 6 * HOUR, '默认 6 小时');
    eq(nextCheckDelayMs({ checkHours: 0 }), 60000, '下限 1 分钟（未归一化的 0 也兜住）');
  }

  // 10.12 postDailyClaim 裸调（无 cookie）不发请求
  {
    let called = 0;
    const f = async () => {
      called += 1;
      return { ok: true, status: 200, text: async () => '{}' };
    };
    const r = await postDailyClaim({ cookie: '', cfg: BREEZE_CLAIM_DEFAULTS, fetchImpl: f });
    eq(r.ok, false, '无 cookie 返回失败');
    eq(called, 0, '无 cookie 不发请求');
  }
}

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
if (fail > 0) process.exit(1);
