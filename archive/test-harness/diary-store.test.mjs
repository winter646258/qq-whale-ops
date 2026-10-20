// 日记 jsonl 模块单测。用法：node diary-store.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  localStamp, localDay, readDiary, writeDiary, appendDiaryEntry,
  updateDiaryEntry, removeDiaryEntry, recentDiary, diaryDays,
  parseLegacyMarkdown, diaryStats, MAX_ENTRIES, MAX_TEXT_CHARS, MAX_MOOD_CHARS
} from './diary-store.js';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const eq = (l, a, b) => ok(l, a === b, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);
const throws = (l, fn) => { try { fn(); ok(l, false, '本应抛错'); } catch { ok(l, true); } };
const section = (t) => console.log(`\n=== ${t} ===`);

// ── 时间戳（这是旧实现的 bug）──────────────────────────────────────────
section('时间戳必须走本地时区');
{
  const d = new Date(2026, 9, 20, 22, 24, 0); // 本地 22:24
  eq('localStamp 是本地 22:24', localStamp(d), '2026-10-20 22:24');
  eq('localDay', localDay(d), '2026-10-20');
  // 关键：不能用 toISOString（UTC 会变成 14:24）
  const utc = d.toISOString().slice(0, 16).replace('T', ' ');
  ok('本地时间与 UTC 不同（证明修的是真问题）', localStamp(d) !== utc, `本地=${localStamp(d)} UTC=${utc}`);
  const night = new Date(2026, 9, 20, 3, 20, 0);
  eq('凌晨 3:20 不会被写成前一天的 19:20', localStamp(night), '2026-10-20 03:20');
}

section('新增一条');
{
  const list = [];
  const e = appendDiaryEntry(list, { text: '那只梨没回来', now: Date.parse('2026-10-20T14:20:00Z') });
  eq('进了 1 条', list.length, 1);
  eq('正文', e.text, '那只梨没回来');
  eq('没有 mood 就不写这个字段', e.mood, '');
  ok('id 形如 d+5位', /^d[0-9a-f]{5}$/.test(e.id), e.id);
  ok('t 是数字时间戳', typeof e.t === 'number' && e.t > 0);
  ok('time 是本地时间格式', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(e.time), e.time);
  ok('day 是 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(e.day));

  throws('空内容要报错', () => appendDiaryEntry(list, { text: '   ' }));

  const withMood = appendDiaryEntry(list, { text: '有点累', mood: '累但还行' });
  eq('带 mood', withMood.mood, '累但还行');
}

section('换行与长度');
{
  const list = [];
  const e = appendDiaryEntry(list, { text: '第一行\n第二行\r\n第三行' });
  eq('换行被压成空格（一条就该是一行）', e.text, '第一行 第二行 第三行');
  ok('不含 \\n', !e.text.includes('\n'));

  const long = appendDiaryEntry(list, { text: 'x'.repeat(500) });
  eq('正文截断到 200', long.text.length, MAX_TEXT_CHARS);

  const longMood = appendDiaryEntry(list, { text: 'a', mood: '很'.repeat(50) });
  eq('心情截断到 20', longMood.mood.length, MAX_MOOD_CHARS);
}

// ── 这是 Markdown 方案的致命缺陷，用来证明换格式是对的 ─────────────────
section('结构健壮性：正文里的 "- " 不会破坏它（Markdown 方案会）');
{
  const list = [];
  appendDiaryEntry(list, { text: '- 今天买梨了\n- 但没给她留' });
  appendDiaryEntry(list, { text: '普通一条' });
  eq('还是 2 条（Markdown 里会被误读成 4 条）', list.length, 2);
  eq('第一条内容完整保留', list[0].text, '- 今天买梨了 - 但没给她留');
}

section('落盘 → 读回');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-test-'));
  const file = path.join(dir, '日记.jsonl');

  const list = [];
  appendDiaryEntry(list, { text: '第一条', now: 1792400000000 });
  appendDiaryEntry(list, { text: '第二条', mood: '困', now: 1792400060000 });
  const bytes = writeDiary(file, list);
  ok('写出了字节数', bytes > 0);

  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.trim().split('\n');
  eq('磁盘上就是 2 行 jsonl', lines.length, 2);
  ok('每行都能独立 JSON.parse', lines.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));

  const back = readDiary(file);
  eq('读回 2 条', back.length, 2);
  eq('正文一致', back[0].text, '第一条');
  eq('mood 保住', back[1].mood, '困');
  eq('时间戳保住', back[0].t, 1792400000000);

  if (process.platform !== 'win32') {
    eq('权限 600', (fs.statSync(file).mode & 0o777).toString(8), '600');
  } else {
    ok('Windows 跳过权限位断言', true);
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

section('坏行不影响整体（Markdown 做不到这种容错）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-bad-'));
  const file = path.join(dir, '日记.jsonl');
  const good = JSON.stringify({ id: 'd00001', t: 1792400000000, time: '2026-10-20 10:00', day: '2026-10-20', text: '好的' });
  fs.writeFileSync(file, [good, '{ 这不是 json', '', 'null', JSON.stringify({ t: 1, text: '' }), good].join('\n'), 'utf8');

  const back = readDiary(file);
  eq('只读出 2 条有效的（坏行/空行/无正文的都跳过）', back.length, 2);
  eq('有效内容正确', back[0].text, '好的');

  fs.rmSync(dir, { recursive: true, force: true });
}

section('文件不存在 vs 读不动');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-miss-'));
  const missing = path.join(dir, 'nope.jsonl');
  const empty = readDiary(missing);
  ok('不存在 ⇒ 空数组（不报错）', Array.isArray(empty) && empty.length === 0);

  // 损坏到无法读取（用目录冒充文件，制造 EISDIR）
  const asDir = path.join(dir, 'weird.jsonl');
  fs.mkdirSync(asDir);
  throws('读不动要抛错（不能当空日记再写回去）', () => readDiary(asDir));

  fs.rmSync(dir, { recursive: true, force: true });
}

section('改写');
{
  const list = [];
  const a = appendDiaryEntry(list, { text: '那只梨没回来' });
  const b = appendDiaryEntry(list, { text: '今天很累' });

  const r1 = updateDiaryEntry(list, { id: a.id, text: '那只梨被他吃了' });
  ok('按 id 改到了', r1 && r1.changed);
  eq('新正文', a.text, '那只梨被他吃了');
  ok('没有 originalText（日记不留底，和印象不同）', a.originalText === undefined);
  ok('记了 editedAt', a.editedAt > 0);

  const r2 = updateDiaryEntry(list, { oldText: '今天很累', mood: '累' });
  ok('按正文片段匹配到', r2 && r2.changed);
  eq('只加 mood 不改正文', b.text, '今天很累');
  eq('mood 加上了', b.mood, '累');

  const r3 = updateDiaryEntry(list, { oldText: '今天很累', mood: '累' });
  ok('同样内容不算变更', r3.changed === false);

  eq('改不存在的 ⇒ null', updateDiaryEntry(list, { id: 'd99999', text: 'x' }), null);
  eq('正文片段找不到 ⇒ null', updateDiaryEntry(list, { oldText: '查无此句', text: 'x' }), null);
}

section('删（仅管理员用）');
{
  const list = [];
  const a = appendDiaryEntry(list, { text: 'A' });
  appendDiaryEntry(list, { text: 'B' });
  eq('删掉一条', removeDiaryEntry(list, a.id), true);
  eq('剩 1 条', list.length, 1);
  eq('删不存在 ⇒ false', removeDiaryEntry(list, 'd99999'), false);
}

section('读取视图');
{
  const list = [];
  for (let i = 0; i < 15; i += 1) {
    appendDiaryEntry(list, { text: `第${i}条`, now: 1792400000000 + i * 60000 });
  }
  eq('最近 10 条', recentDiary(list, 10).length, 10);
  eq('最近一条是最新的', recentDiary(list, 1)[0].text, '第14条');
  eq('limit 上限 100', recentDiary(list, 999).length, 15);
  ok('limit 非法给 10', recentDiary(list, 'x').length === 10);
}

section('按天统计');
{
  const list = [];
  const d1 = Date.parse('2026-10-18T10:00:00+08:00');
  const d2 = Date.parse('2026-10-20T23:00:00+08:00');
  appendDiaryEntry(list, { text: 'a', now: d1 });
  appendDiaryEntry(list, { text: 'b', now: d1 + 3600000 });
  appendDiaryEntry(list, { text: 'c', now: d2 });
  const days = diaryDays(list);
  eq('两天', days.length, 2);
  eq('第一天 2 条', days[0].count, 2);
  eq('第二天 1 条', days[1].count, 1);
  eq('按日期升序', days[0].day <= days[1].day, true);
}

section('兼容旧 Markdown（只读）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diary-legacy-'));
  const md = path.join(dir, '日记.md');
  fs.writeFileSync(md, [
    '# 日记',
    '（这里是小鲸鱼自己的日记…）',
    '',
    '- [2026-10-11 03:20] 那只梨没回来',
    '- [2026-10-12 22:10] 今天很累',
    '- 没有时间戳的一条'
  ].join('\n'), 'utf8');

  const parsed = parseLegacyMarkdown(md);
  eq('解析出 3 条', parsed.length, 3);
  eq('第一条正文', parsed[0].text, '那只梨没回来');
  eq('时间戳原样保留', parsed[0].time, '2026-10-11 03:20');
  eq('day 从时间戳取', parsed[0].day, '2026-10-11');
  eq('没时间戳的也能读', parsed[2].text, '没有时间戳的一条');

  fs.rmSync(dir, { recursive: true, force: true });
}

section('统计');
{
  const list = [];
  appendDiaryEntry(list, { text: 'a', mood: '平静', now: 1792400000000 });
  appendDiaryEntry(list, { text: 'b', now: 1792400060000 });
  const s = diaryStats(list);
  eq('条数', s.count, 2);
  eq('带心情的条数', s.withMood, 1);
  eq('天数', s.days, 1);
  ok('有首尾时间', !!s.firstAt && !!s.lastAt);
}

section('条数上限');
{
  const list = [];
  for (let i = 0; i < MAX_ENTRIES; i += 1) list.push({ id: 'd' + i, t: i, text: 'x' });
  throws('到上限要拦', () => appendDiaryEntry(list, { text: 'y' }));
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
