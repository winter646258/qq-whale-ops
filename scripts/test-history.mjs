// 存档 + 回忆的单元测试：纯逻辑 + bridge/MCP 接线静态检查。
// 跑：node scripts/test-history.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HISTORY_DEFAULTS,
  archivePath,
  bigrams,
  clampDays,
  decodeLine,
  encodeRecord,
  formatRecall,
  historyCfg,
  monthOf,
  overlapScore,
  queryArchive,
  stampOf,
  toRecord,
} from '../src/history-archive.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
const fails = [];
function ok(name, cond, extra) {
  if (cond) pass += 1;
  else fails.push(`${name}${extra ? ` —— ${extra}` : ''}`);
}

// ---------- 配置 ----------
const d = historyCfg({});
ok('默认开启', d.enabled === true);
ok('默认查 7 天', d.defaultDays === 7);
ok('默认最多 20 条', d.maxResults === 20);
ok('null 不当 0', (() => {
  const c = historyCfg({ socialV2: { history: { defaultDays: null, maxResults: null } } });
  return c.defaultDays === 7 && c.maxResults === 20;
})());
ok('字符串数字可用', historyCfg({ socialV2: { history: { defaultDays: '3' } } }).defaultDays === 3);
ok('越界夹紧', (() => {
  const c = historyCfg({ socialV2: { history: { maxResults: 999, defaultDays: 1 } } });
  return c.maxResults === 60 && c.defaultDays === 1;
})());
ok('显式关掉', historyCfg({ socialV2: { history: { enabled: false } } }).enabled === false);

// ---------- 月份 / 路径 ----------
const T = Date.UTC(2026, 9, 29, 2, 0, 0); // 东八 2026-10-29 10:00
ok('东八月', monthOf(T) === '2026-10', monthOf(T));
ok('跨月按东八算', monthOf(Date.UTC(2026, 9, 31, 17, 0, 0)) === '2026-11');
ok('路径拼装', archivePath('/opt/qq-bridge/state/history', '2026-10') === '/opt/qq-bridge/state/history/2026-10.jsonl');
ok('末尾斜杠不重复', archivePath('/a/', '2026-10') === '/a/2026-10.jsonl');
ok('烂月份拒绝', archivePath('/a', '2026-1x') === '' && archivePath('/a', '') === '');

// ---------- 记录 ----------
const rec = toRecord('group:1', { sender: '浮浮', text: '  周末  一起  看电影 ', time: T, isSelf: false });
ok('造记录', rec && rec.key === 'group:1' && rec.who === '浮浮');
ok('压空白', rec.text === '周末 一起 看电影');
ok('空文本拒绝', toRecord('group:1', { text: '   ' }) === null && toRecord('group:1', null) === null);
ok('她自己标「她」', toRecord('group:1', { text: 'x', isSelf: true }).who === '她');
ok('主人标「管理员」', toRecord('group:1', { text: 'x', isOwner: true }).who === '管理员');
ok('超长截断', (() => {
  const r = toRecord('group:1', { text: 'y'.repeat(500) });
  return r.text.length <= HISTORY_DEFAULTS.lineChars && r.text.endsWith('…');
})());
const line = encodeRecord(rec);
ok('编码是单行 JSON', line.startsWith('{') && !line.includes('\n'));
const back = decodeLine(line);
ok('往返一致', back.text === rec.text && back.who === rec.who && back.t === rec.t);
ok('坏行返回 null', decodeLine('') === null && decodeLine('not json') === null && decodeLine('[1]') === null);
ok('缺时间返回 null', decodeLine('{"text":"x"}') === null);
ok('缺正文返回 null', decodeLine('{"t":1,"text":"  "}') === null);

// ---------- 双字词 ----------
const g = bigrams('周末看电影');
ok('双字词切分', g.has('周末') && g.has('末看') && g.has('电影') && g.size === 4);
ok('空串无边', bigrams('').size === 0);
ok('单字无边', bigrams('猫').size === 0);
ok('整串命中比双字词分高', (() => {
  const q = bigrams('周末看电影');
  const hit = overlapScore(q, '周末看电影');
  const partial = overlapScore(q, '周末的时候有点想看电影');
  return hit === 1 && partial < 1 && partial > 0;
})());
ok('全不沾是 0', overlapScore(bigrams('周末看电影'), '今天天气不错') === 0);

// ---------- 检索 ----------
const now = T;
const recs = [
  { t: now - 1000, key: 'group:1', who: '浮浮', self: false, owner: false, text: '周末一起看电影' },
  { t: now - 2000, key: 'group:1', who: '小明', self: false, owner: false, text: '周末他说要加班' },
  { t: now - 3 * 3600 * 1000, key: 'group:1', who: '管理员', self: false, owner: true, text: '记得吃药' },
  { t: now - 30 * 24 * 3600 * 1000, key: 'group:1', who: '浮浮', self: false, owner: false, text: '上个月看电影那事' },
  { t: now - 500, key: 'group:1', who: '她', self: true, owner: false, text: '周末一起去呀' },
];
const r1 = queryArchive(recs, { text: '周末', days: 7, now });
ok('关键词命中', r1.length === 3, `${r1.length}`);
ok('超窗口的不给', !r1.some((r) => r.text.includes('上个月')));
ok('三条都命中', r1.every((r) => r.text.includes('周末')));
ok('最新的一条排最前', r1[0].t === Math.max(...r1.map((r) => r.t)));
const r2 = queryArchive(recs, { text: '周末', days: 7, now, who: '小明' });
ok('who 过滤', r2.length === 1 && r2[0].who === '小明');
const r3 = queryArchive(recs, { text: '周末', days: 7, now, excludeSelf: true });
ok('排除她自己的话', !r3.some((r) => r.self));
const r4 = queryArchive(recs, { days: 7, now });
ok('没问题词给最近的', r4.length === 4 && r4[0].t >= r4[1].t);
const r5 = queryArchive(recs, { text: '看电影', days: 60, now });
ok('放宽到 60 天能捞回旧话', r5.some((r) => r.text.includes('上个月')));
ok('limit 生效', queryArchive(recs, { days: 7, now, limit: 2 }).length === 2);
ok('空记录安全', queryArchive(null, { now }).length === 0);
const r6 = queryArchive(recs, { text: '周末', days: 7, now, keyOnly: 'group:2' });
ok('keyOnly 过滤', r6.length === 0);

// ---------- 时间标签 ----------
ok('今天', stampOf(T, T).startsWith('今天 '), stampOf(T, T));
ok('昨天', stampOf(T - 24 * 3600 * 1000, T).startsWith('昨天 '));
ok('更早给月日', /^\d{2}-\d{2} \d{2}:\d{2}$/.test(stampOf(T - 5 * 24 * 3600 * 1000, T)));

// ---------- 渲染 ----------
const fmt = formatRecall(recs.slice(0, 2), { text: '周末', days: 7, now });
ok('渲染带抬头', fmt.includes('【原话摘录】'));
ok('渲染带原话', fmt.includes('周末一起看电影'));
ok('空结果也给话', formatRecall([], { text: '不存在', days: 7 }).includes('没找到'));
ok('空结果无关键词', formatRecall([], { days: 7 }).includes('7 天'));

// ---------- 天数夹取 ----------
ok('默认 7', clampDays(undefined, { defaultDays: 7, maxDays: 90 }) === 7);
ok('超上限夹到 90', clampDays(9999, { defaultDays: 7, maxDays: 90 }) === 90);
ok('0 回落默认', clampDays(0, { defaultDays: 7, maxDays: 90 }) === 7);
ok('null 回落默认', clampDays(null, { defaultDays: 7, maxDays: 90 }) === 7);

// ---------- 接线 ----------
const bridge = fs.readFileSync(path.join(HERE, '..', 'src', 'bridge.js'), 'utf8');
const mcp = fs.readFileSync(path.join(HERE, '..', 'src', 'mcp-snowluma-safe.js'), 'utf8');
ok('bridge 有 import', bridge.includes("from './history-archive.js';"));
ok('有运行时', bridge.includes('// MARKER: history-archive-runtime'));
ok('入站挂上了', bridge.includes('// MARKER: history-archive-incoming') && bridge.includes('appendArchive(key, msg);'));
ok('出站挂上了', bridge.includes('// MARKER: history-archive-self'));
ok('有回忆路由', bridge.includes('// MARKER: history-recall-route') && bridge.includes("'/api/socialV2/recall'"));
ok('路由在 diary/book 之前', bridge.indexOf("/api/socialV2/recall") < bridge.indexOf("/api/socialV2/diary/book"));
ok('存档异步不阻塞', bridge.includes('fs.appendFile(file, line'));
ok('MCP 有 qq_recall', mcp.includes("'qq_recall'"));
ok('MCP 调回忆接口', mcp.includes('/api/socialV2/recall?'));

const total = pass + fails.length;
if (fails.length) {
  console.log(`\n❌ ${fails.length}/${total} 项失败：`);
  for (const f of fails) console.log('  - ' + f);
  process.exit(1);
}
console.log(`✅ test-history：${pass}/${total} 项全过`);
