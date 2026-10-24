// 阶段26：v2:extras 族 4 条搬进 ai-extras 模块
//   GET/POST /api/socialV2/mood、GET/POST /api/socialV2/spotify、
//   POST /api/socialV2/diary/migrate、POST /api/socialV2/feedback
//
// 依赖声明位置（改动前 src/bridge.js）：
//   顶层 import：diary-store.js 32-38、mood-store.js 83-87、spotify-client.js 167
//   main() 内：feedbackTimes 1536（早于注入点，交引用即可）、
//     spotifyClient 4935 / affinityEntryFor 4697 / recordAffinityForKey 4709 /
//     moodStore 8808 / saveMoodSafe 8820 / moodStoreWritable 8806 / appendFeedbackEntry 10463
//   ⇒ 后几个晚于 modules-ctx 注入点（1509-1521），一律包箭头。
//   注意 mood 路由里的 `body` 原写法是 `await readBody()` 且可能 undefined，
//   模块里已改成 `(await readBody()) ?? {}`，别再丢掉。
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

const MARK = '// MARKER: modules-ctx-ai-extras';
// 依赖补齐：truncateText 是顶层 import（md-to-plain.js，L20），但注入点那一步
// Object.assign 没有它 —— 第一次跑漏交，validate 报「ctx 缺少依赖：truncateText」，
// 模块被挡在装载之外（problems 只告警，其它模块照常）。幂等：补过一次就跳过。
if (s.includes("    truncateText,\n  });")) {
  console.log('跳过 truncateText 补齐');
} else {
  const a2 = s.indexOf('// MARKER: modules-ctx');
  const b2 = s.indexOf('Object.assign(moduleCtx, {', a2);
  const close = s.indexOf('});', b2);
  s = s.slice(0, close) + "    truncateText,\n" + s.slice(close);
  console.log('补齐 moduleCtx.truncateText');
}

if (s.includes(MARK)) {
  console.log('跳过注入（已存在）');
} else {
  const anchor = "  Object.assign(moduleCtx, {\n    stickerHelpers: {";
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到 modules-ctx-stickers 注入点');
  const block = [
    MARK,
    '  Object.assign(moduleCtx, {',
    '    aiExtrasHelpers: {',
    '      moodStore: () => moodStore(),',
    '      saveMoodSafe: (store, label) => saveMoodSafe(store, label),',
    '      affinityEntryFor: (key) => affinityEntryFor(key),',
    '      recordAffinityForKey: (key, payload) => recordAffinityForKey(key, payload),',
    '      spotifyClient: () => spotifyClient(),',
    '      feedbackTimes: () => feedbackTimes,',
    '      appendFeedbackEntry: (entry) => appendFeedbackEntry(entry),',
    '    },',
    '  });',
    '',
  ].join('\n');
  s = s.slice(0, i) + block + s.slice(i);
  console.log('注入 modules-ctx-ai-extras');
}

function dropIfBlock(head) {
  const a = s.indexOf(head);
  if (a < 0) { console.log('跳过删除', head.trim().slice(0, 60)); return; }
  let depth = 0, i = a, end = -1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = s.indexOf('\n', i) + 1; break; } }
    i += 1;
  }
  if (end < 0) throw new Error('括号不配平：' + head);
  console.log('删除 ' + (s.slice(a, end).split('\n').length - 1) + ' 行 <- ' + head.trim().slice(0, 70));
  s = s.slice(0, a) + s.slice(end);
}

dropIfBlock("        if (url.pathname === '/api/socialV2/spotify') {");
dropIfBlock("        if ((req.method === 'GET' || req.method === 'POST') && url.pathname === '/api/socialV2/mood') {");
dropIfBlock("        if (req.method === 'POST' && url.pathname === '/api/socialV2/diary/migrate') {");
dropIfBlock("        if (req.method === 'POST' && url.pathname === '/api/socialV2/feedback') {");

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log('bridge.js ' + before + ' -> ' + s.length + ' 字节');