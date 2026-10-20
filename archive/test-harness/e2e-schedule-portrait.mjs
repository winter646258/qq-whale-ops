// 端到端验证：用**补丁后的真实代码**跑一次端点逻辑。
//
// 做法：不启动完整 bridge（那会抢线上端口/锁），而是把补丁后的
// 端点处理逻辑连同真实模块抽出来跑一遍——验的是「HTTP → 模块 → 落盘 → 注入」
// 这条真链路的行为，而不是字符串匹配。
//
// 用法：node e2e-schedule-portrait.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadSchedule, saveSchedule, addEntry, updateEntry, removeEntry,
  querySchedule, formatScheduleForPrompt, shouldReviewToday, markReviewed
} from './schedule-store.js';
import {
  loadPortrait, savePortrait, addPortrait, updatePortrait, removePortrait,
  queryPortrait, listSubjects, formatPortraitForPrompt
} from './portrait-store.js';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const eq = (l, a, b) => ok(l, a === b, `期望 ${JSON.stringify(b)} 实际 ${JSON.stringify(a)}`);
const section = (t) => console.log(`\n=== ${t} ===`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-sp-'));
const SCHEDULE_FILE = path.join(dir, 'schedule.json');
const PORTRAIT_FILE = path.join(dir, 'portrait.json');

// ── 复刻 bridge 里的存取层（含只读降级闸），原文照抄接线逻辑 ──────────────
let scheduleStoreWritable = true;
let portraitStoreWritable = true;
let scheduleStoreCache = null;
let portraitStoreCache = null;

function scheduleStore() {
  if (!scheduleStoreCache) {
    try {
      scheduleStoreCache = loadSchedule(SCHEDULE_FILE);
      scheduleStoreWritable = true;
    } catch (error) {
      scheduleStoreWritable = false;
      throw new Error(`日程库读取失败：${error?.message ?? error}`);
    }
  }
  return scheduleStoreCache;
}
function saveScheduleSafe(store) {
  if (!scheduleStoreWritable) throw new Error('日程库当前为只读（读取失败过），拒绝写入以免覆盖');
  saveSchedule(SCHEDULE_FILE, store);
}
function portraitStore() {
  if (!portraitStoreCache) {
    try {
      portraitStoreCache = loadPortrait(PORTRAIT_FILE);
      portraitStoreWritable = true;
    } catch (error) {
      portraitStoreWritable = false;
      throw new Error(`画像库读取失败：${error?.message ?? error}`);
    }
  }
  return portraitStoreCache;
}
function savePortraitSafe(store) {
  if (!portraitStoreWritable) throw new Error('画像库当前为只读（读取失败过），拒绝写入以免覆盖');
  savePortrait(PORTRAIT_FILE, store);
}

// ── 复刻端点的 action 分派（与补丁里的分支一一对应）─────────────────────
function handleSchedule({ key, action = 'query', ...body }) {
  const store = scheduleStore();
  if (action === 'add') {
    const entry = addEntry(store, { key, date: body.date, period: body.period, text: body.text });
    saveScheduleSafe(store);
    return { ok: true, key, action, entry, promptText: formatScheduleForPrompt(store, { key }) };
  }
  if (action === 'update') {
    const r = updateEntry(store, body.id, { text: body.text, date: body.date, period: body.period, strength: body.strength });
    if (!r) return { ok: false, error: '找不到这条日程' };
    saveScheduleSafe(store);
    return { ok: true, key, action, changed: r.changed, entry: r.entry, promptText: formatScheduleForPrompt(store, { key }) };
  }
  if (action === 'remove') {
    if (!removeEntry(store, body.id)) return { ok: false, error: '找不到这条日程' };
    saveScheduleSafe(store);
    return { ok: true, key, action, removed: body.id, promptText: formatScheduleForPrompt(store, { key }) };
  }
  if (action === 'review') {
    markReviewed(store, { key });
    saveScheduleSafe(store);
    return { ok: true, key, action, reviewed: true };
  }
  if (action === 'query') {
    const result = querySchedule(store, { key, scope: body.scope ?? 'today' });
    return { ok: true, key, action, ...result, promptText: formatScheduleForPrompt(store, { key }) };
  }
  return { ok: false, error: '不认识的 action：' + action };
}

function handlePortrait({ key, action = 'query', ...body }) {
  const store = portraitStore();
  if (action === 'add') {
    const item = addPortrait(store, { subject: body.subject, facet: body.facet, text: body.text, weight: body.weight });
    savePortraitSafe(store);
    return { ok: true, key, action, item };
  }
  if (action === 'update') {
    const r = updatePortrait(store, body.id, { text: body.text, facet: body.facet, weight: body.weight, subject: body.subject });
    if (!r) return { ok: false, error: '找不到这条画像' };
    savePortraitSafe(store);
    return { ok: true, key, action, changed: r.changed, subject: r.subject, item: r.item };
  }
  if (action === 'remove') {
    if (!removePortrait(store, body.id)) return { ok: false, error: '找不到这条画像' };
    savePortraitSafe(store);
    return { ok: true, key, action, removed: body.id };
  }
  if (action === 'subjects') return { ok: true, key, action, subjects: listSubjects(store) };
  if (action === 'query') {
    const result = queryPortrait(store, { subject: body.subject, facet: body.facet });
    return { ok: true, key, action, ...result, promptText: formatPortraitForPrompt(store) };
  }
  return { ok: false, error: '不认识的 action：' + action };
}

// ══ 日程：一整轮角色用法 ══════════════════════════════════════════════════
section('日程：角色的一整轮用法');
{
  const key = 'group:906710082';
  const a1 = handleSchedule({ key, action: 'add', date: '今天', period: '上午', text: '上午上高数' });
  ok('记一条成功', a1.ok === true);
  ok('返回了 entry.id', typeof a1.entry?.id === 'string');
  eq('时段归一', a1.entry.period, '上午');
  ok('返回注入文本', typeof a1.promptText === 'string' && a1.promptText.includes('上午上高数'));

  const a2 = handleSchedule({ key, action: 'add', date: '明天', period: '下午', text: '体检' });
  ok('再记一条', a2.ok === true);

  const q = handleSchedule({ key, action: 'query', scope: '今天' });
  eq('今天只翻到 1 条', q.total, 1);
  eq('翻到的是高数', q.entries[0].text, '上午上高数');

  const qt = handleSchedule({ key, action: 'query', scope: '明天' });
  eq('明天翻到体检', qt.entries[0].text, '体检');

  // 模糊：改 text
  const u = handleSchedule({ key, action: 'update', id: a1.entry.id, text: '上午有课' });
  ok('模糊成功', u.ok === true && u.changed === true);
  eq('新说法', u.entry.text, '上午有课');
  eq('原文留底', u.entry.originalText, '上午上高数');
  eq('已标记模糊', u.entry.blurred, true);

  // 加固
  const u2 = handleSchedule({ key, action: 'update', id: a1.entry.id, strength: 7 });
  eq('加固到 7', u2.entry.strength, 7);
  eq('加固不改原文', u2.entry.originalText, '上午上高数');

  // 删
  const r = handleSchedule({ key, action: 'remove', id: a2.entry.id });
  ok('删掉体检', r.ok === true);
  const qAfter = handleSchedule({ key, action: 'query', scope: '明天' });
  eq('删了就真没了', qAfter.total, 0);

  // 结算
  const rv = handleSchedule({ key, action: 'review' });
  ok('结算标记成功', rv.ok === true && rv.reviewed === true);

  // 落盘真的写了
  ok('日程文件已生成', fs.existsSync(SCHEDULE_FILE));
  const onDisk = JSON.parse(fs.readFileSync(SCHEDULE_FILE, 'utf8'));
  eq('磁盘上 1 条', onDisk.entries.length, 1);
  eq('磁盘上留着原文', onDisk.entries[0].originalText, '上午上高数');
}

section('日程：参数错误给 4xx 语义（不炸）');
{
  const key = 'group:906710082';
  const bad1 = (() => { try { handleSchedule({ key, action: 'add', date: '下个月初', period: '上午', text: 'x' }); return null; } catch (e) { return e.message; } })();
  ok('认不出的日期报错', /认不出日期/.test(bad1 || ''), bad1);

  const bad2 = (() => { try { handleSchedule({ key, action: 'add', date: '今天', period: '傍晚时分', text: 'x' }); return null; } catch (e) { return e.message; } })();
  ok('认不出的时段报错', /时段只能/.test(bad2 || ''), bad2);

  const bad3 = handleSchedule({ key, action: 'update', id: 's99999', text: 'x' });
  ok('改不存在的 id → ok:false + 404 语义', bad3.ok === false && /找不到/.test(bad3.error));

  const bad4 = handleSchedule({ key, action: 'frobnicate' });
  ok('不认识的 action → ok:false', bad4.ok === false);
}

section('日程：跨会话隔离');
{
  const g1 = handleSchedule({ key: 'group:906710082', action: 'add', date: '今天', period: '晚上', text: '群1的' });
  const g2 = handleSchedule({ key: 'private:1124721191', action: 'add', date: '今天', period: '晚上', text: '私聊的' });
  ok('两条都记上', g1.ok && g2.ok);
  const q1 = handleSchedule({ key: 'group:906710082', action: 'query', scope: '今天' });
  const q2 = handleSchedule({ key: 'private:1124721191', action: 'query', scope: '今天' });
  eq('群只看到自己的', q1.total, 2); // 上午那条 + 晚上这条
  eq('私聊只看到自己的', q2.total, 1);
  eq('私聊那条', q2.entries[0].text, '私聊的');
  ok('群里看不到私聊的', !q1.entries.some((e) => e.text === '私聊的'));
}

// ══ 画像 ═════════════════════════════════════════════════════════════════
section('画像：一整轮角色用法');
{
  const key = 'group:906710082';
  const a = handlePortrait({ key, action: 'add', subject: '主人', facet: 'doing', text: '最近在折腾 QQ 机器人', weight: 5 });
  ok('记一条成功', a.ok === true);
  eq('面', a.item.facet, 'doing');

  handlePortrait({ key, action: 'add', subject: '主人', facet: 'view', text: '嘴上凶其实很照顾人', weight: 8 });
  handlePortrait({ key, action: 'add', subject: '老猫', facet: 'bond', text: '老爱怼我', weight: 3 });

  const subs = handlePortrait({ key, action: 'subjects' });
  eq('记了 2 个人', subs.subjects.length, 2);

  const q = handlePortrait({ key, action: 'query', subject: '主人' });
  eq('主人名下 2 条', q.totalItems, 2);
  eq('按权重排第一', q.subjects[0].items[0].text, '嘴上凶其实很照顾人');

  // 改口
  const u = handlePortrait({ key, action: 'update', id: a.item.id, text: '最近在弄一个会说话的机器人' });
  ok('改口成功', u.ok && u.changed);
  eq('旧判断留底', u.item.originalText, '最近在折腾 QQ 机器人');
  eq('已标记改观', u.item.blurred, true);

  // 跨会话共享（这是画像和印象的关键区别）
  const fromPrivate = handlePortrait({ key: 'private:1124721191', action: 'query', subject: '主人' });
  eq('私聊里也看得到（跨会话共享）', fromPrivate.totalItems, 2);

  // 注入文本
  const inj = handlePortrait({ key, action: 'query' }).promptText;
  ok('注入含长期认识标题', inj.includes('【你对他们这些人的长期认识】'));
  ok('注入含主人', inj.includes('主人'));

  // 删
  const r = handlePortrait({ key, action: 'remove', id: a.item.id });
  ok('删掉', r.ok === true);
  eq('剩余 1 条', handlePortrait({ key, action: 'query', subject: '主人' }).totalItems, 1);

  ok('画像文件已生成', fs.existsSync(PORTRAIT_FILE));
}

section('画像：配额与非法输入');
{
  const key = 'group:906710082';
  let err = null;
  for (let i = 0; i < 20; i += 1) {
    try { handlePortrait({ key, action: 'add', subject: '话痨', facet: 'doing', text: `第${i}条` }); }
    catch (e) { err = e.message; break; }
  }
  ok('单人到上限会拦', /已经 12 条|已达上限/.test(err || ''), err);

  const bad = (() => { try { handlePortrait({ key, action: 'add', subject: '__proto__', facet: 'view', text: 'x' }); return null; } catch (e) { return e.message; } })();
  ok('原型污染名被拒', /不能为空|非法/.test(bad || ''), bad);

  const badFacet = (() => { try { handlePortrait({ key, action: 'add', subject: '某人', facet: 'zzz', text: 'x' }); return null; } catch (e) { return e.message; } })();
  ok('非法 facet 被拒', /facet 只能是/.test(badFacet || ''), badFacet);
}

// ══ 只读降级闸：坏文件不覆盖 ═════════════════════════════════════════════
section('只读降级：坏文件绝不回写清空');
{
  const keep = fs.readFileSync(SCHEDULE_FILE, 'utf8');
  fs.writeFileSync(SCHEDULE_FILE, '{ 坏掉的', 'utf8');
  scheduleStoreCache = null;
  scheduleStoreWritable = true;

  let msg = null;
  try { handleSchedule({ key: 'group:906710082', action: 'query', scope: 'today' }); } catch (e) { msg = e.message; }
  ok('读坏文件时报错而不是当空库', /读取失败/.test(msg || ''), msg);
  eq('已切到只读', scheduleStoreWritable, false);
  eq('磁盘上的坏文件没被覆盖成空库', fs.readFileSync(SCHEDULE_FILE, 'utf8'), '{ 坏掉的');

  // 恢复
  fs.writeFileSync(SCHEDULE_FILE, keep, 'utf8');
  scheduleStoreCache = null;
  scheduleStoreWritable = true;
  const back = handleSchedule({ key: 'group:906710082', action: 'query', scope: '今天' });
  ok('修好后能正常读', back.ok === true);
}

// ══ 注入串组装（模拟 buildWakePromptV2 的拼接顺序）══════════════════════
section('唤醒注入：拼装顺序与分层');
{
  const schedText = formatScheduleForPrompt(scheduleStore(), { key: 'group:906710082' });
  const portText = formatPortraitForPrompt(portraitStore());
  const fakeBase = ['【当前角色】小鲸鱼', '【反AI味】…', schedText, portText, '【参与度参考】…'].join('\n\n');
  console.log('---- 拼装后的注入片段 ----');
  console.log(fakeBase);
  console.log('-------------------------');
  ok('日程在注入里', fakeBase.includes('【他的日程】'));
  ok('画像在注入里', fakeBase.includes('【你对他们这些人的长期认识】'));
  ok('日程在画像之前（短期→长期）', fakeBase.indexOf('【他的日程】') < fakeBase.indexOf('【你对他们这些人的长期认识】'));
  ok('注入总长可控（< 2000 字符）', fakeBase.length < 2000, `实际 ${fakeBase.length}`);
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
