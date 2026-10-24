// 阶段21：清除上下文 / 清空工作区。
//
// 这两条是控制台专用（不是 AI 工具面），统一用契约第 4 节的 rejectAgent 口径拒绝智能体调用。
//
// 依赖声明位置决定注入方式（bridge.js 行号为改动前）：
//   - 顶层可直接交引用：STATE_DIR / ACTIVITY_LOG / KNOWN_AGENT_TOKENS / CONVERSATION_TOKENS /
//     forgetAgentToken / saveState；
//   - main 内但声明早于注入点：api / slangWindows / slangExtractionCooldowns / slangSubmitTimes /
//     pendingWakeKeys / wakeConfigUpdatedKeys / markReadCalledKeys / wakeConfigMissCount /
//     collectors / sendToolSucceededSessions / v2TurnStartAt / toolCallNames / pendingSendToolCalls /
//     reverse / sessionPromises / queued / queuedHintAt；
//   - main 内且声明晚于注入点（必须包箭头）：sessionEpoch / pending / modelAppliedSessions /
//     social / socialV2 / messageMediaStore / seenForwardIds / saveSocialV2State /
//     cancelSocialTimers / cancelAllSocialTimers / clearSocialV2Timers / clearAllSocialV2Timers /
//     drainPromptQueue / drainAllPromptQueues / cancelPendingEntry。
//   - state 是顶层 `let state`，每次 loadState 会整体换新 ⇒ 用 getState() 现取。
import path from 'node:path';

function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

function wrap(fn) {
  return async function handler(payload) {
    if (rejectAgent(payload)) return 'handled';
    try {
      await fn.call(this, payload);
    } catch (error) {
      payload.sendJson({ ok: false, error: error?.message ?? String(error) }, Number(error?.statusCode) || 500);
    }
    return 'handled';
  };
}

async function resetSession({ req, sendJson, readBody }) {
  const h = this.ctx.resetHelpers;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '');
  const state = h.getState();
  if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
  h.bumpEpoch();
  const oldSessionId = state.sessions[key];
  delete state.sessions[key];
  h.modelAppliedSessions.delete(oldSessionId);
  delete state.sessionPolicies[key];
  h.reverse.delete(oldSessionId);
  h.collectors.delete(oldSessionId);
  h.sendToolSucceededSessions.delete(oldSessionId);
  h.pendingSendToolCalls.delete(oldSessionId);
  h.v2TurnStartAt.delete(oldSessionId);
  h.toolCallNames.delete(oldSessionId);
  const pe = h.pending().get(key);
  if (pe) {
    clearTimeout(pe.timer);
    h.cancelPendingEntry(pe).catch(() => {});
  }
  h.pending().delete(key);
  h.queued.delete(key);
  h.queuedHintAt.delete(key);
  h.sessionPromises.delete(key);
  h.drainPromptQueue(key, '会话已重置');
  const social = h.social();
  social.recentMessages.delete(key);
  h.messageMediaStore.delete(key);
  social.pendingSummaries.delete(key);
  social.states.delete(key);
  social.silentContext.delete(key);
  social.silentTurns.delete(oldSessionId);
  social.exitingSessions.delete(oldSessionId);
  h.slangWindows.delete(key);
  h.slangExtractionCooldowns.delete(key);
  h.slangSubmitTimes.delete(key);
  h.cancelSocialTimers(key);
  h.clearSocialV2Timers(key);
  h.pendingWakeKeys.delete(key);
  h.wakeConfigUpdatedKeys.delete(key);
  h.markReadCalledKeys.delete(key);
  h.wakeConfigMissCount.delete(key);
  h.forgetAgentToken(key);
  h.socialV2().conversations.delete(key);
  h.seenForwardIds.delete(key);
  h.saveSocialV2State();
  h.saveState();
  try { await h.api.stopSessionWork(oldSessionId); }
  catch (error) { h.log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
  try { await h.api.workspace.archiveSession({ sessionId: oldSessionId }); } catch {}
  h.log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
  sendJson({ ok: true, key, archived: oldSessionId });
}

async function resetWorkspace({ sendJson }) {
  const h = this.ctx.resetHelpers;
  h.bumpEpoch();
  let archivedCount = 0;
  let stoppedCount = 0;
  try {
    const list = h.unwrap(await h.api.sessions.list({}), 'session.list');
    const stateDir = path.resolve(h.stateDir);
    const statePrefix = path.normalize(stateDir + path.sep);
    const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
    const isUnderState = (cwd) => process.platform === 'win32'
      ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
      : cwd.startsWith(statePrefix);
    for (const item of list.items ?? []) {
      if (item.origin === 'subagent' || item.parentSessionId) continue;
      const cwd = normPath(item.cwd);
      if (isUnderState(cwd)) {
        try { await h.api.stopSessionWork(item.sessionId); stoppedCount += 1; }
        catch (error) { h.log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
        try { await h.api.workspace.archiveSession({ sessionId: item.sessionId }); archivedCount += 1; } catch {}
      }
    }
  } catch {}
  const pending = h.pending();
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    h.cancelPendingEntry(entry).catch(() => {});
  }
  pending.clear();
  h.queued.clear();
  h.queuedHintAt.clear();
  h.sessionPromises.clear();
  h.drainAllPromptQueues('工作区已清空');
  const social = h.social();
  social.states.clear();
  social.recentMessages.clear();
  h.messageMediaStore.clear();
  h.seenForwardIds.clear();
  social.pendingSummaries.clear();
  social.silentContext.clear();
  social.silentTurns.clear();
  social.exitingSessions.clear();
  h.slangWindows.clear();
  h.slangExtractionCooldowns.clear();
  h.slangSubmitTimes.clear();
  h.cancelAllSocialTimers();
  h.clearAllSocialV2Timers();
  h.socialV2().conversations.clear();
  h.CONVERSATION_TOKENS.clear();
  h.KNOWN_AGENT_TOKENS.clear();
  h.saveSocialV2State();
  const state = h.getState();
  state.sessions = {};
  state.sessionPolicies = {};
  h.reverse.clear();
  h.collectors.clear();
  h.sendToolSucceededSessions.clear();
  h.pendingSendToolCalls.clear();
  h.v2TurnStartAt.clear();
  h.toolCallNames.clear();
  h.saveState();
  try { h.fs.writeFileSync(h.ACTIVITY_LOG, ''); } catch {}
  h.log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
  sendJson({ ok: true, archivedCount, stoppedCount });
}

export default {
  name: 'reset',
  title: '清除上下文 / 清空工作区',
  inject: [
    'api', 'log', 'fs', 'path', 'stateDir', 'unwrap',
    'ACTIVITY_LOG', 'CONVERSATION_TOKENS', 'KNOWN_AGENT_TOKENS',
    'forgetAgentToken', 'saveState', 'saveSocialV2State',
    'slangWindows', 'slangExtractionCooldowns', 'slangSubmitTimes',
    'pendingWakeKeys', 'wakeConfigUpdatedKeys', 'markReadCalledKeys', 'wakeConfigMissCount',
    'collectors', 'sendToolSucceededSessions', 'v2TurnStartAt', 'toolCallNames',
    'pendingSendToolCalls', 'reverse', 'sessionPromises', 'queued', 'queuedHintAt',
    'resetHelpers',
  ],
  routes: [
    { method: 'POST', path: '/api/session/reset', kind: 'exact', handler: wrap(resetSession) },
    { method: 'POST', path: '/api/workspace/reset', kind: 'exact', handler: wrap(resetWorkspace) },
  ],
};