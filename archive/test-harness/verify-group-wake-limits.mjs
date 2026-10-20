// 隔离验证 resolveWakeLimitsV2：群聊独立降频，私聊不受影响
import fs from 'node:fs';

const src = fs.readFileSync('/tmp/gw/src/bridge.js', 'utf8');
const s = src.indexOf('function resolveWakeLimitsV2');
const e = src.indexOf('\n  }\n', s) + 4;
if (s < 0) { console.log('✖ 找不到 helper'); process.exit(1); }
const helpers = src.slice(s, e).replace('function resolveWakeLimitsV2(key)', 'function _inner(key)');
const resolveWakeLimitsV2 = (cfg, key) => new Function('cfg', 'key', helpers + '\nreturn _inner(key);')(cfg, key);

const cases = [
  // [说明, key, cfg.socialV2, 期望 autoReplyCheckMs, 期望 maxWakePerHour]
  ['私聊 + 无群聊配置（应保持全局）', 'private:1124721191',
   { autoReplyCheckMs: 30000, wake: { maxWakePerHour: 12 } }, 30000, 12],
  ['群聊 + 无群聊配置（应回退全局）', 'group:906710082',
   { autoReplyCheckMs: 30000, wake: { maxWakePerHour: 12 } }, 30000, 12],
  ['群聊 + 配了 180s/8（应生效）', 'group:906710082',
   { autoReplyCheckMs: 30000, autoReplyCheckMsInGroup: 180000, wake: { maxWakePerHour: 12, maxWakePerHourInGroup: 8 } }, 180000, 8],
  ['★私聊不受群聊配置影响', 'private:1124721191',
   { autoReplyCheckMs: 30000, autoReplyCheckMsInGroup: 180000, wake: { maxWakePerHour: 12, maxWakePerHourInGroup: 8 } }, 30000, 12],
  ['群聊配了 null（应回退）', 'group:906710082',
   { autoReplyCheckMs: 30000, autoReplyCheckMsInGroup: null, wake: { maxWakePerHour: 12, maxWakePerHourInGroup: null } }, 30000, 12],
  ['群聊配了非法值（应回退）', 'group:906710082',
   { autoReplyCheckMs: 30000, autoReplyCheckMsInGroup: 'abc', wake: { maxWakePerHour: 12, maxWakePerHourInGroup: {} } }, 30000, 12],
  ['群聊只配小时、分钟回退', 'group:906710082',
   { autoReplyCheckMs: 30000, wake: { maxWakePerHour: 12, maxWakePerHourInGroup: 6 } }, 30000, 6],
  ['全局为 0（视为未配，用兜底）', 'private:1124721191',
   { autoReplyCheckMs: 0, wake: { maxWakePerHour: 0 } }, 30000, 12],
];

let pass = 0;
console.log('=== resolveWakeLimitsV2 用例验证 ===');
for (const [label, key, sv2, wantMin, wantHour] of cases) {
  const _cfg = { socialV2: sv2 };
  let r;
  try { r = resolveWakeLimitsV2(_cfg, key); } catch (err) { console.log(`  ERROR ${label}: ${err.message}`); continue; }
  const ok = r.autoReplyCheckMs === wantMin && r.maxWakePerHour === wantHour;
  if (ok) pass++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${label} -> ${r.autoReplyCheckMs}/${r.maxWakePerHour} 期望 ${wantMin}/${wantHour} isGroup=${r.isGroup}`);
}
console.log(`\n  通过 ${pass}/${cases.length}`);
process.exit(pass === cases.length ? 0 : 1);
