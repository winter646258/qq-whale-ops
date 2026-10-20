// 验证「日程 / 画像」接线后的行为：
//   ① 注入文本真的进了唤醒 prompt
//   ② 三条原则在接线层也成立（不自动糊、模糊留底、分层注入）
//   ③ 帧内不炸（缺文件、坏文件、超上限）
//
// 做法：在隔离副本上起一个**只读探针**，直接用补丁后的真实函数验算，
// 不碰线上进程、不占端口。用法：
//   node verify-schedule-portrait.mjs ./bridge.rehearsal.js
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addEntry, updateEntry, removeEntry, querySchedule,
  formatScheduleForPrompt, shouldReviewToday, markReviewed, saveSchedule, loadSchedule
} from './schedule-store.js';
import {
  addPortrait, updatePortrait, queryPortrait, formatPortraitForPrompt, listSubjects, savePortrait, loadPortrait
} from './portrait-store.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✖ ${label}${extra ? ' — ' + extra : ''}`); }
};
const eq = (label, a, b) => ok(label, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n=== ${t} ===`);

const target = process.argv[2] || './bridge.rehearsal.js';
const src = fs.readFileSync(target, 'utf8');

section('接线检查：代码真的接上了');
ok('bridge 有 MARKER', src.includes('MARKER: schedule-portrait'));
ok('import 了 schedule-store', src.includes("from './schedule-store.js'"));
ok('import 了 portrait-store', src.includes("from './portrait-store.js'"));
ok('有 SCHEDULE_FILE 常量', src.includes("const SCHEDULE_FILE = path.join(STATE_DIR, 'schedule.json')"));
ok('有 PORTRAIT_FILE 常量', src.includes("const PORTRAIT_FILE = path.join(STATE_DIR, 'portrait.json')"));
ok('有日程端点', src.includes("url.pathname === '/api/socialV2/schedule'"));
ok('有画像端点', src.includes("url.pathname === '/api/socialV2/portrait'"));
// 线上文件是 CRLF（scp 从 Linux 拉下来后 PowerShell 转的），断言要把 \r 当空气看。
const srcLF = src.replace(/\r\n/g, '\n');
ok('日程开关默认值', /cfg\.socialV2\.schedule\s*=\s*\{\s*\n\s*enabled:\s*true/.test(srcLF));
ok('画像开关默认值', /cfg\.socialV2\.portrait\s*=\s*\{\s*\n\s*enabled:\s*true/.test(srcLF));
ok('日程有深合并（旧 config 缺字段也拿默认）', /cfg\.socialV2\.schedule\s*=\s*\{[\s\S]{0,300}\.\.\.\(cfg\.socialV2\?\.schedule \?\? \{\}\)/.test(srcLF));
ok('画像有深合并', /cfg\.socialV2\.portrait\s*=\s*\{[\s\S]{0,200}\.\.\.\(cfg\.socialV2\?\.portrait \?\? \{\}\)/.test(srcLF));
ok('tools.schedule 默认开', /schedule:\s*true,\s*\n\s*portrait:\s*true/.test(srcLF));
ok('工具开关清单含 schedule/portrait', src.includes("'schedule', 'portrait', 'diary', 'album'"));
ok('toolMap 含 qq_schedule', src.includes("schedule: 'qq_schedule'"));
ok('toolMap 含 qq_portrait', src.includes("portrait: 'qq_portrait'"));
ok('唤醒注入接了 scheduleLine', src.includes('scheduleLine = text'));
ok('唤醒注入接了 portraitLine', src.includes('portraitLine = ptext'));
ok('base 拼进了 scheduleLine', /const base = .*memoryLine \+ scheduleLine/.test(src));
ok('base 拼进了 portraitLine', /const base = .*scheduleReviewLine \+ portraitLine/.test(src));

section('原则一：没有任何自动改状态的路径');
ok('没有 setTimeout/setInterval 在改日程', !/scheduleStore\(\)[\s\S]{0,400}(setTimeout|setInterval)/.test(src));
ok('autoBlur / 自动降级 之类不存在', !/autoBlur|autoDecay|autoPrune|autoRemove/i.test(src));
ok('结算只调 markReviewed（不改条目）',
  /markReviewed\(schedStore[^)]*\);\s*\n\s*saveScheduleSafe/.test(src));

section('原则二：接线层也留旧文');
{
  const store = { version: 1, reviewDays: {}, entries: [] };
  const e = addEntry(store, { key: 'g:1', date: '今天', period: '上午', text: '上午上高数' });
  updateEntry(store, e.id, { text: '上午有课' });
  eq('接线后的 update 留下原文', e.originalText, '上午上高数');
  eq('并标记为模糊', e.blurred, true);
}

section('原则三：注入分层（真实函数产物）');
{
  const now = new Date(2026, 9, 20, 10, 0, 0);
  const store = { version: 1, reviewDays: {}, entries: [] };
  const mk = (d, p, t) => addEntry(store, { key: 'g:1', date: d, period: p, text: t, now: now.getTime() });
  mk('2026-10-20', '上午', '高数课');
  mk('2026-10-21', '下午', '体检');
  mk('2026-10-23', '上午', '周五的');
  mk('2026-11-20', '晚上', '很远的');

  const sched = formatScheduleForPrompt(store, { key: 'g:1', now });
  console.log('---- 日程注入 ----');
  console.log(sched);
  ok('今天/明天逐条写', sched.includes('- 今天 上午：高数课') && sched.includes('- 明天 下午：体检'));
  ok('本周后面只报数量', sched.includes('- 这周还有 1 条'));
  ok('更远只报总数', sched.includes('- 以后还有 1 条'));

  const pstore = { version: 1, subjects: {} };
  for (let i = 0; i < 6; i += 1) {
    for (let j = 0; j < 4; j += 1) {
      addPortrait(pstore, { subject: `人${i}`, facet: 'view', text: `人${i}-${j}`, weight: 9 - i });
    }
  }
  const port = formatPortraitForPrompt(pstore);
  console.log('---- 画像注入 ----');
  console.log(port);
  ok('画像最多 5 个人', port.split('\n').filter((l) => l.startsWith('- ')).length === 5);
  ok('每人只 3 条明细', port.includes('（还有 1 条）'));
  ok('剩余只报数量', port.includes('另外还记着 1 个人'));
}

section('结算提醒（每会话每天一次，4 点后）');
{
  const store = { version: 1, reviewDays: {}, entries: [] };
  eq('2 点不念', shouldReviewToday(store, { key: 'g:1', now: new Date(2026, 9, 20, 2, 0) }), false);
  eq('4 点念', shouldReviewToday(store, { key: 'g:1', now: new Date(2026, 9, 20, 4, 0) }), true);
  markReviewed(store, { key: 'g:1', now: new Date(2026, 9, 20, 4, 0) });
  eq('当天不重复念', shouldReviewToday(store, { key: 'g:1', now: new Date(2026, 9, 20, 20, 0) }), false);
  eq('别的会话独立', shouldReviewToday(store, { key: 'g:2', now: new Date(2026, 9, 20, 20, 0) }), true);
}

section('帧内健壮性：坏文件不炸、不覆盖');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sp-verify-'));
  const sFile = path.join(dir, 'schedule.json');
  const pFile = path.join(dir, 'portrait.json');

  // 文件不存在 → 空库，不报错
  eq('日程不存在 → 空库', loadSchedule(sFile).entries.length, 0);
  eq('画像不存在 → 空库', Object.keys(loadPortrait(pFile).subjects).length, 0);

  // 正常写读
  const s = { version: 1, reviewDays: {}, entries: [] };
  addEntry(s, { key: 'g:1', date: '今天', period: '上午', text: 'A' });
  saveSchedule(sFile, s);
  eq('写读一致', loadSchedule(sFile).entries.length, 1);

  // 损坏 → 抛错（由接线层降级为「本次只读」，绝不回写清空）
  fs.writeFileSync(sFile, 'broken{', 'utf8');
  let threw = false;
  try { loadSchedule(sFile); } catch { threw = true; }
  ok('损坏的日程库抛错而不是当空库', threw);

  // 接线层必须把「读失败」转成「拒绝写」（看代码里有没有这道闸）
  ok('接线层有只读降级闸（日程）', /scheduleStoreWritable = false[\s\S]{0,600}拒绝写入以免覆盖/.test(src));
  ok('接线层有只读降级闸（画像）', /portraitStoreWritable = false[\s\S]{0,600}拒绝写入以免覆盖/.test(src));

  fs.rmSync(dir, { recursive: true, force: true });
}

section('跨会话：日程按会话隔离，画像共享');
{
  const s = { version: 1, reviewDays: {}, entries: [] };
  addEntry(s, { key: 'g:1', date: '今天', period: '上午', text: '群1的事' });
  addEntry(s, { key: 'g:2', date: '今天', period: '上午', text: '群2的事' });
  eq('群1 只看得到自己的', querySchedule(s, { key: 'g:1', scope: 'today' }).total, 1);
  eq('群2 也只看自己的', querySchedule(s, { key: 'g:2', scope: 'today' }).entries[0].text, '群2的事');
  eq('日程注入也隔离', formatScheduleForPrompt(s, { key: 'g:3' }).includes('没有记下什么'), true);

  const p = { version: 1, subjects: {} };
  addPortrait(p, { subject: '主人', facet: 'view', text: '嘴硬心软', weight: 5 });
  eq('画像不按 key 隔离（跨会话共享）', formatPortraitForPrompt(p).includes('嘴硬心软'), true);
  ok('画像注入里没有 key 概念', !formatPortraitForPrompt(p).includes('g:1'));
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
