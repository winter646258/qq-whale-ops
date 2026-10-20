// 日程模块单测：纯本地、不碰网络、不碰生产状态。
// 用法：node schedule-store.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PERIODS, localDate, addDays, dayDiff, endOfWeek, normalizeDate, normalizePeriod,
  loadSchedule, saveSchedule, addEntry, updateEntry, removeEntry, querySchedule,
  formatScheduleForPrompt, shouldReviewToday, markReviewed, revealOriginal, touchMentioned
} from './schedule-store.js';

let pass = 0;
let fail = 0;
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${label}`); }
  else { fail += 1; console.log(`  ✖ ${label}${extra ? ' — ' + extra : ''}`); }
};
const eq = (label, actual, expected) => {
  ok(label, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
};
const throws = (label, fn) => {
  try { fn(); ok(label, false, '本应抛错却通过了'); }
  catch { ok(label, true); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ── 时间与日期 ────────────────────────────────────────────────────────────
section('日期归一化');
eq('今天', normalizeDate('今天', '2026-10-20'), '2026-10-20');
eq('明天', normalizeDate('明天', '2026-10-20'), '2026-10-21');
eq('后天', normalizeDate('后天', '2026-10-20'), '2026-10-22');
eq('昨天', normalizeDate('昨天', '2026-10-20'), '2026-10-19');
eq('空 → 今天', normalizeDate('', '2026-10-20'), '2026-10-20');
eq('具体日期直通', normalizeDate('2026-11-01', '2026-10-20'), '2026-11-01');
eq('这周三（10-20 是周二→周三=10-21）', normalizeDate('这周三', '2026-10-20'), '2026-10-21');
eq('周三', normalizeDate('周三', '2026-10-20'), '2026-10-21');
eq('下周一（本周一 10-19 +7 = 10-26）', normalizeDate('下周一', '2026-10-20'), '2026-10-26');
eq('上周五', normalizeDate('上周五', '2026-10-20'), '2026-10-16');
eq('星期天（周日=10-25）', normalizeDate('星期天', '2026-10-20'), '2026-10-25');
eq('认不出的返回 null', normalizeDate('下个月初', '2026-10-20'), null);
eq('非法日期返回 null', normalizeDate('2026-02-30', '2026-10-20'), null);

section('时段归一化');
eq('空 → 上午', normalizePeriod(''), '上午');
eq('下午', normalizePeriod('下午'), '下午');
eq('晚上', normalizePeriod('晚上'), '晚上');
eq('夜里 → 晚上', normalizePeriod('夜里'), '晚上');
eq('早上 → 上午', normalizePeriod('早上'), '上午');
eq('中午 → 下午', normalizePeriod('中午'), '下午');
eq('认不出的返回 null', normalizePeriod('傍晚时分模糊'), null);
eq('三个时段固定', PERIODS.join('/'), '上午/下午/晚上');

section('周界与天数差');
eq('10-20 是周二，周日=10-25', endOfWeek('2026-10-20'), '2026-10-25');
eq('周日自己=当天', endOfWeek('2026-10-25'), '2026-10-25');
eq('跨月 +1', addDays('2026-10-31', 1), '2026-11-01');
eq('天数差', dayDiff('2026-10-22', '2026-10-20'), 2);

// ── 增删改 ────────────────────────────────────────────────────────────────
section('记一条');
{
  const store = loadSchedule(path.join(os.tmpdir(), 'no-such-schedule-file.json'));
  ok('不存在的文件 → 空库（不报错）', store.entries.length === 0);
  eq('空库 reviewDays 为空对象', Object.keys(store.reviewDays).length, 0);

  const e = addEntry(store, { key: 'g:1', date: '明天', period: '下午', text: '体检' });
  eq('日期归一到明天', e.date, addDays(localDate(), 1));
  eq('时段', e.period, '下午');
  eq('原文', e.text, '体检');
  eq('初始未模糊', e.blurred, false);
  eq('初始强度 1', e.strength, 1);
  eq('无原文底', e.originalText, null);
  ok('id 形如 s+5位', /^s[0-9a-f]{5}$/.test(e.id), `实际 ${e.id}`);
  eq('带上了 key', e.key, 'g:1');

  throws('内容为空要报错', () => addEntry(store, { date: '今天', period: '上午', text: '   ' }));
  throws('认不出的日期要报错', () => addEntry(store, { date: '下个月初', period: '上午', text: 'x' }));
  throws('认不出的时段要报错', () => addEntry(store, { date: '今天', period: '半晌午前后', text: 'x' }));
}

section('模糊是改写，不是删除');
{
  const store = loadSchedule(path.join(os.tmpdir(), 'no-such-2.json'));
  const e = addEntry(store, { date: '今天', period: '上午', text: '上午上高数' });

  const r1 = updateEntry(store, e.id, { text: '上午有课' });
  ok('改到了', r1 && r1.changed === true);
  eq('新文本', e.text, '上午有课');
  eq('原文留底', e.originalText, '上午上高数');
  eq('标记为已模糊', e.blurred, true);

  const r2 = updateEntry(store, e.id, { text: '上午好像有课' });
  ok('二次改写也算改', r2 && r2.changed === true);
  eq('底仍是最原始那份', e.originalText, '上午上高数');
  eq('当前文本是最新', e.text, '上午好像有课');

  const r3 = updateEntry(store, e.id, { text: '上午好像有课' });
  ok('同文改写不算变更', r3 && r3.changed === false);

  const r4 = updateEntry(store, e.id, { period: '下午' });
  ok('只改时段算变更', r4 && r4.changed === true);
  eq('时段已改', e.period, '下午');
  eq('只挪位置不新增模糊底', e.originalText, '上午上高数');
  eq('blurred 保持', e.blurred, true);

  const r5 = updateEntry(store, e.id, { strength: 5 });
  eq('加固到 5', e.strength, 5);
  ok('加固算变更', r5.changed === true);
  updateEntry(store, e.id, { strength: 99 });
  eq('强度封顶 9', e.strength, 9);
  updateEntry(store, e.id, { strength: -3 });
  eq('强度下限 1', e.strength, 1);

  const miss = updateEntry(store, 's00000', { text: 'x' });
  eq('改不存在的 id → null', miss, null);

  const revealed = revealOriginal(store, e.id);
  eq('管理员能翻到底', revealed.originalText, '上午上高数');
  eq('角色看到的是新的', revealed.text, '上午好像有课');
}

section('删是真删');
{
  const store = loadSchedule(path.join(os.tmpdir(), 'no-such-3.json'));
  const a = addEntry(store, { date: '今天', period: '上午', text: 'A' });
  const b = addEntry(store, { date: '今天', period: '下午', text: 'B' });
  eq('删掉一条', removeEntry(store, a.id), true);
  eq('剩 1 条', store.entries.length, 1);
  eq('删不存在的返回 false', removeEntry(store, 's99999'), false);
  eq('删的是对的', store.entries[0].id, b.id);
  eq('删掉就真没了（原文也没了）', revealOriginal(store, a.id), null);
}

// ── 查询 ──────────────────────────────────────────────────────────────────
section('翻日程');
{
  const now = new Date(2026, 9, 20, 10, 0, 0); // 2026-10-20 周二
  const store = { version: 1, reviewDays: {}, entries: [] };
  const mk = (k, date, period, text) => addEntry(store, { key: k, date, period, text, now: now.getTime() });
  mk('g:1', '2026-10-19', '上午', '昨天的事');
  mk('g:1', '2026-10-20', '上午', '高数课');
  mk('g:1', '2026-10-21', '下午', '体检');
  mk('g:1', '2026-10-25', '晚上', '周日尾巴');
  mk('g:1', '2026-10-26', '上午', '下周一');
  mk('g:1', '2026-11-10', '上午', '很远的');
  mk('g:2', '2026-10-20', '晚上', '别的会话');

  const q = (scope, key = 'g:1') => querySchedule(store, { key, scope, now });

  eq('今天（按 key 隔离）', q('today').total, 1);
  eq('今天条目文本', q('today').entries[0].text, '高数课');
  eq('明天', q('tomorrow').total, 1);
  // 10-20(今) / 10-21 / 10-25(周日)，10-19 属于过去不算本周
  eq('这周（今天到周日）', q('week').total, 3);
  eq('以后（周日之后）', q('later').total, 2);
  eq('过去', q('past').total, 1);
  eq('今天起', q('upcoming').total, 5);
  eq('全部（含过去）', q('all').total, 6);
  eq('具体日期', q('2026-10-21').total, 1);
  eq('中文别名 明天', q('明天').total, 1);
  ok('不认识的 scope 抛错', (() => { try { q('上个世纪'); return false; } catch { return true; } })());
  eq('排序：日期升序后时段升序', q('all').entries.map((e) => e.period).join(','), '上午,上午,下午,晚上,上午,上午');
}

// ── 注入分层 ──────────────────────────────────────────────────────────────
section('注入要分层');
{
  const now = new Date(2026, 9, 20, 10, 0, 0);
  const store = { version: 1, reviewDays: {}, entries: [] };
  const mk = (date, period, text) => addEntry(store, { key: 'g:1', date, period, text, now: now.getTime() });
  mk('2026-10-20', '上午', '高数课');
  mk('2026-10-21', '下午', '体检');
  mk('2026-10-22', '上午', '本周四的');
  mk('2026-10-25', '晚上', '本周日的');
  mk('2026-10-26', '上午', '下周的');
  mk('2026-11-30', '上午', '很远的');
  mk('2026-10-19', '上午', '过去的');

  const text = formatScheduleForPrompt(store, { key: 'g:1', now });
  console.log('---- 注入样例 ----');
  console.log(text);
  console.log('-------------------');

  ok('带标题与当前时间', text.includes('【他的日程】现在是 10 月 20 日 10:00'));
  ok('今天写清楚', text.includes('- 今天 上午：高数课'));
  ok('明天写清楚', text.includes('- 明天 下午：体检'));
  ok('本周后面只报数量（2 条）', text.includes('- 这周还有 2 条'), '实际:' + text);
  ok('更远只报总数（2 条）', text.includes('- 以后还有 2 条'));
  ok('过去的日程不进注入', !text.includes('过去的'));
  ok('未来的不逐条列出', !text.includes('本周四的') && !text.includes('下周的'));

  const empty = formatScheduleForPrompt({ entries: [] }, { key: 'g:1', now });
  ok('空的时候说清楚', empty.includes('今天和明天没有记下什么。'));

  const other = formatScheduleForPrompt(store, { key: 'g:9', now });
  ok('按 key 隔离，别的会话看不到', other.includes('今天和明天没有记下什么。'));
}

section('提及时间');
{
  const store = loadSchedule(path.join(os.tmpdir(), 'no-such-4.json'));
  const a = addEntry(store, { date: '今天', period: '上午', text: 'A' });
  eq('初始未提及', a.lastMentionedAt, 0);
  eq('标记 1 条', touchMentioned(store, [a.id], 1792420000000), 1);
  eq('已记录', a.lastMentionedAt, 1792420000000);
  eq('标记不存在的 = 0', touchMentioned(store, ['s99999'], 1), 0);
}

// ── 结算提醒 ──────────────────────────────────────────────────────────────
section('结算机制：只是提醒，不强制');
{
  const store = { version: 1, reviewDays: {}, entries: [] };
  const midnight = new Date(2026, 9, 20, 2, 0, 0);
  const four = new Date(2026, 9, 20, 4, 0, 0);

  eq('凌晨 2 点不念叨（4 点前）', shouldReviewToday(store, { key: 'g:1', now: midnight }), false);
  eq('4 点后可以提醒', shouldReviewToday(store, { key: 'g:1', now: four }), true);
  markReviewed(store, { key: 'g:1', now: four });
  eq('当天记过就不再提醒', shouldReviewToday(store, { key: 'g:1', now: four }), false);
  eq('marked day', store.reviewDays['g:1'], '2026-10-20');
  eq('别的会话当天照常提醒', shouldReviewToday(store, { key: 'g:2', now: four }), true);
  eq('第二天又是新的', shouldReviewToday(store, { key: 'g:1', now: new Date(2026, 9, 21, 9, 0, 0) }), true);
  // 原则一：不做「按天数自动降级/自动糊/自动删」——系统只给工具和事实。
  // 这里断言的是**代码里没有自动改状态的入口**（注释里出现这些词是另一回事）。
  const mod = fs.readFileSync(new URL('./schedule-store.js', import.meta.url), 'utf8');
  ok('没有自动降级/自动糊的函数', !/export function (auto|sweep|decay|prune)\w*/i.test(mod));
  ok('没有定时器在后台自动改日程', !/setInterval|setTimeout/.test(mod));
  ok('没有任何「按天数」改 blurred 的赋值', !/blurred\s*=\s*[^;]*dayDiff|dayDiff[^;]*blurred\s*=/.test(mod));
}

// ── 落盘 ──────────────────────────────────────────────────────────────────
section('落盘与损坏处理');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sched-test-'));
  const file = path.join(dir, 'schedule.json');
  const store = { version: 1, reviewDays: {}, entries: [] };
  addEntry(store, { key: 'g:1', date: '今天', period: '上午', text: '写盘测试' });
  addEntry(store, { key: 'g:1', date: '今天', period: '晚上', text: '第二条' });
  store.entries[0].originalText = '上午上高数';
  store.entries[0].blurred = true;
  markReviewed(store, { key: 'g:1', now: new Date(2026, 9, 20, 5, 0, 0) });
  saveSchedule(file, store);

  const back = loadSchedule(file);
  eq('条数一致', back.entries.length, 2);
  eq('原文底保留', back.entries[0].originalText, '上午上高数');
  eq('模糊标记保留', back.entries[0].blurred, true);
  eq('结算日保留', back.reviewDays['g:1'], '2026-10-20');

  // POSIX 下 mode 才是权限位；Windows 上 Node 的 chmod 是近似语义，不参与断言。
  if (process.platform !== 'win32') {
    const mode = (fs.statSync(file).mode & 0o777).toString(8);
    eq('文件权限 600', mode, '600');
  } else {
    ok('Windows 跳过权限位断言（POSIX 上由部署脚本核验）', true);
  }

  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  throws('损坏的库要抛错（不能当空库）', () => loadSchedule(file));

  fs.rmSync(dir, { recursive: true, force: true });
}

// ── 上限 ──────────────────────────────────────────────────────────────────
section('容量与截断');
{
  const store = { version: 1, reviewDays: {}, entries: [] };
  const long = 'x'.repeat(500);
  const e = addEntry(store, { date: '今天', period: '上午', text: long });
  eq('超长内容截断到 120', e.text.length, 120);
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
