// 阶段21：/api/session/reset 与 /api/workspace/reset 搬进 reset 模块。
// 幂等：注入块以 MARKER: modules-ctx-reset 判重；删除区以章节注释定位。
//
// 依赖声明位置（改动前 src/bridge.js 行号）：
//   顶层：STATE_DIR 177 / ACTIVITY_LOG 210 / forgetAgentToken 673 / saveState 1186 /
//         KNOWN_AGENT_TOKENS 630 / CONVERSATION_TOKENS 645 / let state 1152
//   早于注入点：api 2901 / slangWindows 1533 / pendingWakeKeys 3020 / collectors 3011 /
//               reverse 3034 / sessionPromises 3038 / queued 3212
//   晚于注入点（必须包箭头/访问器）：sessionEpoch 8389 / pending 8392 /
//               modelAppliedSessions 9156 / social 9292 / socialV2 9304 /
//               messageMediaStore 9311 / seenForwardIds 9313 / saveSocialV2State 9912 /
//               cancelSocialTimers 10228 / clearSocialV2Timers 12191 /
//               drainPromptQueue 12225 / cancelPendingEntry 12597
import fs from 'node:fs';

const FILE = '/opt/qq-bridge/src/bridge.js';
const MARK = '// MARKER: modules-ctx-reset';

let s = fs.readFileSync(FILE, 'utf8');
const before = s.length;

if (!s.includes(MARK)) {
  const anchor = '  // MARKER: modules-ctx-image';
  const i = s.indexOf(anchor);
  if (i < 0) throw new Error('找不到 modules-ctx-image 锚点');
  const j = s.indexOf('\n  });\n', i) + '\n  });\n'.length;
  const block = [
    '',
    '  ' + MARK,
    '  // 阶段21：reset 族句柄。声明晚于注入点的名字一律包箭头或访问器。',
    '  Object.assign(moduleCtx, {',
    '    unwrap, ACTIVITY_LOG, CONVERSATION_TOKENS, KNOWN_AGENT_TOKENS,',
    '    forgetAgentToken, saveState, slangWindows, slangExtractionCooldowns,',
    '    slangSubmitTimes, pendingWakeKeys, wakeConfigUpdatedKeys,',
    '    markReadCalledKeys, wakeConfigMissCount, collectors,',
    '    sendToolSucceededSessions, v2TurnStartAt, toolCallNames,',
    '    pendingSendToolCalls, reverse, sessionPromises, queued, queuedHintAt,',
    '    resetHelpers: {',
    '      getState: () => state,',
    '      bumpEpoch: () => { sessionEpoch += 1; },',
    '      pending: () => pending,',
    '      modelAppliedSessions: () => modelAppliedSessions,',
    '      social: () => social,',
    '      socialV2: () => socialV2,',
    '      messageMediaStore: () => messageMediaStore,',
    '      seenForwardIds: () => seenForwardIds,',
    '      saveSocialV2State: () => saveSocialV2State(),',
    '      cancelSocialTimers: (key) => cancelSocialTimers(key),',
    '      cancelAllSocialTimers: () => cancelAllSocialTimers(),',
    '      clearSocialV2Timers: (key) => clearSocialV2Timers(key),',
    '      clearAllSocialV2Timers: () => clearAllSocialV2Timers(),',
    '      drainPromptQueue: (key, msg) => drainPromptQueue(key, msg),',
    '      drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),',
    '      cancelPendingEntry: (entry) => cancelPendingEntry(entry),',
    '    },',
    '  });',
    '',
  ].join('\n');
  s = s.slice(0, j) + block + s.slice(j);
  console.log('注入 modules-ctx-reset');
} else {
  console.log('跳过注入（已存在）');
}

const startMarker = '        // ── 清除上下文 / 清空工作区 ';
const endMarker = '        // ── 重启桥接（守护模式下 5 秒后自动拉起）';
if (s.includes(startMarker)) {
  const a = s.indexOf(startMarker);
  const b = s.indexOf(endMarker);
  const removed = s.slice(a, b).split('\n').length - 1;
  s = s.slice(0, a) + s.slice(b);
  console.log(`删除老 if 链 ${removed} 行`);
} else {
  console.log('跳过删除（章节注释已不存在）');
}

fs.writeFileSync(FILE, s, { encoding: 'utf8' });
console.log(`bridge.js ${before} -> ${s.length} 字节`);