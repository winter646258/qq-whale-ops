// 阶段23：/api/mode、/api/send/{group,private,reply} 搬进 mode / send-legacy 模块。
// 幂等：注入块各用独立 MARKER；删除区按 if 头 + 大括号配平定位。
//
// 依赖声明位置（改动前 src/bridge.js 行号）：
//   顶层：normalizeModeInput 238 / VALID_MODES 235 / readJsonSafe 246 / atomicWriteJson 299 /
//         unquoteJsonString 724 / SENSITIVE_RE (import 21) / appendActivity 738 / unwrap (import 19)
//   main 早于注入点：api 2901 / currentMode 3202 / lastMode 3203 / closedAgentPreset 3207 /
//         reconcileSessionPolicies 3451 / resolveSendLimitsV2 3768 / modeAllowed 3289
//   main 晚于注入点（必须包箭头）：socialV2 9069 / sendMessagesV2 8842 / shouldBlockSilentReply 8897 /
//         getSocialV2State 9484 / saveSocialV2State 9677 / resolveReplyTargetV2 10737 /
//         recordSentMessagesV2 10914 / scheduleReplyCheckV2 11623 / cleanupSocialForModeChange 10050 /
//         clearAllSocialV2Timers 12023 / drainAllPromptQueues 12040 / setupSleepTimerV2 11900 /
//         scheduleProactiveCheckV2 11945
//   startConsoleServer() 内局部：agentTokenOk 4961 / agentTokenOkOrOwnerDelegate 4969 /
//         v2ToolEnabled 4910 / v2SessionAllowed 4956 / consoleToken 4878
//
// 踩坑记录：
//   - currentMode / lastMode 是可变的 let，只能交读写句柄（setMode / setClosedAgentPreset）。
//   - agentTokenOk 与 agentTokenOkOrOwnerDelegate 都在 startConsoleServer() 内部，
//     写进 main() 作用域的注入块会在运行期报 `agentTokenOk is not defined`
//     （函数体延迟求值掩盖了 TDZ，validate 也查不出来）—— 必须写进 modules-ctx-ops-token 块。
//   - consoleToken 也是局部 let，令牌轮换要靠 consoleTokenSet 句柄写回，否则内存与磁盘不一致。
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

function injectAfterBlock(markerOfAnchor, lines, newMarker) {
  if (s.includes(newMarker)) { console.log('跳过注入', newMarker); return; }
  const i = s.indexOf(markerOfAnchor);
  if (i < 0) throw new Error('找不到锚点 ' + markerOfAnchor);
  const j = s.indexOf('\n  });\n', i) + '\n  });\n'.length;
  s = s.slice(0, j) + '\n' + lines.join('\n') + '\n' + s.slice(j);
  console.log('注入', newMarker);
}

injectAfterBlock('  // MARKER: modules-ctx-message-image', [
  '  // MARKER: modules-ctx-mode',
  '  // 阶段23：运行模式切换句柄。currentMode / lastMode / closedAgentPreset 是可变的 let，',
  '  // 必须用读写句柄，不能交快照值；socialV2 声明在 main() 中段，包箭头。',
  '  Object.assign(moduleCtx, {',
  '    normalizeModeInput, VALID_MODES, readJsonSafe, atomicWriteJson,',
  '    cleanupSocialForModeChange: () => cleanupSocialForModeChange(),',
  '    clearAllSocialV2Timers: () => clearAllSocialV2Timers(),',
  '    drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),',
  '    reconcileSessionPolicies: () => reconcileSessionPolicies(),',
  '    setupSleepTimerV2: (key) => setupSleepTimerV2(key),',
  '    scheduleProactiveCheckV2: (key) => scheduleProactiveCheckV2(key),',
  '    socialV2: () => socialV2,',
  '    setClosedAgentPreset: (value) => { closedAgentPreset = value; },',
  '    setMode: (value) => { currentMode = value; lastMode = value; },',
  '  });',
], '// MARKER: modules-ctx-mode');

injectAfterBlock('  // MARKER: modules-ctx-mode', [
  '  // MARKER: modules-ctx-send-legacy',
  '  // 阶段23：老版发送通道句柄。除 agentTokenOk / agentTokenOkOrOwnerDelegate 外全部包箭头',
  '  // （它们两个在 startConsoleServer() 里，见 modules-ctx-ops-token 块）。',
  '  Object.assign(moduleCtx, {',
  '    SENSITIVE_RE, unquoteJsonString, appendActivity, resolveSendLimitsV2,',
  '    v2ToolEnabled: (flag) => v2ToolEnabled(flag),',
  '    modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),',
  '    shouldBlockSilentReply: (key) => shouldBlockSilentReply(key),',
  '    socialV2: () => socialV2,',
  '    getSocialV2State: (key) => getSocialV2State(key),',
  '    resolveReplyTargetV2: (st, kind, id, ref) => resolveReplyTargetV2(st, kind, id, ref),',
  '    sendMessagesV2: (key, msgs, imgs, reply, at) => sendMessagesV2(key, msgs, imgs, reply, at),',
  '    recordSentMessagesV2: (key, msgs) => recordSentMessagesV2(key, msgs),',
  '    saveSocialV2State: () => saveSocialV2State(),',
  '    scheduleReplyCheckV2: (key) => scheduleReplyCheckV2(key),',
  '  });',
], '// MARKER: modules-ctx-send-legacy');

// 令牌句柄必须在 startConsoleServer() 里（agentTokenOk 等是局部 const）
const opsAnchor = '      v2ToolEnabled: (flag) => v2ToolEnabled(flag),';
if (!s.includes('agentTokenOkOrOwnerDelegate: (key, token) => agentTokenOkOrOwnerDelegate')) {
  const i = s.indexOf('// MARKER: modules-ctx-ops-token');
  if (i < 0) throw new Error('找不到 modules-ctx-ops-token');
  const j = s.indexOf('});', i) + 3;
  const seg = s.slice(i, j).replace(
    opsAnchor,
    opsAnchor + '\n      agentTokenOk: (key, token) => agentTokenOk(key, token),\n      agentTokenOkOrOwnerDelegate: (key, token) => agentTokenOkOrOwnerDelegate(key, token),',
  );
  s = s.slice(0, i) + seg + s.slice(j);
  console.log('补令牌句柄 -> modules-ctx-ops-token');
} else { console.log('跳过令牌句柄'); }

function dropIfBlock(head) {
  const a = s.indexOf(head);
  if (a < 0) { console.log('跳过删除', head.trim().slice(0, 48)); return; }
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
  console.log('删除', s.slice(a, end).split('\n').length - 1, '行 <-', head.trim().slice(0, 60));
  s = s.slice(0, a) + s.slice(end);
}

dropIfBlock("        if (req.method === 'POST' && url.pathname === '/api/mode') {");
dropIfBlock("        if (req.method === 'POST' && (url.pathname === '/api/send/group'");

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log('bridge.js ' + before + ' -> ' + s.length + ' 字节');