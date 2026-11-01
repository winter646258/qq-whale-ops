// 「一天可以写多条」+ 日记配图持久化的回归测试。
// 只测纯逻辑：decideDailyDiary 的条数闸门、提醒文案不说假话、目录按 dest 建。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const SRC = '/opt/qq-bridge/src/diary-daily.js';
let pass = 0;
let fail = 0;
function eq(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { pass += 1; console.log(`  ✓ ${msg}`); }
  else { fail += 1; console.log(`  ✗ ${msg}\n        实得 ${JSON.stringify(a)}\n        期望 ${JSON.stringify(b)}`); }
}
function ok(v, msg) { eq(Boolean(v), true, msg); }

const m = await import(SRC);
const { countEntriesOnDay, decideDailyDiary, dailyDiaryLine, localDayOf, DIARY_DAILY_DEFAULTS } = m;

const T0 = new Date('2026-11-02T14:00:00+08:00').getTime();
const DAY = localDayOf(T0);
const mk = (id, day, hour = 14) => ({ id, day, t: new Date(`${day}T${String(hour).padStart(2, '0')}:00:00+08:00`).getTime(), text: 'x' });
const noState = { days: {} };

console.log('【1】countEntriesOnDay');
eq(countEntriesOnDay([], DAY), 0, '空数组 0');
eq(countEntriesOnDay([mk('a', DAY)], DAY), 1, '一条 1');
eq(countEntriesOnDay([mk('a', DAY), mk('b', DAY), mk('c', DAY)], DAY), 3, '三条 3');
eq(countEntriesOnDay([mk('a', '2026-11-01')], DAY), 0, '别的日子不算');
eq(countEntriesOnDay([{ id: 'z', t: T0, text: 'x' }], DAY), 1, '没有 day 字段时用 t 兜底');
eq(countEntriesOnDay([{ id: 'z', day: '', t: T0, text: 'x' }], DAY), 1, 'day 是空串时也用 t 兜底');
eq(countEntriesOnDay([null, {}, mk('a', DAY)], DAY), 1, '脏数据不炸');
eq(countEntriesOnDay([mk('a', DAY)], ''), 0, 'day 为空返回 0');

console.log('\n【2】一天能写多条（核心改动）');
const one = decideDailyDiary({ entries: [mk('a', DAY)], now: T0, hour: 14, state: noState, cfg: {} });
eq(one.nudged, true, '已写 1 条时仍会提醒（原来一条就 done）');
eq(one.wroteToday, 1, 'wroteToday=1');
eq(one.reason, 'nudge', 'reason=nudge');

const three = decideDailyDiary({ entries: [mk('a', DAY), mk('b', DAY), mk('c', DAY)], now: T0, hour: 14, state: noState, cfg: {} });
eq(three.nudged, false, '写满 3 条就停');
eq(three.reason, 'done', 'reason=done');
eq(three.wroteToday, 3, 'wroteToday=3');

const custom = decideDailyDiary({ entries: [mk('a', DAY), mk('b', DAY)], now: T0, hour: 14, state: noState, cfg: { maxPerDay: 2 } });
eq(custom.nudged, false, 'maxPerDay=2 时写满 2 条就停');

const oneMax = decideDailyDiary({ entries: [mk('a', DAY)], now: T0, hour: 14, state: noState, cfg: { maxPerDay: 1 } });
eq(oneMax.nudged, false, 'maxPerDay=1 等价于旧行为');

console.log('\n【3】冷却仍然生效（不能一天追着念）');
const lastAt = T0 - 60 * 1000;
const cooled = decideDailyDiary({
  entries: [mk('a', DAY)], now: T0, hour: 14,
  state: { days: { [DAY]: { count: 1, lastAt } } }, cfg: {}
});
eq(cooled.nudged, false, '1 分钟前刚提醒过 → cooldown');
eq(cooled.reason, 'cooldown', 'reason=cooldown');
const stale = decideDailyDiary({
  entries: [mk('a', DAY)], now: T0, hour: 14,
  state: { days: { [DAY]: { count: 1, lastAt: T0 - 4 * 3600 * 1000 } } }, cfg: {}
});
eq(stale.nudged, true, '4 小时前提醒过 → 可以再提醒');

console.log('\n【4】静默期 / 开关 / 上限都还在');
eq(decideDailyDiary({ entries: [], now: T0, hour: 2, state: noState, cfg: {} }).reason, 'quiet', '凌晨 2 点静默');
eq(decideDailyDiary({ entries: [], now: T0, hour: 14, state: noState, cfg: { enabled: false } }).reason, 'disabled', '关掉时不催');
eq(decideDailyDiary({ entries: [mk('a', DAY)], now: T0, hour: 14, state: { days: { [DAY]: { count: 3, lastAt: 0 } } }, cfg: {} }).reason, 'capped', '提醒次数达上限');

console.log('\n【5】文案不能说假话');
const l0 = dailyDiaryLine({ hour: 14, count: 1, wroteToday: 0, cfg: {} });
ok(l0.includes('今天还没写日记'), '没写过时说「还没写」');
const l1 = dailyDiaryLine({ hour: 14, count: 2, wroteToday: 1, cfg: {} });
ok(!l1.includes('今天还没写'), '写过 1 条时不能说「今天还没写」');
ok(l1.includes('写了 1 条'), '写过 1 条时说「写了 1 条」');
const l2 = dailyDiaryLine({ hour: 21, count: 2, wroteToday: 2, cfg: {} });
ok(!l2.includes('今天还没写'), '晚 9 点写过 2 条时也不能说「今天还没写」');
ok(l2.includes('还能再写一条'), '晚 9 点提示还能再写');
ok(l2.includes('别硬凑'), '明确允许不写');
const l3 = dailyDiaryLine({ hour: 21, count: 1, wroteToday: 0, cfg: {} });
ok(l3.includes('快过完了'), '晚 9 点没写过 → 强提醒');
eq(dailyDiaryLine({ hour: 14, count: 1, wroteToday: 0, cfg: {} }) === dailyDiaryLine({ hour: 14, count: 1, wroteToday: 0, cfg: {} }), true, '同参同输出');

console.log('\n【6】maxPerDay 配置真的被读到');
const cfgSrc = fs.readFileSync(SRC, 'utf8');
ok(cfgSrc.includes('maxPerDay: num(raw.maxPerDay'), 'dailyCfg 读 maxPerDay');
ok(!/if \(hasEntryOnDay\(entries, day\)\) return result\(false, 'done'\)/.test(cfgSrc), '不再有「一条就 done」的硬短路');
ok(cfgSrc.includes('countEntriesOnDay(entries, day)'), '改用当天条数判断');

console.log('\n【7】配图目录按 dest 的父目录建（11-01 那个 ENOENT 的根因）');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'destdir-'));
const dest = path.join(tmp, 'art', '2026-11', '2026-11-01-dc4939.png');
let threw = false;
try { fs.writeFileSync(dest, 'x'); } catch { threw = true; }
eq(threw, true, '不建父目录时写入必失败（复现原 bug）');
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, 'x');
eq(fs.existsSync(dest), true, 'mkdirSync(dirname(dest)) 之后能写');
fs.rmSync(tmp, { recursive: true, force: true });

console.log('\n【8】bridge 里确实改成建父目录 + 落账本');
const bridge = fs.readFileSync('/opt/qq-bridge/src/bridge.js', 'utf8');
ok(bridge.includes('fs.mkdirSync(path.dirname(dest), { recursive: true });'), 'bridge 建的是 dest 的父目录');
ok(!/fs\.mkdirSync\(DIARY_ART_DIR, \{ recursive: true \}\);\n      const dest/.test(bridge), '不再只建 DIARY_ART_DIR');
ok(bridge.includes('DIARY_ART_PENDING_FILE'), '有待办账本');
ok(bridge.includes('diaryArtRecoverTick'), '有补做函数');
ok(bridge.includes('补做定时器已排上'), '启动时排了补做');
ok(bridge.includes('DIARY_ART_MAX_ATTEMPTS'), '有重试上限');
ok(bridge.includes("String(hit.id) === String(entry.id)"), '写回时校验 id（防 setDiaryArt 回落到最后一条）');

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
