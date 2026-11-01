// 日记长文改造单测：diary-store 的长度/多段/预写校验 + diary-daily 的双计数器。
//
// 跑法：node scripts/test-diary-long.mjs
// 注意：writeDiary 会落盘，一律用 os.tmpdir() 里的临时目录，不碰真日记。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MAX_TEXT_CHARS, MAX_BYTES, MAX_ENTRIES, MAX_ART_PROMPT_CHARS,
  appendDiaryEntry, updateDiaryEntry, writeDiary, readDiary,
  recentDiary, recallDiary, setDiaryArt
} from '../src/diary-store.js';
import {
  DIARY_DAILY_DEFAULTS, dailyCfg, countEntriesOnDay, decideDailyDiary,
  dailyDiaryLine, localDayOf, normalizeDraft, DIARY_DRAFT_DEFAULTS
} from '../src/diary-daily.js';

let pass = 0, fail = 0;
function eq(actual, expected, msg) {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a === b) { pass += 1; return; }
  fail += 1;
  console.log(`  ✗ ${msg}\n      实得 ${a}\n      期望 ${b}`);
}
function ok(cond, msg) { eq(!!cond, true, msg); }
function throws(fn, re, msg) {
  try { fn(); fail += 1; console.log(`  ✗ ${msg}（没抛错）`); }
  catch (e) { if (re && !re.test(String(e.message))) { fail += 1; console.log(`  ✗ ${msg}（错消息不符：${e.message}）`); } else pass += 1; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'diarylong-'));
const file = path.join(tmp, 'd.jsonl');

console.log('\n【1】长度上限与显式拒绝');
eq(MAX_TEXT_CHARS, 1200, '上限是 1200');
eq(MAX_ENTRIES, 6000, '条数上限放大到 6000');
eq(MAX_BYTES, 16 * 1024 * 1024, '字节上限放大到 16MiB');
eq(MAX_ART_PROMPT_CHARS, 700, '配图提示词仍是 700');

const e200 = appendDiaryEntry([], { text: 'あ'.repeat(200) });
eq(e200.text.length, 200, '200 字原样通过');
const e1200 = appendDiaryEntry([], { text: 'あ'.repeat(1200) });
eq(e1200.text.length, 1200, '1200 字原样通过（不截断）');
throws(() => appendDiaryEntry([], { text: 'あ'.repeat(1201) }), /超过 1200 字/, '1201 字抛错');
// 超长时不能往数组里塞半截
const arr = [];
throws(() => appendDiaryEntry(arr, { text: 'あ'.repeat(1300) }), /超过 1200 字/, '超长抛错时数组不动');
eq(arr.length, 0, '超长被拒后 entries 没变');

console.log('\n【2】换行保留（多段）');
const nl = appendDiaryEntry([], { text: 'a\r\nb\rc' });
eq(nl.text, 'a\nb\nc', 'CRLF/CR 统一成 LF，且不压成空格');
const multi = appendDiaryEntry([], { text: '第一段\n\n第二段' });
eq(multi.text, '第一段\n\n第二段', '空行也保留');
throws(() => appendDiaryEntry([], { text: '   \n\n  ' }), /不能为空/, '纯空白抛空内容');
eq(readDiary(file).length >= 0, true, '（fmtDiaryLine 在 bridge.js，不在这层测）');

console.log('\n【3】改写也守同一条上限');
const base = appendDiaryEntry([], { text: '短' });
const replaced = updateDiaryEntry([base], { id: base.id, text: 'あ'.repeat(1200) });
eq(replaced.entry.text.length, 1200, '改成 1200 字可以');
throws(() => updateDiaryEntry([base], { id: base.id, text: 'あ'.repeat(1201) }), /超过 1200 字/, '改成 1201 字抛错');

console.log('\n【4】落盘：一条记录一物理行，换行被转义');
const list = [
  appendDiaryEntry([], { text: '第一段\n第二段', mood: '还行', now: Date.now() }),
  appendDiaryEntry([], { text: '第二条', now: Date.now() })
];
const bytes = writeDiary(file, list);
const text = fs.readFileSync(file, 'utf8');
eq(text.split('\n').filter(Boolean).length, 2, '两条 = 两行物理行');
eq(text.includes('\\n'), true, '换行在磁盘上是 \\n 转义');
eq(bytes, Buffer.byteLength(text, 'utf8'), '返回的字节数等于实际内容字节');
const back = readDiary(file);
eq(back.length, 2, '读回来还是两条');
eq(back[0].text, '第一段\n第二段', '读回来换行还原了');

console.log('\n【5】越界预检：原文件不动');
const before = fs.readFileSync(file, 'utf8');
const big = { catch: 0 };
try {
  // 伪造一条刚好超过 16MiB 的记录（用不需要真分配超大字符串的方式算：直接写一个超长 text）
  const huge = [{ id: 'x', t: 1, time: 'x', day: '2026-11-01', text: 'あ'.repeat(6 * 1024 * 1024) }];
  writeDiary(file, huge);
} catch (e) {
  big.catch = 1;
  ok(/超过上限/.test(String(e.message)), '超 16MiB 抛「日记文件超过上限」');
  eq(e.code, 'DIARY_TOO_LARGE', '错误码是 DIARY_TOO_LARGE');
}
eq(big.catch, 1, '确实抛了（如果这条没抛，说明上限没生效）');
eq(fs.readFileSync(file, 'utf8'), before, '超限时原文件字节完全没变');

console.log('\n【6】读取回读面：10 + 4');
const many = [];
for (let i = 0; i < 20; i += 1) many.push(appendDiaryEntry([], { text: `第${i}条`, now: Date.now() - (20 - i) * 1000 }));
eq(recentDiary(many, 10).length, 10, 'recentDiary(10) 取 10 条');
const rec = recallDiary(many, { now: Date.now(), recent: 10, faded: 4 });
eq(rec.recent.length, 10, 'recallDiary recent 10');
ok(rec.faded.length <= 4, 'recallDiary faded 最多 4');

console.log('\n【7】配图提示词上限不跟正文联动');
const longEntry = appendDiaryEntry([], { text: 'あ'.repeat(1200) });
const holder = [longEntry];
setDiaryArt(holder, { id: longEntry.id, art: { file: '2026-11/a.png', prompt: 'あ'.repeat(2000), at: Date.now() } });
eq(holder[0].art.prompt.length, MAX_ART_PROMPT_CHARS, '配图提示词截到 700（不是跟着正文 1200 变）');
eq(longEntry.text.length, 1200, '对应正文仍是 1200 字');

console.log('\n【8】催写：两个计数器分家');
eq(DIARY_DAILY_DEFAULTS.maxPerDay, 5, 'maxPerDay 默认 5');
eq(DIARY_DAILY_DEFAULTS.maxPromptsPerDay, 5, 'maxPromptsPerDay 默认 5');
const cf = dailyCfg(null);
eq(cf.maxPerDay, 5, 'dailyCfg 缺省 5');
eq(cf.maxPromptsPerDay, 5, 'dailyCfg 缺省催 5 次');
eq(dailyCfg({ socialV2: { diaryDaily: { maxPerDay: 4 } } }).maxPromptsPerDay, 4, '只配 maxPerDay 时催写跟着走');
eq(dailyCfg({ socialV2: { diaryDaily: { maxPromptsPerDay: 2 } } }).maxPromptsPerDay, 2, '单配 maxPromptsPerDay 生效');

const now = new Date('2026-11-01T10:00:00').getTime();
const day = localDayOf(now);
const mk = (n) => {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push({ id: `x${i}`, day, t: now, time: '2026-11-01 09:00', text: `第${i}条` });
  return out;
};
const st = (count, lastAt) => ({ days: { [day]: { count, lastAt } } });

eq(countEntriesOnDay(mk(3), day), 3, 'countEntriesOnDay 数到 3');
eq(decideDailyDiary({ entries: [], now, hour: 10, state: null }).nudged, true, '没写没催过 → 催');
eq(decideDailyDiary({ entries: mk(1), now, hour: 10, state: st(0, 0) }).nudged, true, '写了 1 条也能催');
const r4 = decideDailyDiary({ entries: mk(4), now, hour: 10, state: st(4, now - 4 * 3600 * 1000) });
eq(r4.nudged, true, 'N=4/M=4 冷却够了还能再催一次');
eq(r4.count, 5, '催完计数到 5');
eq(decideDailyDiary({ entries: mk(5), now, hour: 10, state: st(0, 0) }).reason, 'done', '写满 5 条 → done');
eq(decideDailyDiary({ entries: mk(0), now, hour: 10, state: st(5, 0) }).reason, 'capped', '催满 5 次 → capped');
eq(decideDailyDiary({ entries: mk(1), now, hour: 10, state: st(5, 0) }).reason, 'capped', 'N=1/M=5 不因相加被误放行');
eq(decideDailyDiary({ entries: [], now, hour: 23, state: null }).reason, 'quiet', '23 点静默');
eq(decideDailyDiary({ entries: [], now, hour: 7, state: null }).reason, 'quiet', '7 点静默');
eq(decideDailyDiary({ entries: [], now, hour: 8, state: null }).nudged, true, '8 点不静默');
const lastOk = now - 3 * 3600 * 1000;
eq(decideDailyDiary({ entries: [], now, hour: 10, state: st(0, lastOk + 1) }).reason, 'cooldown', '差 1ms 到 3 小时 → 冷却');
eq(decideDailyDiary({ entries: [], now, hour: 10, state: st(0, lastOk) }).nudged, true, '正好 3 小时 → 放行');

console.log('\n【9】催写文案说实话');
const l3 = dailyDiaryLine({ hour: 21, count: 1, wroteToday: 3, cfg: DIARY_DAILY_DEFAULTS });
ok(l3.includes('3/5'), '已写 3/5 会显示');
ok(!l3.includes('还没写'), '已写过不说「还没写」');
const l0 = dailyDiaryLine({ hour: 10, count: 1, wroteToday: 0, cfg: DIARY_DAILY_DEFAULTS });
ok(l0.includes('还没写'), '没写过就说还没写');
ok(/可以写长|几百字|分段/.test(l0), '文案鼓励写长/分段');
ok(!/一两句/.test(l0), '不再要求一两句');

console.log('\n【10】草稿也放宽');
eq(DIARY_DRAFT_DEFAULTS.textChars, 400, '草稿上限 400');
const d = normalizeDraft({ text: '第一段\n第二段', mood: '还行' });
eq(d.text, '第一段\n第二段', '草稿保留换行');
const d2 = normalizeDraft({ text: 'あ'.repeat(1000) });
ok(d2.text.length <= 400, '草稿超长仍截到 400（草稿是引子不是正文）');
ok(d2.text.endsWith('…'), '草稿截断带省略号');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
