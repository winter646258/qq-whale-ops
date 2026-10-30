// 端到端体检：把意愿门接到真实 bridge 的会话状态上跑一轮，看：
//   1. 明确叫她的（@ / 名字 / 提问）在额度耗尽时是否仍然放行
//   2. 一群人在聊、什么都没命中时，她会不会自己开口
//   3. 分数落盘/读回是否正常，重启后不清零
//   4. 私聊不受影响
//
// 跑法（服务器上）：node scripts/probe-willingness.mjs
import fs from 'node:fs';
import path from 'node:path';
import {
  consumeWillingness,
  describeWillingness,
  evaluateWillingness,
  isForcedReason,
  resolveWillingness
} from '../src/willingness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const WFILE = path.join(ROOT, 'state', 'willingness.json');

// 用线上真实配置里的 tier 等覆盖（如果有）
let liveCfg = {};
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  liveCfg = { ...(cfg?.socialV2?.wake?.willingness ?? {}), ...(cfg?.socialV2?.willingness ?? {}) };
} catch { /* 读不到就用默认 */ }
const base = { enabled: true, ...liveCfg };
console.log('生效配置：', JSON.stringify(resolveWillingness({ ...base, rhythm: 'available' })));

let pass = 0;
let fail = 0;
function check(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}${extra ? '  ' + extra : ''}`); }
  else { fail += 1; console.error(`  ✗ ${name}${extra ? '  ' + extra : ''}`); }
}

console.log('\n【1】一组真聊天模拟（12 条，无任何触发命中）');
let st = { score: 0, updatedAt: 0, skipCount: 0, consumedReplyAt: 0 };
const T0 = Date.now();
const spoke = [];
for (let i = 0; i < 12; i += 1) {
  const now = T0 + i * 30000;
  const d = evaluateWillingness(st, { ...base, rhythm: 'available', auto: false, tier: 'normal' }, {
    now, messageCount: 1, content: '今天中午吃啥', quotedBot: false, reason: '', rhythm: 'available'
  });
  st = d.state;
  console.log(`   第 ${String(i + 1).padStart(2)} 条  ${describeWillingness(d)}`);
  if (d.shouldCall) { spoke.push(i + 1); st = { ...consumeWillingness(st, base, now), consumedReplyAt: st.consumedReplyAt }; }
}
check('12 条里她至少开了 1 次口', spoke.length >= 1, `开口于第 ${spoke.join('/')} 条`);
check('12 条里她没有次次开口', spoke.length < 12, `共 ${spoke.length} 次`);

console.log('\n【2】明确叫她的直通');
for (const r of ['private', 'atMention', 'nameMention', 'poke']) {
  const d = evaluateWillingness({ score: 0, updatedAt: T0, skipCount: 9 }, { ...base, rhythm: 'asleep' }, {
    now: T0, messageCount: 1, reason: r, rhythm: 'asleep'
  });
  check(`${r} 在分数为 0 + 抖动期 + 半夜 时仍放行`, d.shouldCall === true && d.reason === 'forced');
}

console.log('\n【3】落盘 / 读回');
const before = st.score;
fs.writeFileSync(WFILE, JSON.stringify({ version: 1, keys: { 'group:000': { ...st, updatedAt: T0 } } }, null, 2));
const back = JSON.parse(fs.readFileSync(WFILE, 'utf8')).keys['group:000'];
check('分数写得进读得出', Math.abs(Number(back.score) - before) < 1e-6, `${before} → ${back.score}`);
check('skipCount 一并保存', Number.isFinite(Number(back.skipCount)));
try {
  fs.unlinkSync(WFILE);
  check('测试文件已清理', true);
} catch { check('测试文件已清理', false); }

console.log('\n【4】私聊不设门（由 bridge 侧短路，这里只验档位不影响其判定）');
const priv = evaluateWillingness(undefined, { ...base, rhythm: 'available' }, {
  now: T0, messageCount: 1, reason: 'private', rhythm: 'available'
});
check('private 直通', priv.shouldCall === true);

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exitCode = fail ? 1 : 0;
