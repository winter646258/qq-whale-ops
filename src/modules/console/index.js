// 控制台管理接口：控制台访问令牌轮换 + 向指定会话投递后台提醒。
//
// 鉴权：这一族只给操作者。集中闸门挡不住智能体进程（它同样持有 x-console-token），
// 必须自己用统一口径拒绝 —— x-agent-call 存在或 x-agent-token 非空一律 403。
//
// 依赖：crypto / cfg / log / stateDir / rootDir / path（基础块）+ readConfigObject /
// atomicWriteJson / atomicWriteText / readRoleState / getSocialV2State / deliverPrompt /
// appendActivity / social / ensureSession / modeAllowed / allowed / dshReady 访问器 /
// currentMode 访问器 / consoleTokenSet 访问器。

function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

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

/** 控制台访问令牌轮换（留空 = 生成随机令牌）。 */
const rotateToken = wrap(async function rotateToken({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  if (rejectAgent({ req, sendJson })) return undefined;
  const body = await readBody();
  let newToken = String(body.token ?? '').trim();
  const generated = !newToken;
  if (generated) {
    newToken = ctx.crypto.randomBytes(24).toString('hex');
  }
  if (newToken.length < 16) {
    sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
    return undefined;
  }
  if (newToken.length > 128) {
    sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
    return undefined;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
    sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
    return undefined;
  }
  const configFile = ctx.path.join(ctx.rootDir, 'config.json');
  const file = ctx.readConfigObject(configFile);
  // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
  file.consoleToken = generated ? '' : newToken;
  ctx.atomicWriteJson(configFile, file);
  ctx.cfg.consoleToken = generated ? '' : newToken;
  ctx.atomicWriteText(ctx.path.join(ctx.stateDir, 'console-token'), newToken);
  ctx.consoleTokenSet(newToken);
  ctx.log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
  sendJson({ ok: true, token: newToken, generated });
  return undefined;
});

/** 后台控制端引导：向指定会话的 DSH agent 投递提醒。 */
const notifyAi = wrap(async function notifyAi({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  if (rejectAgent({ req, sendJson })) return undefined;
  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const message = String(body.message ?? '').trim();
  if (!key || !message) {
    sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
    return undefined;
  }
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) {
    sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
    return undefined;
  }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0) {
    sendJson({ ok: false, error: 'id 无效' }, 400);
    return undefined;
  }
  const currentMode = ctx.currentMode();
  if (!ctx.modeAllowed(key, kind, id, ctx.cfg, currentMode)) {
    sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
    return undefined;
  }
  const state = ctx.helpers.state();
  if (!state.sessions[key] && !ctx.allowed(kind, id, ctx.cfg)) {
    sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
    return undefined;
  }
  if (!ctx.dshReady()) {
    sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
    return undefined;
  }
  const isV2 = currentMode === 'reserved2';
  const roleState = ctx.readRoleState();
  const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
  // 二代必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
  let tokenLine = '';
  if (isV2) {
    const stV2 = ctx.getSocialV2State(key);
    tokenLine = `【会话令牌】${stV2.agentToken}（调用二代状态/发送工具时请在参数中带上此令牌）\n\n`;
  }
  const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isV2 ? '当前是二代仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
  let sessionId = null;
  let popSilent = null;
  try {
    sessionId = await ctx.ensureSession(key);
    const social = ctx.helpers.social();
    const silentId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const arr = social.silentTurns.get(sessionId) ?? [];
    social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
    popSilent = () => {
      const list = social.silentTurns.get(sessionId) ?? [];
      const next = list.filter((x) => x.id !== silentId);
      if (next.length > 0) social.silentTurns.set(sessionId, next);
      else social.silentTurns.delete(sessionId);
    };
    const result = await ctx.deliverPrompt(key, promptText, { silent: true });
    if (result.ok) {
      ctx.log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
      ctx.appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
      sendJson({ ok: true, key, sessionId });
    } else {
      popSilent();
      sendJson({ ok: false, error: result.error || '投递失败' }, 500);
    }
  } catch (error) {
    if (popSilent) popSilent();
    sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
  }
  return undefined;
});

export default {
  name: 'console',
  title: '控制台管理（令牌轮换 / 后台提醒）',
  inject: [
    'cfg', 'log', 'stateDir', 'rootDir', 'path', 'crypto',
    'readConfigObject', 'atomicWriteJson', 'atomicWriteText',
    'readRoleState', 'getSocialV2State', 'deliverPrompt', 'appendActivity',
    'ensureSession', 'modeAllowed', 'allowed', 'helpers',
    'dshReady', 'currentMode', 'consoleTokenSet',
  ],
  routes: [
    { method: 'POST', path: '/api/console/token', kind: 'exact', handler: rotateToken },
    { method: 'POST', path: '/api/console/notify-ai', kind: 'exact', handler: notifyAi },
  ],
};