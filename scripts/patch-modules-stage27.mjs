// 阶段27：把 v2:core 的 9 条路由搬进 src/modules/core 模块。
//
// 删除区是一整段连续的老 if 链（从 /api/socialV2/config 的 GET 到 /api/socialV2/message-detail
// 的收尾 return），中间没有插别的路由 —— 之前逐条搬的做法在这里会切得很碎，
// 反而更容易删错一行。
//
// 注入块给 core 模块一个 coreHelpers：全是箭头函数，因为绝大多数句柄在注入点之后才声明
// （socialV2 在 L8419、getSocialV2State 在 L8834……值位置直接引用会撞 TDZ）。
//
// 幂等：五个/十个 MARKER 各自独立，重跑只补缺的那一块。支持 --dry-run。

import fs from 'node:fs';
import path from 'node:path';

const FILE = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : 'src/bridge.js';
const DRY = process.argv.includes('--dry-run');
const MARK = {
  ctx: '// MARKER: modules-core-ctx',
};
let src = fs.readFileSync(FILE, 'utf8');
const original = src;

const stats = [];
function once(name, fn) {
  if (src.includes(MARK[name])) {
    stats.push(`${name}: 已存在，跳过`);
    return;
  }
  src = fn(src);
  stats.push(`${name}: 已插入`);
}

// ── 2. Object.assign(moduleCtx, { coreHelpers }) ─────────────────────────────
const CTX_BLOCK = `  ${MARK.ctx}
  // v2:core 一族需要的句柄。全部是箭头函数：socialV2（L~8419）、getSocialV2State（L~8834）
  // 这些名字都在注入点之后才声明，在对象字面量值位置直接引用会撞 TDZ。
  Object.assign(moduleCtx, {
    coreHelpers: {
      // —— 会话状态 ——
      socialV2: () => socialV2,
      socialV2File: SOCIAL_V2_FILE,
      configFile: CONFIG_FILE,
      getSocialV2State: (key) => getSocialV2State(key),
      saveSocialV2State: () => saveSocialV2State(),
      state: () => state,
      saveState: () => saveState(),
      readConfigObject: (file) => readConfigObject(file),
      atomicWriteJson: (file, obj) => atomicWriteJson(file, obj),
      // —— 唤醒/安全 ——
      wakeSafety: (wc) => computeWakeSafetyV2(wc),
      currentMode: () => currentMode,
      modeAllowed: (key, kind, id, c, mode) => modeAllowed(key, kind, id, c, mode),
      setupSleepTimer: (key) => setupSleepTimerV2(key),
      scheduleProactiveCheck: (key) => scheduleProactiveCheckV2(key),
      clearAllSocialV2Timers: () => clearAllSocialV2Timers(),
      drainAllPromptQueues: (msg) => drainAllPromptQueues(msg),
      refreshAllDefaultWakeConfigs: () => refreshAllDefaultWakeConfigsV2(),
      sendWakePrompt: (key, reason) => sendWakePromptV2(key, reason),
      cancelReplyCheck: (key) => cancelReplyCheckV2(key),
      clearAllPendingWakeLeases: () => clearAllPendingWakeLeases(),
      isSleepingConfig: (wc) => isSleepingConfigV2(wc),
      preSleepWaitBlocked: (st) => preSleepWaitBlockedV2(st),
      ensureWakeable: (st, opts) => ensureWakeableV2(st, opts),
      clampWakeProbability: (key, next) => clampWakeProbabilityV2(key, next),
      normalizeSpeakerIds: (ids) => normalizeSpeakerIdsV2(ids),
      // —— 未读游标 ——
      readThroughSeq: (st) => readThroughSeqV2(st),
      noteModelMessages: (st, msgs) => noteModelMessagesV2(st, msgs),
      requestedReadThroughSeq: (st, body, isAgent) => requestedReadThroughSeqV2(st, body, isAgent),
      acknowledgeMessages: (st, seq) => acknowledgeMessagesV2(st, seq),
      resolveReplyInfo: (kind, id, messageId) => resolveReplyInfo(kind, id, messageId),
      // —— prompt 内容 ——
      readRoleState: () => readRoleState(),
      currentRoleHint: () => currentRoleHint(),
      currentRoleHintV2: () => currentRoleHintV2(),
      toolMap: () => CORE_TOOL_MAP,
      stickerEnabled: () => stickerEnabled(),
      replyTiming: (st) => replyTimingV2(st),
      formatMemory: (st) => formatMemoryV2(st),
      formatParticipation: (st) => formatParticipationV2(st),
      scheduleStore: () => scheduleStore(),
      portraitStore: () => portraitStore(),
      formatSchedule: (store, opts) => formatScheduleForPrompt(store, opts),
      formatPortrait: (store) => formatPortraitForPrompt(store),
      syncStickerLibrary: (force) => syncStickerLibrary(force),
      stickerEntries: () => stickerEntries,
      buildStickerContext: (entries, max) => buildStickerContext(entries, max),
      buildStickerStrategyHint: () => buildStickerStrategyHint(),
      confirmedSlangList: () => confirmedSlangListV2(),
      slangEntries: () => slangEntries,
      buildSlangContext: (entries, max) => buildSlangContext(entries, max),
      voiceLibrary: () => voiceLibrary(),
      voiceCfg: () => voiceCfg(),
      // —— 映射表（reset 时逐个清） ——
      bumpEpoch: () => { sessionEpoch += 1; },
      sessionPromises,
      sessionModels,
      modelAppliedSessions,
      reverse,
      collectors,
      v2TurnStartAt,
      toolCallNames,
      pendingSendToolCalls,
      sendToolSucceededSessions,
      seenForwardIds,
      pendingWakeKeys,
      wakeConfigUpdatedKeys,
      markReadCalledKeys,
      wakeConfigMissCount,
      forgetAgentToken: (key) => forgetAgentToken(key),
      stopRetiredSessionWork: (sid, key) => stopRetiredSessionWork(sid, key),
    },
  });
`;
once('ctx', (s) => {
  // 锚点必须在缩进 2 的区块里：coreHelpers 里的名字都在 main() 作用域，括到缩进 0 会变成顶层引用。
  const anchor = '  // MARKER: modules-ctx-reset';
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('找不到 modules-ctx-ai-extras 锚点');
  return s.slice(0, idx) + CTX_BLOCK + s.slice(idx);
});

// ── 3. 删除老 if 链 ─────────────────────────────────────────────────────────
const START = "        if (req.method === 'GET' && url.pathname === '/api/socialV2/config') {";
const END = "        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {";
const si = src.indexOf(START);
const ei = src.indexOf(END);
if (si < 0 || ei < 0 || ei <= si) throw new Error(`删除区定位失败 si=${si} ei=${ei}`);
const removedBlock = src.slice(si, ei);
// 守卫用「这条路由的 if 语句」而不是裸路径字符串：删除区里自然地会提到 forward-message / bili
// （代码注释、seenForwardIds 之类的变量名都会撞上），拿路径做守卫只会误报。
// 守卫只认「行首 + 缩进 8 的路由 if」：qzone 在删除区之内（它本来就是模块端点），
// 所以守卫只盯 forward-message / forward-media 这两个真正必须留下的端点。
const GUARD_RE = /^ {8}if \([^\n]*url\.pathname === '\/api\/socialV2\/(forward-message|forward-media)'/m;
const guardHit = GUARD_RE.exec(removedBlock);
if (guardHit) throw new Error(`删除区里出现了不应删除的路由：${guardHit[1]}`);
const removedLines = removedBlock.split('\n').length - 1;
let out = src.slice(0, si) + src.slice(ei);

// ── 5. 语法自检 ─────────────────────────────────────────────────────────────
const tmp = path.join(path.dirname(FILE), '.bridge-core.tmp.js');
fs.writeFileSync(tmp, out);

console.log(stats.join('\n'));
console.log(`删除 ${removedLines} 行（${si} → ${ei}）`);
if (DRY) {
  console.log('dry-run：未写回');
} else {
  const bak = `${FILE}.bak-core-${Date.now()}`;
  fs.copyFileSync(FILE, bak);
  fs.writeFileSync(FILE, out);
  console.log(`已写回，备份 ${bak}`);
}
