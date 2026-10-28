// 谈资（世界层 C-2）的用例：纯逻辑 + 注入行为 + 接线静态检查
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  TOPICS_DEFAULTS,
  topicsCfg,
  dueTopicSlot,
  markTopicSlot,
  addTopics,
  pruneTopics,
  topicsLine,
  summarizeTopics,
  buildTopicAsk,
  parseTopicJSON,
  normalizeTopic,
  cleanText,
} from '../src/topics.js';

let pass = 0;
let fail = 0;
const cases = [];
function t(name, fn) { cases.push([name, fn]); }
function eq(a, b, msg) { assert.deepEqual(a, b, msg); }
function ok(v, msg) { assert.ok(v, msg); }

const T0 = new Date('2026-10-28T10:05:00+08:00').getTime();
const at = (h, m = 0) => new Date(`2026-10-28T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+08:00`).getTime();

// ---------- 配置 ----------
t('默认配置', () => {
  const c = topicsCfg(null);
  eq(c.enabled, true);
  eq(c.slots, [10, 16]);
  eq(c.maxInject, 2);
  eq(c.keepDays, 3);
});

t('配置脏值回落（null 不能变 0）', () => {
  const c = topicsCfg({ socialV2: { topics: { slots: [null, 'x', 12], keepDays: null, maxInject: '', titleChars: 3 } } });
  eq(c.slots, [12]);
  eq(c.keepDays, TOPICS_DEFAULTS.keepDays);
  eq(c.maxInject, TOPICS_DEFAULTS.maxInject);
  eq(c.titleChars, 4);
});

t('enabled 只认 false', () => {
  eq(topicsCfg({ socialV2: { topics: { enabled: false } } }).enabled, false);
  eq(topicsCfg({ socialV2: { topics: { enabled: 'no' } } }).enabled, true);
});

t('slots 去重排序、越界剔除', () => {
  eq(topicsCfg({ socialV2: { topics: { slots: [16, 10, 16, 99, -1] } } }).slots, [10, 16]);
});

// ---------- 该不该挑 ----------
t('9 点还没到点', () => {
  eq(dueTopicSlot({}, { now: at(9), cfg: topicsCfg(null) }), null);
});

t('10 点过点且没做过 → due 10', () => {
  const s = dueTopicSlot({}, { now: at(10, 5), cfg: topicsCfg(null) });
  eq(s.slot, 10);
  eq(s.day, '2026-10-28');
});

t('今天 10 点做过了 → 不再 due 10', () => {
  const store = markTopicSlot({}, { day: '2026-10-28', slot: 10, now: T0 });
  eq(dueTopicSlot(store, { now: at(11), cfg: topicsCfg(null) }), null);
});

t('15 点：错过 10 点不补，等 16 点', () => {
  eq(dueTopicSlot({}, { now: at(15), cfg: topicsCfg(null) }), null);
});

t('17 点：取最后一个已过点（16）', () => {
  eq(dueTopicSlot({}, { now: at(17), cfg: topicsCfg(null) }).slot, 16);
});

t('两个点都做过 → 不 due', () => {
  let store = markTopicSlot({}, { day: '2026-10-28', slot: 10, now: T0 });
  store = markTopicSlot(store, { day: '2026-10-28', slot: 16, now: at(16) });
  eq(dueTopicSlot(store, { now: at(20), cfg: topicsCfg(null) }), null);
});

t('关掉就不 due', () => {
  eq(dueTopicSlot({}, { now: at(11), cfg: topicsCfg({ socialV2: { topics: { enabled: false } } }) }), null);
});

// ---------- 记账 ----------
t('记账只留最近三天', () => {
  let store = {};
  for (const d of ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23']) {
    store = markTopicSlot(store, { day: d, slot: 10, now: T0 });
  }
  eq(Object.keys(store.days).sort(), ['2026-10-21', '2026-10-22', '2026-10-23']);
});

t('markTopicSlot 不破坏已有结构', () => {
  const store = markTopicSlot({ version: 1, items: [{ title: 'x', at: T0 }] }, { day: '2026-10-28', slot: 10, now: T0 });
  eq(store.items.length, 1);
  eq(store.version, 1);
});

// ---------- 文本清洗 ----------
t('cleanText 压空白并截断', () => {
  eq(cleanText('  你好   世界  ', 20), '你好 世界');
  ok(cleanText('一二三四五六', 4).endsWith('…'));
});

t('normalizeTopic 认多个字段名', () => {
  const a = normalizeTopic({ title: '天冷了', summary: '想给她煮点热的' });
  eq(a.title, '天冷了');
  const b = normalizeTopic({ topic: '天冷了', text: '想给她煮点热的' });
  eq(b.title, '天冷了');
  const c = normalizeTopic({ name: '天冷了', note: '想给她煮点热的' });
  eq(c.summary, '想给她煮点热的');
});

t('normalizeTopic 没标题就丢', () => {
  eq(normalizeTopic({ summary: '只有摘要' }), null);
  eq(normalizeTopic(null), null);
  eq(normalizeTopic('字符串'), null);
});

t('normalizeTopic 默认 kind', () => {
  eq(normalizeTopic({ title: 'x' }).kind, '自己想的');
});

// ---------- 入库 ----------
t('addTopics 新的在前', () => {
  const { store, added } = addTopics({}, [{ title: 'A' }, { title: 'B' }], { now: T0, cfg: topicsCfg(null) });
  eq(added, 2);
  eq(store.items.map((x) => x.title), ['B', 'A']);
});

t('addTopics 同标题去重', () => {
  const first = addTopics({}, [{ title: 'A' }], { now: T0, cfg: topicsCfg(null) }).store;
  const second = addTopics(first, [{ title: 'A' }], { now: T0 + 1000, cfg: topicsCfg(null) });
  eq(second.added, 0);
  eq(second.store.items.length, 1);
});

t('addTopics 超上限裁掉最老', () => {
  const cfg = { ...topicsCfg(null), maxItems: 2 };
  const { store } = addTopics({}, [{ title: 'A' }, { title: 'B' }, { title: 'C' }], { now: T0, cfg });
  eq(store.items.length, 2);
  ok(!store.items.some((x) => x.title === 'A'));
});

t('addTopics 脏输入不炸', () => {
  const { store, added } = addTopics({}, [null, 'x', { title: '' }, { title: 'ok' }], { now: T0, cfg: topicsCfg(null) });
  eq(added, 1);
  eq(store.items[0].title, 'ok');
});

// ---------- 过期 ----------
t('pruneTopics 丢掉三天前的', () => {
  const day = 86400000;
  const store = { items: [{ title: '旧', at: T0 - 5 * day }, { title: '新', at: T0 }] };
  eq(pruneTopics(store, { now: T0, cfg: topicsCfg(null) }).items.map((x) => x.title), ['新']);
});

t('pruneTopics 脏 items 不炸', () => {
  eq(pruneTopics({ items: [null, {}, { title: 'x', at: T0 }] }, { now: T0, cfg: topicsCfg(null) }).items.length, 1);
});

// ---------- 注入 ----------
t('被动回话不注入', () => {
  const store = addTopics({}, [{ title: 'A', summary: 's' }], { now: T0, cfg: topicsCfg(null) }).store;
  eq(topicsLine(store, { now: T0, cfg: topicsCfg(null), isProactive: false }), '');
});

t('主动开口才注入，带前缀与活口', () => {
  const store = addTopics({}, [{ title: '天冷了', summary: '想煮点热的' }], { now: T0, cfg: topicsCfg(null) }).store;
  const line = topicsLine(store, { now: T0, cfg: topicsCfg(null), isProactive: true });
  ok(line.startsWith('【今天可以聊的】'));
  ok(line.includes('天冷了——想煮点热的'));
  ok(line.includes('不用硬提'));
});

t('maxInject 0 时不注入', () => {
  const cfg = { ...topicsCfg(null), maxInject: 0 };
  const store = addTopics({}, [{ title: 'A' }], { now: T0, cfg }).store;
  eq(topicsLine(store, { now: T0, cfg, isProactive: true }), '');
});

t('过期的谈资不注入', () => {
  const day = 86400000;
  const store = { items: [{ title: '旧', at: T0 - 5 * day }] };
  eq(topicsLine(store, { now: T0, cfg: topicsCfg(null), isProactive: true }), '');
});

t('没摘要只给标题', () => {
  const store = addTopics({}, [{ title: 'A' }], { now: T0, cfg: topicsCfg(null) }).store;
  const line = topicsLine(store, { now: T0, cfg: topicsCfg(null), isProactive: true });
  ok(line.includes('A。'));
  ok(!line.includes('——'));
});

// ---------- 摘要 ----------
t('summarizeTopics 给最近三条标题', () => {
  const store = addTopics({}, [{ title: 'A' }, { title: 'B' }, { title: 'C' }, { title: 'D' }], { now: T0, cfg: topicsCfg(null) }).store;
  const s = summarizeTopics(store, { now: T0, cfg: topicsCfg(null) });
  ok(s.includes('D'));
  ok(!s.includes('A'));
});

t('summarizeTopics 空库返回空串', () => {
  eq(summarizeTopics({}, { now: T0, cfg: topicsCfg(null) }), '');
});

// ---------- 提示词 ----------
t('buildTopicAsk 含关键约束', () => {
  const ask = buildTopicAsk({ hour: 10, recent: '旧的一、旧的二', cfg: topicsCfg(null) });
  ok(ask.includes('不要在聊天里回复'));
  ok(ask.includes('不联网'));
  ok(ask.includes('旧的一、旧的二'));
  ok(ask.includes('{"title":"…","summary":"…"}'));
  ok(ask.length <= TOPICS_DEFAULTS.askChars + 40);
});

t('buildTopicAsk 下午措辞', () => {
  ok(buildTopicAsk({ hour: 16, cfg: topicsCfg(null) }).includes('下午'));
  ok(buildTopicAsk({ hour: 10, cfg: topicsCfg(null) }).includes('上午'));
});

// ---------- 解析 ----------
t('parseTopicJSON 纯 JSON', () => {
  eq(parseTopicJSON('{"title":"天冷了","summary":"想煮点热的"}').title, '天冷了');
});

t('parseTopicJSON 带代码块', () => {
  eq(parseTopicJSON('```json\n{"title":"A"}\n```').title, 'A');
});

t('parseTopicJSON 前后有废话', () => {
  eq(parseTopicJSON('好，我挑一个：\n{"title":"A","summary":"s"}\n就这样').title, 'A');
});

t('parseTopicJSON 坏输入返回 null', () => {
  eq(parseTopicJSON(''), null);
  eq(parseTopicJSON('没有 JSON'), null);
  eq(parseTopicJSON('[1,2]'), null);
  eq(parseTopicJSON('null'), null);
});

t('parseTopicJSON 越界字段被裁', () => {
  const long = '字'.repeat(200);
  const t2 = parseTopicJSON(JSON.stringify({ title: long, summary: long }));
  ok(t2.title.length <= 24);
  ok(t2.summary.length <= 60);
});

// ---------- 接线静态检查 ----------
const bridge = fs.readFileSync(path.join(process.cwd(), 'src/bridge.js'), 'utf8');
t('bridge 有 import', () => { ok(bridge.includes("} from './topics.js';")); });
t('三个运行时 MARKER 都在', () => {
  for (const m of ['world-c2-store', 'world-c2-boot', 'world-c2-inject']) {
    ok(bridge.includes('MARKER: ' + m), m);
  }
});
t('base 拼接里包含 topicsText', () => { ok(bridge.includes('datesText + topicsText + imageLine')); });
t('定时器被 unref（不拖住进程）', () => { ok(bridge.includes('topicsTimer.unref?.()')); });
t('慢渠道时不抢算力', () => { ok(bridge.includes("log('[谈资] 当前在兜底渠道，今天就先不挑')")); });

for (const [name, fn] of cases) {
  try {
    fn();
    pass += 1;
  } catch (error) {
    fail += 1;
    console.log(`✗ ${name}\n   ${error.message}`);
  }
}
console.log(`谈资：${pass} 项通过，${fail} 项失败`);
process.exit(fail ? 1 : 0);
