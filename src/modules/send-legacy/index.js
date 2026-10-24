// 发送护栏：`POST /api/send/{group,private,reply}`。
//
// 这段是老版发送通道，**护栏比 /api/socialV2/send-* 更密**，一条都不能少搬：
//   1. 只在 closed-agent / reserved2 下可用（chat/reserved 的自动转发已覆盖正常回复，
//      MCP 发送工具不应成为 prompt injection 的越权出口）；
//   2. AI 暂停时带令牌的调用一律拒；
//   3. reserved2 必须带 agent token；
//   4. 令牌走 agentTokenOkOrOwnerDelegate（允许主人私聊代发好友），
//      但**不能代发到主人自己的会话**（那条路没有 modeAllowed 复查，会真发出去）；
//   5. 工具开关 sendGroup / sendPrivate / reply 各自独立；
//   6. shouldBlockSilentReply 静默期拦截；
//   7. modeAllowed、replyToMessageId 形态、单条字数上限、SENSITIVE_RE；
//   8. 频率超限返回 429 且**明确要求不要重试**；发送失败要把预占的额度回滚，否则会假 429。
//
// 鉴权：这条不做 rejectAgent —— 它就是 AI 通道本身。

function wrap(fn) {
  return async function handler(args) {
    try {
      return await fn.call(this, args);
    } catch (error) {
      args.sendJson({ ok: false, error: error?.message ?? String(error) }, Number(error?.statusCode) || 500);
      return undefined;
    }
  };
}

const sendLegacy = wrap(async function sendLegacy({ req, url, sendJson, readBody }) {
  const ctx = this.ctx;
  const cfg = ctx.cfg;
  const socialV2 = ctx.socialV2();
  const body = await readBody();
  const token = String(body.token ?? '').trim();
  const isPrivate = url.pathname === '/api/send/private';
  const isReply = url.pathname === '/api/send/reply';
  const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
  const message = ctx.unquoteJsonString(String(body.message ?? '').trim());
  // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
  const replyToMessageId = body.replyToMessageId;
  const atUserId = body.atUserId ?? null;
  const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
  // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 reserved2（二代 AI 带会话令牌）下使用。
  const currentMode = ctx.currentMode();
  if (currentMode === 'chat' || currentMode === 'reserved') {
    sendJson({ ok: false, error: '发送工具仅限 closed-agent / reserved2 模式使用' }, 403);
    return undefined;
  }
  if (socialV2.paused && token) {
    sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
    return undefined;
  }
  if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return undefined; }
  if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return undefined; }
  if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
    sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
    return undefined;
  }
  if (currentMode === 'reserved2' && !token) { sendJson({ ok: false, error: 'reserved2 模式发送必须携带 agent token' }, 403); return undefined; }
  // 旧版 /api/send/* 也要认主人私聊代发。边界由 agentTokenOkOrOwnerDelegate 兜底：
  // 只放行「私聊 + 好友 + 过准入」，群发送仍然只能用自己的会话令牌。
  if (token && !ctx.agentTokenOkOrOwnerDelegate(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return undefined; }
  // 上面那行对「主人令牌发给自己」是放行的：主人私聊本来就是自己的会话，agentTokenOk 第一层就过。
  // 而 /api/send/* 这一段没有 modeAllowed 复查，消息会直接落到 sendMessagesV2 真发出去。
  // 代发这条路只用来发**给别人**，发自己的会话请用 qq_send_message。
  if (token && key === `private:${String(cfg.ownerQQ ?? '')}` && !ctx.agentTokenOk(key, token)) {
    sendJson({ ok: false, error: '不能代发到主人自己的会话：直接用自己的令牌走 qq_send_message' }, 403);
    return undefined;
  }
  const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
  if (token && !ctx.v2ToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return undefined; }
  if (ctx.shouldBlockSilentReply(key)) {
    sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
    return undefined;
  }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return undefined; }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !ctx.modeAllowed(key, kind, id, cfg, currentMode)) {
    sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return undefined;
  }
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
    sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
    return undefined;
  }
  let quotedInfo = null;
  let actualReplyToMessageId = replyToMessageId;
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const stForReply = ctx.getSocialV2State(key);
    const resolved = await ctx.resolveReplyTargetV2(stForReply, kind, id, String(replyToMessageId).trim());
    if (!resolved) {
      sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
      return undefined;
    }
    quotedInfo = resolved.info;
    actualReplyToMessageId = resolved.messageId;
  }
  const sendCfg = cfg.socialV2?.send ?? {};
  const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
  if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return undefined; }
  if (ctx.SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return undefined; }
  const st = ctx.getSocialV2State(key);
  const now = Date.now();
  try {
    const limits = ctx.resolveSendLimitsV2(key, sendCfg);
    const maxPerMinute = limits.maxPerMinute;
    const maxPerHour = limits.maxPerHour;
    const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
      sendJson({ ok: false, error: '发送频率超限。⚠️ 不要在本轮重试这条内容——重试只会继续失败；先 qq_wait_for_messages 等下一批消息，或直接结束本轮，等下次唤醒再说。' }, 429);
      return undefined;
    }
    st.sendTimes.push(now);
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    const sentMessages = await ctx.sendMessagesV2(key, [message], [], actualReplyToMessageId, atUserId);
    ctx.recordSentMessagesV2(key, sentMessages);
    st.lastAiReplyAt = now;
    st.lastActionAt = now;
    st.wakeConfig.noActionCount = 0;
    ctx.saveSocialV2State();
    ctx.log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
    ctx.appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
    if (sentMessages.length > 0) ctx.scheduleReplyCheckV2(key);
    sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
  } catch (error) {
    if (error?.sent?.length) {
      ctx.recordSentMessagesV2(key, error.sent);
      ctx.log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
    }
    // 失败/未发出的消息回滚预占的发送额度，避免假 429。
    const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
    const failedCount = Math.max(0, 1 - sentCount);
    for (let i = 0; i < failedCount; i += 1) {
      const idx = st.sendTimes.indexOf(now);
      if (idx >= 0) st.sendTimes.splice(idx, 1);
    }
    if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
    ctx.saveSocialV2State();
    sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
  }
  return undefined;
});

export default {
  name: 'send-legacy',
  title: '老版发送通道（护栏最密的那条）',
  inject: [
    'cfg', 'log', 'unquoteJsonString', 'SENSITIVE_RE', 'appendActivity',
    'currentMode', 'agentTokenOk', 'agentTokenOkOrOwnerDelegate', 'v2ToolEnabled', 'modeAllowed',
    'shouldBlockSilentReply', 'getSocialV2State', 'resolveReplyTargetV2', 'resolveSendLimitsV2',
    'sendMessagesV2', 'recordSentMessagesV2', 'saveSocialV2State', 'scheduleReplyCheckV2',
    'socialV2',
  ],
  routes: [
    { method: 'POST', path: '/api/send/group', kind: 'exact', handler: sendLegacy },
    { method: 'POST', path: '/api/send/private', kind: 'exact', handler: sendLegacy },
    { method: 'POST', path: '/api/send/reply', kind: 'exact', handler: sendLegacy },
  ],
};