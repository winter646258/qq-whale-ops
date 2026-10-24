// 阶段22：/api/console/{token,notify-ai} 与 /api/images/message 搬进模块。
// 幂等：两段注入块各有独立 MARKER；删除区按 if 头 + 大括号配平定位。
//
// 依赖声明位置（改动前 src/bridge.js 行号）：
//   顶层：readConfigObject 268 / atomicWriteJson 299 / atomicWriteText 313 /
//         readRoleState 744 / appendActivity 738 / allowed 1463
//   main 早于注入点：modeAllowed 3289 / dshReady 3122 / currentMode 3125 / let state 1152
//   main 晚于注入点（必须包箭头）：social 9292 / ensureSession 9112 / getSocialV2State 9644 /
//         deliverPrompt 10341 / findMessageMedia 8936 / fetchMediaData 8873
//   startConsoleServer() 内局部：consoleToken 4878 / agentTokenOk 4898 / v2ToolEnabled 4868
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

function injectAfter(marker, anchor, lines) {
  if (s.includes(marker)) { console.log('跳过注入', marker); return; }
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到锚点 ' + anchor);
  const j = s.indexOf('\n  });\n', i) + '\n  });\n'.length;
  s = s.slice(0, j) + '\n' + lines.join('\n') + '\n' + s.slice(j);
  console.log('注入', marker);
}

injectAfter('// MARKER: modules-ctx-console', '  // MARKER: modules-ctx-reset', [
  '  // MARKER: modules-ctx-console',
  '  // 阶段22：console 族句柄。',
  '  Object.assign(moduleCtx, {',
  '    crypto, readConfigObject, atomicWriteJson, atomicWriteText, readRoleState,',
  '    getSocialV2State: (key) => getSocialV2State(key),',
  '    deliverPrompt: (key, text, opts) => deliverPrompt(key, text, opts),',
  '    appendActivity: (line) => appendActivity(line),',
  '    ensureSession: (key) => ensureSession(key),',
  '    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),',
  '    allowed: (kind, id, c) => allowed(kind, id, c),',
  '    helpers: {',
  '      state: () => state,',
  '      social: () => social,',
  '    },',
  '    dshReady: () => dshReady,',
  '    currentMode: () => currentMode,',
  '  });',
]);

injectAfter('// MARKER: modules-ctx-message-image', '  // MARKER: modules-ctx-console', [
  '  // MARKER: modules-ctx-message-image',
  '  // 阶段22：消息图片族句柄。前四个在 startConsoleServer() 里，后两个声明于 main() 中段 —— 全部包箭头。',
  '  Object.assign(moduleCtx, {',
  '    currentMode: () => currentMode,',
  '    agentTokenOk: (key, token) => agentTokenOk(key, token),',
  '    v2ToolEnabled: (flag) => v2ToolEnabled(flag),',
  '    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),',
  '    findMessageMedia: (key, messageId) => findMessageMedia(key, messageId),',
  '    fetchMediaData: (media) => fetchMediaData(media),',
  '  });',
]);

// consoleToken 句柄：必须写在 startConsoleServer() 里（consoleToken 是它的局部 let）
const M2 = '// MARKER: modules-ctx-console-token';
if (!s.includes(M2)) {
  const a2 = '    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();\n';
  const k = s.indexOf(a2);
  if (k < 0) throw new Error('找不到 consoleToken 声明');
  const ins = k + a2.length;
  s = s.slice(0, ins) + '  ' + M2 + '\n'
    + '  // consoleToken 是本函数的局部 let，模块改令牌后必须靠这个句柄写回。\n'
    + '  Object.assign(moduleCtx, { consoleTokenSet: (value) => { consoleToken = value; } });\n'
    + s.slice(ins);
  console.log('注入', M2);
} else { console.log('跳过注入', M2); }

function dropIfBlock(head) {
  const a = s.indexOf(head);
  if (a < 0) { console.log('跳过删除', head.trim().slice(0, 50)); return; }
  let depth = 0;
  let i = a;
  let end = -1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) { end = s.indexOf('\n', i) + 1; break; } }
    i += 1;
  }
  if (end < 0) throw new Error('括号不配平：' + head);
  const removed = s.slice(a, end).split('\n').length - 1;
  s = s.slice(0, a) + s.slice(end);
  console.log('删除', removed, '行 <-', head.trim().slice(0, 60));
}

// 控制台两条连在一起，整段删（含章节注释），一次搞定
const secA = "        if (req.method === 'POST' && url.pathname === '/api/console/token') {";
const secEnd = '        // ── 二代仿真模式（reserved2）内部 Agent API ';
if (s.includes(secA)) {
  let a = s.indexOf(secA);
  const comment = '        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ';
  const pos = s.lastIndexOf(comment, a);
  if (pos >= 0 && a - pos < 400) a = pos;
  const b = s.indexOf(secEnd);
  console.log('删除', s.slice(a, b).split('\n').length - 1, '行 <- console 两条');
  s = s.slice(0, a) + s.slice(b);
} else { console.log('跳过删除 console 两条'); }

dropIfBlock("        if (req.method === 'GET' && url.pathname === '/api/images/message') {");

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log('bridge.js ' + before + ' -> ' + s.length + ' 字节');