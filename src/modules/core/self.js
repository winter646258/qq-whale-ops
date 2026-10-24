import { rejectAi } from './shared.js';

// ── v2:core 的「她自己的那 3 条」：状态 / 唤醒配置 / 提示词 ────────────────────
//
// 这三条是她最常调的工具背后，鉴权口径统一：
//   只有带 x-agent-token 才校验 agentTokenOk → v2SessionAllowed → v2ToolEnabled。
//   不带令牌 = 控制台自己看。**不能套 rejectConsoleOnly**，那会把她挡在门外。
//
// 这里改动风险最高的是 set-wake-config：
//   · keywordsLocked —— AI 每次收尾都会把 qq_get_prompt 里那份推荐关键词原样写回来，
//     管理员设的关键词会被反复覆盖（10-23 实测一天 13 次）。带 agent token 时一律沿用现值。
//   · 概率上限 clampWakeProbabilityV2 / 永眠保护 / 沉睡前观察窗口，三处顺序都不能动。

function socialState({ req, url, sendJson }) {
  const h = this.ctx.coreHelpers;
  const key = String(url.searchParams.get('key') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'socialState', what: 'qq_social_state' })) return;
  const st = h.getSocialV2State(key);
  sendJson({
    ok: true,
    key,
    wakeConfig: st.wakeConfig,
    wakeSafety: h.wakeSafety(st.wakeConfig),
    unreadCount: st.unread.length,
    recentCount: st.recentMessages.length,
    lastWakeReason: st.lastWakeReason,
    lastAiReplyAt: st.lastAiReplyAt,
  });
}

async function getPrompt({ req, url, sendJson }) {
  const h = this.ctx.coreHelpers;
  const key = String(url.searchParams.get('key') ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'getPrompt', what: 'qq_get_prompt' })) return;

  const st = h.getSocialV2State(key);
  // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
  if (this.ctx.cfg.socialV2?.sticker?.enabled !== false) {
    try { await h.syncStickerLibrary(false); } catch {}
  }
  const roleState = h.readRoleState();
  // 工具清单映射表原本是 get_prompt 里的一段字面量（`// MARKER: ghosttool` 那条注释也在里面）。
  // 搬进模块后必须原样保留在这里，不能指望 bridge.js 交出来 —— 它从来没是个具名变量。
  const toolMap = {
    getPrompt: 'qq_get_prompt',
    getUnread: 'qq_get_unread_messages',
    getRecent: 'qq_get_recent_messages',
    socialState: 'qq_social_state',
    sendGroup: 'qq_send_group_message',
    sendPrivate: 'qq_send_private_message',
    reply: 'qq_reply',
    sendBurst: 'qq_send_burst',
    sendMessage: 'qq_send_message',
    waitMessages: 'qq_wait_for_messages',
    feedback: 'qq_report_feedback',
    getMyRecent: 'qq_get_my_recent_messages',
    getMessageDetail: 'qq_get_message_detail',
    getActiveMembers: 'qq_get_active_members',
    setWakeConfig: 'qq_set_wake_config',
    markRead: 'qq_mark_read',
    memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
    // 之前漏登记：提示词一直让她调 qq_memory_update，但这工具在 MCP 层
    // 根本不存在，且 toolMap 里也没有 ⇒ 她自己查工具清单都看不到它。
    memoryUpdate: 'qq_memory_update',
    image: 'qq_generate_image',
    slangQuery: 'qq_slang_query',
    slangSubmit: 'qq_slang_submit',
    getImages: 'qq_get_message_images',
    getForwardMsg: 'qq_get_forward_msg',
    sendPoke: 'qq_send_poke',
    listStickers: 'qq_list_stickers',
    getStickerImage: 'qq_get_sticker_image',
    sendSticker: 'qq_send_sticker',
    setStickerRemark: 'qq_set_sticker_remark',
    stickerNote: 'qq_sticker_note',
    collectSticker: 'qq_collect_sticker',
    getSelfImage: 'qq_get_self_image',
    sendVoice: 'qq_send_voice / qq_list_voices',
    // 日记/相册（窄作用域工具，见对应端点）
    diary: 'qq_diary',
    album: 'qq_album',
    // 日程/画像：规格里的两个新能力
    schedule: 'qq_schedule',
    portrait: 'qq_portrait',
    mood: 'qq_mood',
  };
  const tools = this.ctx.cfg.socialV2?.tools ?? {};
  const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker']);
  const enabledTools = [];
  for (const [flag, name] of Object.entries(toolMap)) {
    // 表情类工具额外受 sticker.enabled 总开关约束（关了就不该出现在清单里，否则她会一直调然后 403）。
    if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !h.stickerEnabled())) enabledTools.push(name);
  }
  sendJson({
    ok: true,
    key,
    time: new Date().toISOString(),
    role: { name: roleState.role ?? null, hint: h.currentMode() === 'reserved2' ? h.currentRoleHintV2() : h.currentRoleHint() },
    recommended: this.ctx.cfg.socialV2?.provideRecommendations === false ? null : {
      wake: this.ctx.cfg.socialV2?.wake ?? {},
      send: this.ctx.cfg.socialV2?.send ?? {},
      wait: this.ctx.cfg.socialV2?.wait ?? {},
      proactive: this.ctx.cfg.socialV2?.proactive ?? {},
    },
    enabledTools,
    replyTiming: h.replyTiming(st),
    unreadCount: st.unread.length,
    recentCount: st.recentMessages.length,
    currentWakeConfig: st.wakeConfig,
    wakeSafety: h.wakeSafety(st.wakeConfig),
    memory: h.formatMemory(st),
    // 日程/画像与 memory 同规格：唤醒里出现，主动查 qq_get_prompt 时也在。
    // 读失败只少这一段，不能让整个 prompt 接口 500。
    schedule: (() => {
      if (this.ctx.cfg.socialV2?.schedule?.enabled === false) return null;
      try { return h.formatSchedule(h.scheduleStore(), { key }); }
      catch (error) { this.ctx.log(`[reserved2] prompt 日程读取失败 ${key}：${error?.message ?? error}`); return null; }
    })(),
    portrait: (() => {
      if (this.ctx.cfg.socialV2?.portrait?.enabled === false) return null;
      try { return h.formatPortrait(h.portraitStore()); }
      catch (error) { this.ctx.log(`[reserved2] prompt 画像读取失败：${error?.message ?? error}`); return null; }
    })(),
    participation: h.formatParticipation(st),
    slang: {
      enabled: this.ctx.cfg.slang?.enabled !== false,
      entries: h.confirmedSlangList(),
      block: h.buildSlangContext(h.slangEntries(), this.ctx.cfg.slang?.injectMax ?? 8),
    },
    stickers: {
      enabled: this.ctx.cfg.socialV2?.sticker?.enabled !== false,
      total: h.stickerEntries().length,
      context: this.ctx.cfg.socialV2?.sticker?.includeInPrompt !== false ? h.buildStickerContext(h.stickerEntries(), this.ctx.cfg.socialV2?.sticker?.promptMaxStickers ?? 8, { allowIds: this.ctx.cfg.socialV2?.sticker?.allowIds }) : '',
      strategy: this.ctx.cfg.socialV2?.sticker?.includeInPrompt !== false ? h.buildStickerStrategyHint() : '',
    },
    // 语音库摘要：让她一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
    voices: this.ctx.cfg.socialV2?.voice?.enabled === false ? { enabled: false } : {
      enabled: true,
      total: h.voiceLibrary().length,
      names: h.voiceLibrary().slice(0, 12).map((v) => v.name),
      maxSeconds: h.voiceCfg().maxSeconds,
      hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去',
    },
  });
}

async function setWakeConfig({ req, sendJson, readBody }) {
  const h = this.ctx.coreHelpers;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx: this.ctx, req, sendJson, key, tool: 'setWakeConfig', what: 'qq_set_wake_config' })) return;

  const st = h.getSocialV2State(key);
  const throughSeq = h.requestedReadThroughSeq(st, body, !!req.headers['x-agent-token']);
  // 保留线上行为：markRead 被关掉时只更新唤醒配置，不改未读。
  const acknowledgeOnClose = throughSeq !== null && this.ctx.v2ToolEnabled('markRead');
  const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
  const current = st.wakeConfig;
  const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
  const normalizeTriggerBool = (name, fallback) => (name in inputTriggers ? inputTriggers[name] === true : fallback);

  const rawKeywords = inputTriggers.keywords;
  // MARKER: wake-keyword-lock
  const keywordsLocked = this.ctx.cfg.socialV2?.wake?.lockKeywords !== false && !!req.headers['x-agent-token'];
  const nextKeywords = (!keywordsLocked && rawKeywords !== undefined)
    ? (Array.isArray(rawKeywords)
        ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
        : [])
    : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);

  const next = {
    ...current,
    mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
    infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
    sleepUntil: current.sleepUntil,
    triggers: {
      ...current.triggers,
      atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
      nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
      question: normalizeTriggerBool('question', current.triggers.question === true),
      anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
      poke: normalizeTriggerBool('poke', current.triggers.poke === true),
      keywords: nextKeywords,
    },
    batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
      ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
      : current.batchWindowMs,
  };
  // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清掉，避免「潜水=每条都唤醒」的语义矛盾。
  if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) next.triggers.anyMessage = false;
  if (next.mode === 'active') {
    next.infinite = true;
    next.sleepUntil = null;
    next.triggers.anyMessage = true;
  }
  if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
  if (next.infinite) next.sleepUntil = null;

  if (input.sleepMs !== undefined && input.sleepMs !== null) {
    let ms = Math.max(0, Math.round(Number(input.sleepMs)));
    const minMs = Math.max(0, Number(this.ctx.cfg.socialV2?.wake?.sleepMinMs) || 0);
    const maxMs = Number(this.ctx.cfg.socialV2?.wake?.sleepMaxMs) || 0;
    if (ms < minMs) ms = minMs;
    if (maxMs > 0 && ms > maxMs) ms = maxMs;
    next.sleepUntil = new Date(Date.now() + ms).toISOString();
  } else if (!next.sleepUntil && !next.infinite) {
    // 既没有无限也没有时间：用推荐默认有限时长
    const recMin = Number(this.ctx.cfg.socialV2?.wake?.recommendedSleepMinMs) || 300000;
    const recMax = Number(this.ctx.cfg.socialV2?.wake?.recommendedSleepMaxMs) || 7200000;
    next.sleepUntil = new Date(Date.now() + Math.round(recMin + Math.random() * Math.max(0, recMax - recMin))).toISOString();
  }
  // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
  if (!next.infinite && next.sleepUntil) {
    const maxMs = Number(this.ctx.cfg.socialV2?.wake?.sleepMaxMs) || 0;
    const minMs = Math.max(0, Number(this.ctx.cfg.socialV2?.wake?.sleepMinMs) || 0);
    let until = Date.parse(next.sleepUntil);
    if (Number.isFinite(until)) {
      if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
      if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
      next.sleepUntil = new Date(until).toISOString();
    }
  }
  // 概率归一 + 上限（MARKER: probability-cap）：只做 0~1 的界等于不设防，AI 写 0.6 就照 0.6 用。
  if (next.triggers.probability !== undefined) {
    next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
    h.clampWakeProbability(key, next);
  }
  // 拍一拍只接受布尔，防脏字符串被当成 true
  if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
    next.triggers.poke = input.triggers.poke === true;
  }
  // 指定成员：只留正整数 QQ 号，去重限数量；null / 非法统一清空，免得「null」被当成有效唤醒条件绕过防永眠。
  next.triggers.speakerIds = h.normalizeSpeakerIds(next.triggers.speakerIds);
  if (key.startsWith('private:')) next.triggers.speakerIds = [];

  // 防永眠：无限期潜水必须至少留一个可触发条件。
  if (next.infinite) {
    const tr = next.triggers ?? {};
    const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0)
      || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
    if (!hasTrigger) {
      sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
      return;
    }
  }
  // 沉睡前强制观察窗口：除非对方明确结束、或已安静够久，否则不许聊两句就睡。
  if (h.isSleepingConfig(next) && h.preSleepWaitBlocked(st)) {
    const preSleepMs = Math.max(0, Number(this.ctx.cfg.socialV2?.wake?.preSleepWaitMs) || 300000);
    const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
    const remainMin = Math.ceil(remaining / 60000);
    sendJson({
      ok: false,
      error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
      preSleepWaitMs: preSleepMs,
      preSleepWaitRemainingMs: remaining,
    }, 400);
    return;
  }

  const markedCount = acknowledgeOnClose ? h.acknowledgeMessages(st, throughSeq) : 0;
  st.wakeConfig = next;
  st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
  st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
  st.wakeConfig.noActionCount = 0;
  st.wakeConfig.confirmedAt = Date.now();
  st.wakeConfig.confirmedBy = 'set_wake_config';
  st.lastActionAt = Date.now();
  // 已成功设置下一次唤醒：本轮沉睡前观察作废，下次想再睡需重新走观察窗口。
  st.preSleepWaitSatisfiedAt = 0;
  st.preSleepWaitObservedAt = 0;
  st.preSleepWaitAccumMs = 0;
  h.saveSocialV2State();
  h.wakeConfigUpdatedKeys().add(key);
  h.wakeConfigMissCount().delete(key);
  if (st.pendingWakeTimer) {
    clearTimeout(st.pendingWakeTimer);
    st.pendingWakeTimer = null;
  }
  h.cancelReplyCheck(key); // AI 已主动设置新的唤醒配置，取消回复检查
  h.setupSleepTimer(key);
  this.ctx.log(`[reserved2] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
  sendJson({
    ok: true,
    key,
    markedCount,
    unreadCount: st.unread.length,
    readThroughSeq: h.readThroughSeq(st),
    wakeConfig: next,
    wakeSafety: h.wakeSafety(next),
  });
}

export const selfRoutes = [
  { method: 'GET', kind: 'exact', path: '/api/socialV2/state', handler: socialState },
  { method: 'GET', kind: 'exact', path: '/api/socialV2/prompt', handler: getPrompt },
  { method: 'POST', kind: 'exact', path: '/api/socialV2/wake-config', handler: setWakeConfig },
];
