// ── v2:core 的「控制台管理面」：/config /activity /reset /states /wake ────────
//
// 这 5 条本来就在集中闸门的 adminOnlyV2Paths 里被挡过一次（agent 一律 403）。
// 模块里**再挡一次**不是冗余：栅门那张表是按路径字面量列的，一旦以后有人把它
// 改成前缀匹配、或把模块委派点往前挪，就只有模块自己这道还在。
//
// 这里最容易改坏的是 POST /config 的归一化 —— 它决定「文件里没写的字段，保存一次
// 会不会就变了」。特别是 tools：`current.tools?.[k] !== false` 这个兜底一旦落到
// 空的 current 上，就会把默认关闭的 setStickerRemark / sendVoice 静默打开。
// 所以 current 必须取「当前生效的 cfg.socialV2」，而不是文件里那一份。

import { rejectConsoleOnly, num, clamp01 } from './shared.js';

const TOOL_FLAGS = [
  'getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst',
  'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers',
  'setWakeConfig', 'markRead', 'memory', 'memoryUpdate', 'slangQuery', 'slangSubmit', 'getImages',
  'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark',
  'stickerNote', 'collectSticker', 'getSelfImage', 'sendVoice', 'schedule', 'portrait', 'diary', 'album',
  'qzone', 'spotify',
];

// 只有会影响「默认唤醒配置」的字段变了，才同步到仍用默认配置的会话；
// 否则只改发送/等待/工具开关也会重置正在等待的潜水计划。
const WAKE_DEFAULT_KEYS = [
  'defaultMode', 'recommendedDefaultInfinite',
  'recommendedSleepMinMs', 'recommendedSleepMaxMs',
  'recommendedProbability', 'recommendedKeywords',
  'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
  'sleepMinMs', 'sleepMaxMs', 'batchWindowMs',
];


/** 只做归一化，不碰磁盘 —— 便于单测与复核。 */
export function normalizeSocialV2(body, current) {
  const merged = { ...current, ...body };
  // 子对象必须是非 null 对象；null / 数组 / 基本类型会覆盖默认值导致工具开关被绕过，
  // 这里直接保留当前值。
  for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'diaryDaily']) {
    if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
      merged[sub] = current[sub] ?? {};
    }
  }

  if (merged.autoReplyCheckMs !== undefined) {
    merged.autoReplyCheckMs = num(merged.autoReplyCheckMs, current.autoReplyCheckMs ?? 30000, { min: 1000 });
    // 群聊专用值：显式 null / 空表示「回退全局」，不能归一成 0
    const ga = merged.autoReplyCheckMsInGroup;
    if (ga === null || ga === undefined || ga === '') merged.autoReplyCheckMsInGroup = null;
    else merged.autoReplyCheckMsInGroup = num(ga, null, { min: 1000 });
  }

  if (body.tools && typeof body.tools === 'object') {
    merged.tools = { ...(current.tools ?? {}), ...body.tools };
    for (const k of TOOL_FLAGS) {
      // 非布尔一律回落到「当前值不等于 false」。current 保证是生效配置，
      // 所以「文件里没写 → 保存一次就变」那个历史 bug 不会复发。
      if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
    }
  }

  if (body.wake && typeof body.wake === 'object') {
    merged.wake = { ...(current.wake ?? {}), ...body.wake };
    if (merged.wake.exemptHighPriorityFromLimit !== undefined) merged.wake.exemptHighPriorityFromLimit = merged.wake.exemptHighPriorityFromLimit !== false;
    for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'maxWakePerHourInGroup', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
      if (merged.wake[k] === undefined) continue;
      // 群聊专用阈值：显式 null / 空表示回退全局
      if (k === 'maxWakePerHourInGroup' && (merged.wake[k] === null || merged.wake[k] === '')) {
        merged.wake[k] = null;
        continue;
      }
      merged.wake[k] = num(merged.wake[k], current.wake?.[k] ?? 0);
    }
    if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = clamp01(merged.wake.recommendedProbability);
    if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
    if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
    if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
    if (merged.wake.recommendedKeywords !== undefined) {
      merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords)
        ? merged.wake.recommendedKeywords
        : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
    }
    if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
    if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
  }

  if (body.send && typeof body.send === 'object') {
    merged.send = { ...(current.send ?? {}), ...body.send };
    for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxSendPerMinuteInGroup', 'maxSendPerHourInGroup', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
      if (merged.send[k] === undefined) continue;
      if ((k === 'maxSendPerMinuteInGroup' || k === 'maxSendPerHourInGroup')
          && (merged.send[k] === null || merged.send[k] === '')) {
        merged.send[k] = null;
        continue;
      }
      merged.send[k] = num(merged.send[k], current.send?.[k] ?? 0);
    }
    if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = clamp01(merged.send.longGapProbability);
    if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
    if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
  }

  if (body.wait && typeof body.wait === 'object') {
    merged.wait = { ...(current.wait ?? {}), ...body.wait };
    for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
      if (merged.wait[k] !== undefined) merged.wait[k] = num(merged.wait[k], current.wait?.[k] ?? 5000);
    }
  }

  if (body.proactive && typeof body.proactive === 'object') {
    merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
    for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
      if (merged.proactive[k] !== undefined) merged.proactive[k] = num(merged.proactive[k], current.proactive?.[k] ?? 0);
    }
    if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
    if (merged.proactive.probability !== undefined) merged.proactive.probability = clamp01(merged.proactive.probability);
  }

  if (body.diaryDaily && typeof body.diaryDaily === 'object' && !Array.isArray(body.diaryDaily)) {
    // MARKER: diary-daily-hot —— 「每天先日记」的旋钮也要能热改，
    // 不然每次调冷却/次数都得重启 bridge、打断正在进行的回合。
    merged.diaryDaily = { ...(current.diaryDaily ?? {}), ...body.diaryDaily };
    const dd = merged.diaryDaily;
    if (dd.enabled !== undefined) dd.enabled = dd.enabled !== false;
    for (const k of ['cooldownMs', 'maxPerDay', 'keepDays']) {
      if (dd[k] === undefined) continue;
      dd[k] = num(dd[k], current.diaryDaily?.[k] ?? 0, { min: 1 });
    }
    for (const k of ['quietStart', 'quietEnd', 'strongAfterHour']) {
      if (dd[k] === undefined) continue;
      const n = Number(dd[k]);
      dd[k] = Number.isFinite(n) ? Math.min(24, Math.max(0, Math.trunc(n))) : (current.diaryDaily?.[k] ?? 0);
    }
  }
  if (body.sticker && typeof body.sticker === 'object') {
    merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
    if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
    for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
      if (merged.sticker[k] !== undefined) merged.sticker[k] = num(merged.sticker[k], current.sticker?.[k] ?? 0);
    }
    if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
    if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
    if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
    if (body.sticker.collect && typeof body.sticker.collect === 'object') {
      merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
      if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
      for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
        if (merged.sticker.collect[k] !== undefined) merged.sticker.collect[k] = num(merged.sticker.collect[k], current.sticker?.collect?.[k] ?? 0);
      }
    }
  }

  if (body.feedback && typeof body.feedback === 'object') {
    merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
    if (merged.feedback.maxLength !== undefined) merged.feedback.maxLength = num(merged.feedback.maxLength, current.feedback?.maxLength ?? 500, { min: 1 });
    if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
  }

  if (body.context && typeof body.context === 'object') {
    merged.context = { ...(current.context ?? {}), ...body.context };
    for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
      if (merged.context[k] !== undefined) merged.context[k] = num(merged.context[k], current.context?.[k] ?? 20, { min: 1 });
    }
    for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
      const n = Number(merged.context[name] ?? fallback);
      merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
    }
    if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
  }

  if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
  if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
  if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
  return merged;
}

export const configRoutes = [
  // 五条都是精确路径：kind 必须显式给 'exact'，漏了 register 会在装载期判非法
  // （症状是「模块装不上、problems 里一条 kind 必须是 exact / prefix」，不是崩）。
  {
    method: 'GET',
    kind: 'exact',
    path: '/api/socialV2/config',
    handler({ req, sendJson }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      sendJson({ ok: true, config: this.ctx.cfg.socialV2 ?? {} });
    },
  },
  {
    method: 'POST',
    kind: 'exact',
    path: '/api/socialV2/config',
    async handler({ req, sendJson, readBody }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      const h = this.ctx.coreHelpers;
      const body = (await readBody()) ?? {};
      const file = h.readConfigObject(h.configFile);
      // 生效配置优先：文件里没写 socialV2 段时，用运行时那层（含默认值）兜底。
      const current = (this.ctx.cfg.socialV2 && typeof this.ctx.cfg.socialV2 === 'object') ? this.ctx.cfg.socialV2 : {};
      const merged = normalizeSocialV2(body, current);
      file.socialV2 = merged;
      h.atomicWriteJson(h.configFile, file);
      this.ctx.cfg.socialV2 = { ...(this.ctx.cfg.socialV2 ?? {}), ...merged };
      if (body.wake && typeof body.wake === 'object' && WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k))) {
        h.refreshAllDefaultWakeConfigs();
      }
      this.ctx.log('控制台：二代仿真配置已更新');
      sendJson({ ok: true, config: this.ctx.cfg.socialV2 });
    },
  },
  {
    // 暂停 / 恢复：暂停要停掉所有定时器，恢复要逐个会话重建沉睡与主动检查。
    method: 'POST',
    kind: 'exact',
    path: '/api/socialV2/activity',
    async handler({ req, sendJson, readBody }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      const h = this.ctx.coreHelpers;
      const body = (await readBody()) ?? {};
      const paused = body.paused === true;
      h.socialV2().paused = paused;
      if (paused) {
        h.clearAllSocialV2Timers();
        this.ctx.log('控制台：二代 AI 已暂停（唤醒/等待任务已停止）');
      } else {
        this.ctx.log('控制台：二代 AI 已恢复');
        for (const key of h.socialV2().conversations.keys()) {
          // 恢复时要把「睡着」和「主动检查」两个定时器都重新挂上，否则暂停一下就不会自己醒了。
          h.setupSleepTimer(key);
          h.scheduleProactiveCheck(key);
        }
      }
      h.saveSocialV2State();
      sendJson({ ok: true, paused: h.socialV2().paused });
    },
  },
  {
    // 重置：把会话映射、定时器、唤醒配置全部清空（工具日志保留）。
    method: 'POST',
    kind: 'exact',
    path: '/api/socialV2/reset',
    handler({ req, sendJson }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      const h = this.ctx.coreHelpers;
      h.bumpEpoch();
      h.sessionPromises().clear();
      h.clearAllSocialV2Timers();
      h.drainAllPromptQueues('二代状态已重置');
      const sv2 = h.socialV2();
      const state = h.state();
      for (const key of [...sv2.conversations.keys()]) {
        const sid = state.sessions[key];
        if (sid) {
          delete state.sessions[key];
          // 与 retireSession / session-reset / workspace-reset 一致：先让 DSH 停下这个会话的活。
          // 少了这一步，DSH 会继续跑完在途/排队的 turn（token 照烧、副作用照做），
          // 而桥接这边已经把所有映射删掉 —— 输出被静默丢弃，agentToken 也已轮换（它的 MCP 发送全部 403）。
          h.stopRetiredSessionWork(sid, key);
          h.sessionModels().delete(sid);
          h.modelAppliedSessions().delete(sid);
          h.reverse().delete(sid);
          h.collectors().delete(sid);
          h.v2TurnStartAt().delete(sid);
          h.toolCallNames().delete(sid);
          h.pendingSendToolCalls().delete(sid);
          h.sendToolSucceededSessions().delete(sid);
          // 订阅也要退掉，否则它会在每次重连时被重新 follow 并重发整份快照。
          this.ctx.api.events.forget?.(sid);
        }
        delete state.sessionPolicies[key];
        h.forgetAgentToken(key);
        sv2.conversations.delete(key);
        h.seenForwardIds().delete(key);
      }
      h.saveState();
      h.pendingWakeKeys().clear();
      h.clearAllPendingWakeLeases();
      h.wakeConfigUpdatedKeys().clear();
      h.markReadCalledKeys().clear();
      h.wakeConfigMissCount().clear();
      sv2.paused = false;
      try {
        h.atomicWriteJson(h.socialV2File, { conversations: {} });
      } catch (error) {
        this.ctx.log('重置二代状态：写空状态文件失败:', error?.message ?? error);
      }
      this.ctx.log('控制台：二代 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
      sendJson({ ok: true });
    },
  },
  {
    method: 'GET',
    kind: 'exact',
    path: '/api/socialV2/states',
    handler({ req, sendJson }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      const h = this.ctx.coreHelpers;
      const list = [];
      for (const [key, st] of h.socialV2().conversations) {
        list.push({
          key,
          wakeConfig: st.wakeConfig,
          unreadCount: st.unread.length,
          recentCount: st.recentMessages.length,
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          noActionCount: st.wakeConfig.noActionCount || 0,
        });
      }
      sendJson({ ok: true, conversations: list });
    },
  },
  {
    // 手动唤醒。sendWakePromptV2 是异步的，这里**不 await**（不能让 HTTP 回复等一个
    // 可能卡几十秒的模型回合），但必须挂 catch —— 裸调用一旦 reject 就是
    // unhandledRejection，Node 会打警告甚至退出进程，而 HTTP 那边已经回了 ok:true。
    method: 'POST',
    kind: 'exact',
    path: '/api/socialV2/wake',
    async handler({ req, sendJson, readBody }) {
      if (rejectConsoleOnly({ req, sendJson })) return;
      const h = this.ctx.coreHelpers;
      const body = (await readBody()) ?? {};
      const key = String(body.key ?? '').trim();
      const reason = String(body.reason ?? 'admin').trim() || 'admin';
      if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
      if (h.currentMode() !== 'reserved2') { sendJson({ ok: false, error: '该接口仅 reserved2 模式可用' }, 403); return; }
      const keyMatch = /^(group|private):(\d+)$/.exec(key);
      if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
      const kind = keyMatch[1];
      const id = Number(keyMatch[2]);
      if (!Number.isFinite(id) || id <= 0 || !h.modeAllowed(key, kind, id, this.ctx.cfg, h.currentMode())) {
        sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
        return;
      }
      const st = h.getSocialV2State(key);
      if (st.pendingWakeTimer) {
        clearTimeout(st.pendingWakeTimer);
        st.pendingWakeTimer = null;
      }
      if (!st.bootstrapSent) st.bootstrapSent = true;
      h.saveSocialV2State();
      void h.sendWakePrompt(key, reason).catch((error) => this.ctx.log(`[reserved2] 手动唤醒异常 ${key}:`, error?.message ?? error));
      this.ctx.log(`控制台：手动唤醒 ${key}（${reason}）`);
      sendJson({ ok: true, key, reason });
    },
  },
];

export { WAKE_DEFAULT_KEYS, TOOL_FLAGS };
