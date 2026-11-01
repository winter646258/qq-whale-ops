// Breeze 签到模块单测 v2：按 2026-11-02 实测的真实字段（daily_claim_available 等）写夹具。
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
  parseSummary,
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

// 实测抓到的真实 summary 形状（字段名一个都别改）
function realSummary(patch = {}) {
  return {
    balance: 2593.3,
    granted_total: 2800,
    consumed_total: 206.7,
    generation_unit_cost: 0,
    generations_left: 0,
    daily_claim_amount: 400,
    daily_claim_discord_amount: 400,
    daily_claim_standard_amount: 100,
    daily_claim_available: false,
    daily_claim_claimed_today: true,
    daily_claim_next_reset_at: '2026-11-02T00:00:00+00:00',
    ...patch,
  };
}

// ---------------------------------------------------------------- 1. 配置归一
group('1. normalizeClaimCfg');
{
  const d = normalizeClaimCfg(undefined);
  eq(d.enabled, true, '缺省 enabled');
  eq(d.alertAfterHours, 20, '缺省 alertAfterHours');
  eq(d.checkHours, 0.5, '缺省 checkHours 0.5（重置时刻已知，半小时一次）');
  eq(d.autoClaim, true, '缺省 autoClaim');
  eq(d.apiHost, 'https://api.breeze.blue', '缺省 apiHost');

  const trimmed = normalizeClaimCfg({ apiHost: 'https://x.test///', webHost: 'https://y.test///' });
  eq(trimmed.apiHost, 'https://x.test', 'apiHost 去掉尾部斜杠');
  eq(trimmed.webHost, 'https://y.test', 'webHost 去掉尾部斜杠');

  eq(normalizeClaimCfg({ enabled: 'off' }).enabled, false, '字符串 off 认成 false');
  eq(normalizeClaimCfg({ enabled: 'yes' }).enabled, true, '字符串 yes 认成 true');
  eq(normalizeClaimCfg({ enabled: '随便' }).enabled, true, '认不出的字符串回落默认');

  eq(normalizeClaimCfg({ alertAfterHours: -3 }).alertAfterHours, 20, '负阈值回落默认');
  eq(normalizeClaimCfg({ alertAfterHours: '99' }).alertAfterHours, 99, '大于 24 小时合法（隔几天没领）');
  eq(normalizeClaimCfg({ checkHours: 0 }).checkHours, 0.5, 'checkHours 0 当没填');
  eq(normalizeClaimCfg({ checkHours: 2 }).checkHours, 2, 'checkHours 合法值保留');
  eq(normalizeClaimCfg({ timeoutMs: 10 }).timeoutMs, 3000, 'timeoutMs 下限 3000');
  eq(normalizeClaimCfg({ quietStart: 25 }).quietStart, 23, 'hour 超范围回落');
  ok(BREEZE_CLAIM_DEFAULTS.dailyAmount === 400, '默认每日 400');
}

// ---------------------------------------------------------------- 2. 时间解析
group('2. parseIsoMs');
{
  eq(parseIsoMs('2026-11-01T10:52:24Z'), Date.parse('2026-11-01T10:52:24Z'), 'ISO 解析');
  eq(parseIsoMs('2026-11-02T00:00:00+00:00'), Date.parse('2026-11-02T00:00:00Z'), '带时区的 ISO 解析');
  eq(parseIsoMs('2026-11-01T10:52:24.510201+00:00') > 0, true, '带微秒的 ISO 也能解析');
  eq(parseIsoMs(1700000000000), 1700000000000, '数字直通');
  eq(parseIsoMs(''), 0, '空串 0');
  eq(parseIsoMs('不是时间'), 0, '垃圾 0');
  eq(parseIsoMs(null), 0, 'null 0');
  eq(parseIsoMs(0), 0, '0 返回 0（调用方要当「不知道」）');
}

// ---------------------------------------------------------------- 3. 找最后一次签到
group('3. findLastDailyClaim');
{
  // 真实 /v1/balance 的 topups 形状
  const topups = [
    { amount: 1000, description: 'signup bonus credits', created_at: '2026-11-01T10:52:13.368782+00:00' },
    { amount: 400, description: 'Onboarding survey welcome reward', created_at: '2026-11-01T10:52:13.368782+00:00' },
    { amount: 400, description: 'daily claim credits', created_at: '2026-11-01T10:52:24.510201+00:00' },
    { amount: 1000, description: 'Referral registration reward', created_at: '2026-11-01T12:57:01.163721+00:00' },
  ];
  const hit = findLastDailyClaim(topups);
  eq(hit.at, Date.parse('2026-11-01T10:52:24.510Z'), '从真实 topups 里挑出签到那条（不是更晚的 referral）');
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
  eq(
    findLastDailyClaim([
      { description: 'daily claim credits', created_at: '2026-10-31T00:00:00Z' },
      { description: 'Daily Claim Credits', created_at: '2026-11-01T00:00:00Z' },
    ]).at,
    Date.parse('2026-11-01T00:00:00Z'),
    '多条时取最新',
  );
}

// ---------------------------------------------------------------- 4. summary 解析（真实字段）
group('4. parseSummary / canClaimFromSummary');
{
  const claimed = parseSummary(realSummary());
  eq(claimed.canClaim, false, 'claimed_today=true → 不能领');
  eq(claimed.claimedToday, true, 'claimedToday 读出来');
  eq(claimed.amount, 400, 'daily_claim_amount=400');
  eq(claimed.nextResetAt, Date.parse('2026-11-02T00:00:00Z'), 'next_reset_at 解析');
  eq(claimed.balance, 2593.3, 'balance 带出来');

  const available = parseSummary(realSummary({ daily_claim_available: true, daily_claim_claimed_today: false }));
  eq(available.canClaim, true, 'available=true → 能领');
  eq(canClaimFromSummary(realSummary({ daily_claim_available: true })), true, 'canClaimFromSummary 认 available');
  eq(canClaimFromSummary(realSummary()), false, 'canClaimFromSummary 认 claimed_today');

  // available 缺失时用 claimed_today 反推
  const onlyClaimed = realSummary();
  delete onlyClaimed.daily_claim_available;
  eq(parseSummary(onlyClaimed).canClaim, false, 'available 缺失时用 claimed_today 反推');

  // 两个都没有 → null，不猜
  eq(canClaimFromSummary({ balance: 100 }), null, '形状不认识 → null');
  eq(parseSummary({}).canClaim, null, '空对象 canClaim 为 null（不猜）');
  eq(parseSummary(null), null, 'null → null');
  // 老字段兜底
  eq(canClaimFromSummary({ canClaim: true }), true, '老字段 canClaim 仍认');
}

// ---------------------------------------------------------------- 5. 该不该领（无 cookie 判据）
group('5. decideClaim');
{
  eq(decideClaim({ lastClaimAt: 0, now: NOON }).reason, 'unknown', '没观测过 = unknown');
  eq(decideClaim({ lastClaimAt: 0, now: NOON }).needClaim, false, 'unknown 时不催');
  eq(decideClaim({ lastClaimAt: NOON - 1 * HOUR, now: NOON }).needClaim, false, '1 小时前领过 → 不催');
  const stale = decideClaim({ lastClaimAt: NOON - 20 * HOUR, now: NOON });
  eq(stale.needClaim, true, '正好 20 小时 → 催');
  eq(stale.hoursSinceLast, 20, '小时数四舍五入到 0.1');
  eq(decideClaim({ lastClaimAt: NOON - 19.9 * HOUR, now: NOON }).needClaim, false, '19.9 小时 → 还没到');
  eq(decideClaim({ lastClaimAt: NOON + 5 * HOUR, now: NOON }).needClaim, false, '未来时间当 fresh');
}

// ---------------------------------------------------------------- 6. 提醒节流
group('6. shouldAlert / inQuietHours');
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
  eq(inQuietHours(night, normalizeClaimCfg({ quietStart: 0, quietEnd: 0 })), false, 'start==end 等于没静默');
}

// ---------------------------------------------------------------- 7. cookie 归一
group('7. cookieHeaderFromSession / sessionLooksUsable');
{
  eq(cookieHeaderFromSession('a=1; b=2'), 'a=1; b=2', '字符串原样');
  eq(cookieHeaderFromSession({ cookie: 'a=1' }), 'a=1', '对象取 cookie');
  eq(cookieHeaderFromSession({ cookies: 'a=1' }), 'a=1', '对象取 cookies');
  eq(cookieHeaderFromSession([{ name: 'a', value: '1' }, { name: 'b', value: '2' }]), 'a=1; b=2', '数组对象拼 header');
  eq(cookieHeaderFromSession(['a=1', 'b=2']), 'a=1; b=2', '数组字符串直接接');
  eq(cookieHeaderFromSession(null), '', 'null 空串');
  eq(cookieHeaderFromSession({}), '', '空对象空串');

  eq(sessionLooksUsable(null), false, 'null 不可用');
  eq(sessionLooksUsable('a=1; b=2'), true, '有名字有值 → 可用');
  eq(sessionLooksUsable('a=; b=2'), false, '有空值就判不可用');
  eq(sessionLooksUsable('novalue'), false, '没有等号判不可用');
  eq(sessionLooksUsable('breeze_blue_session=abc123'), true, '真实 cookie 名可用');
}

// ---------------------------------------------------------------- 8. 文案
group('8. buildAlertText');
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
  ok(broken.includes('自动领取没成功'), '有 session 却没领成 → 说清是领取出错');
  ok(broken.includes('cookie 失效'), '带上具体原因');
}

// ---------------------------------------------------------------- 9. tick 全链路
group('9. runClaimTick');
{
  const apiKey = 'brz_test';
  const session = 'breeze_blue_session=abc123';

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
        return { ok: true, status: 200, text: async () => JSON.stringify(summary ?? realSummary()) };
      }
      if (url.endsWith('/api/credits/daily-claim')) {
        const c = claim ?? { ok: true, status: 200, json: { amount: 400 } };
        return { ok: c.ok, status: c.status, text: async () => JSON.stringify(c.json ?? {}) };
      }
      return { ok: false, status: 404, text: async () => '{}' };
    };
    fake.calls = calls;
    return fake;
  }

  // 9.1 关掉就什么都不做
  {
    const f = mkFetch({ topupHoursAgo: 30 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({ enabled: false }), apiKey, now: NOON, fetchImpl: f });
    eq(r.actions, ['disabled'], 'disabled 直接返回');
    eq(f.calls.length, 0, '关掉时不发任何请求');
  }

  // 9.2 没 key
  {
    const f = mkFetch({ topupHoursAgo: 30 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey: '', now: NOON, fetchImpl: f });
    ok(r.actions[0].startsWith('balance:'), '没 key 记录 balance 失败');
    eq(r.alert, null, '没 key 不提醒（配置问题，不是忘领）');
  }

  // 9.3 有 cookie + summary 说今天领过了 → 静默，且不调领取
  {
    const f = mkFetch({ topupHoursAgo: 2, summary: realSummary() });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    eq(r.alert, null, '领过了不提醒');
    ok(r.actions.includes('summary:canClaim=false'), '记录 canClaim=false');
    eq(r.state.claimedToday, true, '账本记下 claimedToday');
    ok(r.state.nextResetAt > 0, '记下 nextResetAt');
    ok(!f.calls.some((c) => c.url.includes('daily-claim')), '没发领取请求');
  }

  // 9.4 有 cookie + 可领 → 领成功
  {
    const f = mkFetch({
      topupHoursAgo: 25,
      summary: realSummary({ daily_claim_available: true, daily_claim_claimed_today: false }),
    });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    ok(r.actions.includes('claimed:now'), '记录 claimed:now');
    eq(r.alert, null, '领到就不提醒');
    eq(r.state.lastClaimAmount, 400, '记下金额');
    const post = f.calls.find((c) => c.url.endsWith('/api/credits/daily-claim'));
    ok(post && post.method === 'POST', '确实发了 POST');
    eq(post.body, undefined, '不带 reward_tier 时不发 body（和官方前端一致）');
    ok(r.state.lastClaimResponse.includes('400'), '存了响应快照');
  }

  // 9.5 带 rewardTier 才发 body
  {
    const f = mkFetch({
      topupHoursAgo: 25,
      summary: realSummary({ daily_claim_available: true }),
    });
    await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f, rewardTier: 't1' });
    const post = f.calls.find((c) => c.url.endsWith('/api/credits/daily-claim'));
    eq(JSON.parse(post.body), { reward_tier: 't1' }, 'reward_tier 进 body');
  }

  // 9.6 可领但领取 401 → 记 cookie 失效并提醒
  {
    const f = mkFetch({
      topupHoursAgo: 25,
      summary: realSummary({ daily_claim_available: true }),
      claim: { ok: false, status: 401, json: {} },
    });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session, now: NOON, fetchImpl: f });
    eq(r.state.lastError, 'cookie 失效', '401 记成 cookie 失效');
    ok(r.alert && r.alert.text.includes('自动领取没成功'), '提醒说清是领取出错');
  }

  // 9.7 没 cookie + 超阈值 → 只提醒，绝不碰领取
  {
    const f = mkFetch({ topupHoursAgo: 25 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: NOON, fetchImpl: f });
    ok(r.alert && r.alert.text.includes('cookie'), '没 session 时提醒要 cookie');
    ok(!f.calls.some((c) => c.url.includes('daily-claim')), '没 session 绝不调领取');
    ok(!f.calls.some((c) => c.url.includes('credits/summary')), '没 session 也不调 summary');
    eq(r.state.missedCount, 1, '记一次未领');
  }

  // 9.8 没 cookie + 刚领过 → 静默
  {
    const f = mkFetch({ topupHoursAgo: 2 });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: NOON, fetchImpl: f });
    eq(r.alert, null, '刚领过不提醒');
    eq(r.state.missedCount, 0, 'missedCount 归零');
  }

  // 9.9 半夜不提醒，但状态照记
  {
    const night = new Date(2026, 10, 2, 2, 0, 0).getTime();
    const f = mkFetch({ topupHoursAgo: 25, base: night });
    const r = await runClaimTick({ state: {}, cfg: normalizeClaimCfg({}), apiKey, session: null, now: night, fetchImpl: f });
    eq(r.alert, null, '凌晨不打扰');
    ok(r.actions.includes('alert:quiet'), '记录 quiet');
  }

  // 9.10 冷却期内不重复喊，过了可以再喊且升级措辞
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

  // 9.11 autoClaim=false 时有 cookie 也不领
  {
    const f = mkFetch({
      topupHoursAgo: 25,
      summary: realSummary({ daily_claim_available: true }),
    });
    const r = await runClaimTick({
      state: {},
      cfg: normalizeClaimCfg({ autoClaim: false }),
      apiKey,
      session,
      now: NOON,
      fetchImpl: f,
    });
    ok(!r.actions.includes('claimed:now'), 'autoClaim=false 不领');
    ok(!f.calls.some((c) => c.url.includes('daily-claim')), '也不发领取请求');
    ok(!f.calls.some((c) => c.url.includes('credits/summary')), '连 summary 都不问');
  }

  // 9.12 nextCheckDelayMs
  {
    eq(nextCheckDelayMs(BREEZE_CLAIM_DEFAULTS), 0.5 * HOUR, '默认半小时');
    eq(nextCheckDelayMs({ checkHours: 0 }), 60000, '下限 1 分钟');
  }

  // 9.13 postDailyClaim 无 cookie 不发请求
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
