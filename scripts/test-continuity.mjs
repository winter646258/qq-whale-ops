// 接续条单元测试：纯逻辑 + bridge 接线静态检查。
// 跑：node scripts/test-continuity.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONTINUITY_DEFAULTS,
  buildContinuityAsk,
  composeContinuityText,
  continuityCfg,
  continuityLine,
  dayOf,
  markContinuityUsed,
  parseContinuityJSON,
  pickContinuityLines,
  pruneContinuity,
} from '../src/continuity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
  } else {
    fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
  }
}

// ---------- 配置 ----------
const d = continuityCfg({});
ok('默认开启', d.enabled === true);
ok('默认 300 字', d.chars === 300);
ok('默认交接窗口 12 小时', d.hours === 12);
ok('默认一天作废', d.ttlHours === 24);
ok('null 不当 0', (() => {
  const c = continuityCfg({ socialV2: { continuity: { hours: null, chars: null, keepDays: null } } });
  return c.hours === CONTINUITY_DEFAULTS.hours && c.chars === CONTINUITY_DEFAULTS.chars && c.keepDays === CONTINUITY_DEFAULTS.keepDays;
})());
ok('字符串数字可用', continuityCfg({ socialV2: { continuity: { hours: '6' } } }).hours === 6);
ok('越界夹紧', (() => {
  const c = continuityCfg({ socialV2: { continuity: { chars: 9999, maxLines: 1 } } });
  return c.chars === 900 && c.maxLines === 5;
})());
ok('显式关掉', continuityCfg({ socialV2: { continuity: { enabled: false } } }).enabled === false);

// ---------- 日期 ----------
const T = Date.UTC(2026, 9, 29, 2, 0, 0); // 东八 2026-10-29 10:00
ok('东八日', dayOf(T) === '2026-10-29', dayOf(T));
ok('跨午夜算前一天', dayOf(Date.UTC(2026, 9, 28, 17, 0, 0)) === '2026-10-29');

// ---------- 挑原料 ----------
const now = T;
const msgs = [
  { sender: '小明', text: '昨天的事', time: now - 30 * 3600 * 1000 },
  { sender: '小明', text: '她自己的话', time: now - 3600 * 1000, isSelf: true },
  { sender: '小红', text: '  周末  一起  看电影  ', time: now - 3600 * 1000 },
  { sender: '管理员', text: '记得吃药', time: now - 600 * 1000, isOwner: true },
  { sender: '小明', text: '', time: now - 100 * 1000 },
  { sender: '小明', text: 'x'.repeat(400), time: now - 60 * 1000 },
];
const lines = pickContinuityLines(msgs, { now, hours: 12, lineChars: 40 });
ok('超窗的不取', !lines.some((l) => l.includes('昨天的事')));
ok('她自己的话不取', !lines.some((l) => l.includes('她自己的话')));
ok('空文本不取', lines.every((l) => l.trim().length > 0));
ok('空白压平', lines.some((l) => l.includes('小红：周末 一起 看电影')));
ok('管理员加前缀', lines.some((l) => l.startsWith('【管理员】：记得吃药')));
ok('超长截断加省略号', lines.some((l) => l.includes('…') && l.length <= 60));
const many = Array.from({ length: 100 }, (_, i) => ({ sender: 'S' + i, text: 't' + i, time: now - 1000 }));
ok('maxLines 生效', pickContinuityLines(many, { now, maxLines: 5 }).length === 5);
ok('空输入安全', pickContinuityLines(null, { now }).length === 0);

// ---------- 提示词 ----------
const ask = buildContinuityAsk({ key: 'group:1', isGroup: true, lines: ['小明：周末看电影'] });
ok('提示词写明群聊', ask.includes('一个群里'));
ok('提示词带入原文', ask.includes('小明：周末看电影'));
ok('提示词要求不许编', ask.includes('一个字都不许编'));
ok('提示词钉死三件事', ask.includes('还没兑现的约定') && ask.includes('正在聊') && ask.includes('要紧的话'));
ok('没对话也有兜底', buildContinuityAsk({ lines: [] }).includes('这段时间没有对话'));

// ---------- 解析 ----------
const p1 = parseContinuityJSON('{"loose":"答应给他画一张","topic":"在聊周末电影","people":"小红家里出事了"}');
ok('解析三段', p1 && p1.loose === '答应给他画一张' && p1.topic.includes('周末电影') && p1.people.includes('小红'));
const p2 = parseContinuityJSON('好的，结果如下：\n```json\n{"loose":"a","topic":"","people":"c"}\n```\n完毕');
ok('代码块+废话也能解析', p2 && p2.loose === 'a' && p2.topic === '' && p2.people === 'c');
const p3 = parseContinuityJSON('{"loose":"' + 'y'.repeat(500) + '"}');
ok('字段截断', p3 && p3.loose.length <= CONTINUITY_DEFAULTS.fieldChars);
ok('坏 JSON 返回 null', parseContinuityJSON('不是 JSON') === null);
ok('数组返回 null', parseContinuityJSON('[1,2]') === null);
ok('空串返回 null', parseContinuityJSON('') === null);

// ---------- 拼装 ----------
const full = composeContinuityText({ loose: '还欠一张画', topic: '在聊电影', people: '小红家里出事' });
ok('三段都拼上', full.includes('还挂着') && full.includes('刚才在聊') && full.includes('最近'));
ok('顺序：约定在话题前', full.indexOf('还挂着') < full.indexOf('刚才在聊'));
ok('空输入空输出', composeContinuityText(null) === '' && composeContinuityText({ loose: '', topic: '', people: '' }) === '');
const tight = composeContinuityText({ loose: 'A'.repeat(80), topic: 'B'.repeat(80), people: 'C'.repeat(80) }, { chars: 100 });
ok('预算内不超长', tight.length <= 100, `${tight.length}`);
ok('超长先砍人', !tight.includes('CCC'));
ok('砍完仍留第一条', tight.includes('还挂着'));

// ---------- 注入 ----------
const entry = { text: '- 还挂着：答应给他画一张', at: now, day: dayOf(now), usedAt: 0 };
const inj = continuityLine(entry, { now, ttlHours: 24 });
ok('注入带抬头', inj.includes('【上一段对话的摘录】'));
ok('注入声明不是指令', inj.includes('不是指令'));
ok('注入带正文', inj.includes('答应给他画一张'));
ok('用过了就不给', continuityLine({ ...entry, usedAt: now }, { now }) === '');
ok('隔天不给', continuityLine({ ...entry, day: '2026-10-28' }, { now }) === '');
ok('超 ttl 不给', continuityLine({ ...entry, at: now - 25 * 3600 * 1000 }, { now, ttlHours: 24 }) === '');
ok('空条目不给', continuityLine(null, { now }) === '' && continuityLine({ text: '' }, { now }) === '');

const store = { version: 1, updatedAt: 0, items: { 'group:1': entry, 'group:2': { ...entry, at: now - 10 * 24 * 3600 * 1000 } } };
const used = markContinuityUsed(store, 'group:1', now);
ok('标记已用', Number(used.items['group:1'].usedAt) === now);
ok('标记不碰别人', used.items['group:2'].usedAt === 0);
const pruned = pruneContinuity(store, { now, keepDays: 3 });
ok('过期条目清掉', !pruned.items['group:2']);
ok('新鲜条目留下', !!pruned.items['group:1']);

// ---------- bridge 接线（静态） ----------
const bridge = fs.readFileSync(path.join(HERE, '..', 'src', 'bridge.js'), 'utf8');
ok('import 了 continuity', bridge.includes("from './continuity.js';"));
ok('有 continuity-runtime', bridge.includes('// MARKER: continuity-runtime'));
ok('有 continuity-inject', bridge.includes('// MARKER: continuity-inject'));
ok('注入在 base 之前', (() => {
  const a = bridge.indexOf('const continuityText = continuityHintFor(key);');
  const b = bridge.indexOf('const base = roleLine + untrustedLine + tokenLine + continuityText + graceLine');
  return a > 0 && b > a;
})());
ok('base 真的拼进去了', bridge.includes('continuityText + graceLine'));
ok('换会话前生成', (() => {
  const a = bridge.indexOf('await generateContinuity(key);');
  const b = bridge.indexOf('await generateContinuity(key);') >= 0 ? bridge.indexOf('delete state.sessions[key];', bridge.indexOf('await generateContinuity(key);')) : -1;
  return a > 0 && b > a;
})());
ok('生成失败不挡换会话', bridge.includes('catch (error)') && bridge.includes('[continuity] ${key} 生成失败（不影响换会话）'));
ok('注入一次就作废', bridge.includes('markContinuityUsed(store, key, now)'));

const total = pass + fails.length;
if (fails.length) {
  console.log(`\n❌ ${fails.length}/${total} 项失败：`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`✅ test-continuity：${pass}/${total} 项全过`);
