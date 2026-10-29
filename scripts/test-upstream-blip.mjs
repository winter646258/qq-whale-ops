// 上游抖动折叠器：只测纯逻辑，不打网络。
import { isUpstreamBlip, createBlipTracker, BLIP_DEFAULTS } from '../src/upstream-blip.js';

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); pass++; } catch (e) { fail++; console.log(`  ✗ ${name}\n     ${e.message}`); }
};
const eq = (a, b, tip = '') => { if (a !== b) throw new Error(`${tip} 期望 ${JSON.stringify(b)}，实得 ${JSON.stringify(a)}`); };
const ok = (v, tip = '') => { if (!v) throw new Error(tip || '期望为真'); };

const T0 = 1793240000000; // 固定时间，别让用例随真实钟点飘
const HTML502 = "the gateway's front proxy answered HTTP 502 with an HTML error page — usually a WAF or body-size limit in front of the gateway, not your credentials; if this hit a long conversation, its request size is the likely trigger";

// ── 分类 ───────────────────────────────────────────────
t('HTML 502 算抖动', () => ok(isUpstreamBlip(HTML502)));
t('521/522 也认', () => { ok(isUpstreamBlip('the gateway answered HTTP 521 with an HTML error page')); ok(isUpstreamBlip('HTTP 522 with an HTML error page')); });
t('503 临时不可用算抖动', () => ok(isUpstreamBlip('Service temporarily unavailable')));
t('连接被掐算抖动', () => { ok(isUpstreamBlip('terminated')); ok(isUpstreamBlip('socket hang up')); ok(isUpstreamBlip('read ECONNRESET')); ok(isUpstreamBlip('other side closed')); });
t('上游空回复算抖动', () => ok(isUpstreamBlip('our-free-model: upstream returned no body')));
t('额度不足不算抖动（要人管）', () => ok(!isUpstreamBlip('raccoon: 积分余额不足')));
t('限流不算抖动', () => ok(!isUpstreamBlip('Free usage limit reached. Free models work in OpenCode')));
t('地区限制不算抖动', () => ok(!isUpstreamBlip('This model is not available in your country')));
t('签名被改不算抖动', () => ok(!isUpstreamBlip('the gateway rejected the request signature — the request body was modified in transit')));
t('孤立代理不算抖动', () => ok(!isUpstreamBlip('request contains an unpaired Unicode surrogate; repair text encoding and retry')));
t('4xx 不算抖动', () => ok(!isUpstreamBlip('upstream HTTP 400: bad request')));
t('空/undefined 不算', () => { ok(!isUpstreamBlip('')); ok(!isUpstreamBlip(null)); ok(!isUpstreamBlip(undefined)); ok(!isUpstreamBlip('   ')); });
t('单个 terminated 不该被 "terminated by" 误伤', () => ok(!isUpstreamBlip('the task terminated by user')));

// ── 折叠：窗口内第 1 次通知，第 2 次静默，第 3 次升级 ──────────
t('第一次：通知', () => {
  const b = createBlipTracker();
  const r = b.hit('group:1', HTML502, T0);
  eq(r.notify, true, '第一次'); eq(r.count, 1); eq(r.escalate, false); eq(r.blip, true);
});
t('第二次（同一窗口）：静默', () => {
  const b = createBlipTracker();
  b.hit('group:1', HTML502, T0);
  const r = b.hit('group:1', HTML502, T0 + 6000);
  eq(r.notify, false, '第二次'); eq(r.count, 2);
});
t('第三次：升级通知（且只升级一次）', () => {
  const b = createBlipTracker();
  b.hit('group:1', HTML502, T0);
  b.hit('group:1', HTML502, T0 + 6000);
  const r3 = b.hit('group:1', HTML502, T0 + 12000);
  eq(r3.notify, true, '第三次'); eq(r3.escalate, true, '应升级'); eq(r3.count, 3);
  const r4 = b.hit('group:1', HTML502, T0 + 18000);
  eq(r4.notify, false, '第四次应静默'); eq(r4.escalate, false, '不该再升级');
});
t('静默期间另一个 key 互不影响', () => {
  const b = createBlipTracker();
  b.hit('group:1', HTML502, T0);
  b.hit('group:1', HTML502, T0 + 1000);
  const other = b.hit('group:2', HTML502, T0 + 2000);
  eq(other.notify, true, '另一个群第一次应通知'); eq(other.count, 1);
});
t('窗口过期后重新计数（再来一次又通知）', () => {
  const b = createBlipTracker({ quietMs: 60000 });
  b.hit('group:1', HTML502, T0);
  b.hit('group:1', HTML502, T0 + 1000); // 静默
  const after = b.hit('group:1', HTML502, T0 + 61000);
  eq(after.notify, true, '过窗应重新通知'); eq(after.count, 1, '过窗计数归 1');
});
t('真问题（非抖动）永远通知，且不进食账', () => {
  const b = createBlipTracker();
  const r1 = b.hit('group:1', 'raccoon: 积分余额不足', T0);
  const r2 = b.hit('group:1', 'raccoon: 积分余额不足', T0 + 1000);
  eq(r1.notify, true); eq(r2.notify, true, '连续两次都要报');
  eq(r1.blip, false); eq(b.peek('group:1'), null, '不该记账');
});
t('抖动与真问题交错：抖动被折叠，真问题照报', () => {
  const b = createBlipTracker();
  b.hit('group:1', HTML502, T0);                       // 通知
  const q = b.hit('group:1', '积分余额不足', T0 + 500);  // 通知
  const b2 = b.hit('group:1', HTML502, T0 + 1000);      // 静默
  eq(q.notify, true, '真问题要报'); eq(b2.notify, false, '抖动继续折叠');
});
t('升到第 3 次之后继续抖动也只静默（不再刷屏）', () => {
  const b = createBlipTracker();
  for (let i = 0; i < 6; i++) b.hit('group:1', HTML502, T0 + i * 1000);
  const r = b.hit('group:1', HTML502, T0 + 7000);
  eq(r.notify, false); eq(r.count, 7);
});
t('可关掉（enabled:false 时全部照报）', () => {
  const b = createBlipTracker({ enabled: false });
  const r1 = b.hit('group:1', HTML502, T0);
  const r2 = b.hit('group:1', HTML502, T0 + 1000);
  eq(r1.notify, true); eq(r2.notify, true); eq(r2.blip, false);
});
t('key 记账有上限（不会无限涨）', () => {
  const b = createBlipTracker({ maxKeys: 3 });
  for (let i = 0; i < 10; i++) b.hit(`group:${i}`, HTML502, T0 + i);
  let n = 0;
  for (let i = 0; i < 10; i++) if (b.peek(`group:${i}`)) n++;
  ok(n <= 3, `记账条数应 <=3，实得 ${n}`);
});
t('默认参数符合预期', () => {
  eq(BLIP_DEFAULTS.quietMs, 30 * 60 * 1000); eq(BLIP_DEFAULTS.escalateAt, 3); eq(BLIP_DEFAULTS.enabled, true);
});

// ── 接线：bridge.js 里必须真的用上 ────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const bridge = readFileSync(join(here, '..', 'src', 'bridge.js'), 'utf8');

t('bridge 里 import 了这个模块', () => ok(/from '\.\/upstream-blip\.js'/.test(bridge), '缺 import'));
t('bridge 里建了实例', () => ok(/upstreamBlips\s*=\s*createBlipTracker/.test(bridge), '缺 createBlipTracker 实例'));
t('错误分支里调了 hit 并据此决定是否通知', () => {
  ok(/upstreamBlips\.hit\(key, safeMsg/.test(bridge), '没在错误分支调用 hit');
  ok(/if \(!blip\.notify\)/.test(bridge), '没有按 notify 决定');
  ok(/\} else try \{/.test(bridge), '通知块没被 else 保护起来');
});
t('静默时写日志写活动（不能静默到没人知道）', () => {
  ok(/网关临时故障（\$\{blip\.quietMin\} 分钟内第 \$\{blip\.count\} 次，已静默）/.test(bridge), '缺静默日志');
  ok(/网关临时故障（第 \$\{blip\.count\} 次，已静默）/.test(bridge), '缺活动记录');
});

console.log(`\n上游抖动折叠器：${pass} 项通过${fail ? `，${fail} 项失败` : ''}`);
process.exit(fail ? 1 : 0);
