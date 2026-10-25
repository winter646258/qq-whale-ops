// 运行模式切换：`POST /api/mode`。
//
// 三处状态必须一起写：
//   1. 本地 `state/mode.json`（重启后据此恢复）；
//   2. 写穿 DSH 设置 `qq-mode`（refreshMode 每 5 秒轮询且以 DSH 为准，
//      只写本地会在下一轮被静默回滚）；
//   3. 内存里的 currentMode / lastMode（下游全是 `=== 'reserved2'` 判断）。
// 写穿的是**内部拼写**（`simulation` → `reserved2`），否则下游判断会失效。
//
// 离开模式时要清对应定时器与排队投递；模式比较必须用归一后的值（拿 body.mode 比会把
// `simulation` 与 `reserved2` 当成两种模式，在模式没变时误清定时器）。
//
// 鉴权：只给控制台。智能体进程同样持有 x-console-token，集中闸门挡不住它。

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

const setMode = wrap(async function setMode({ req, sendJson, readBody }) {
  const ctx = this.ctx;
  if (rejectAgent({ req, sendJson })) return undefined;
  const body = await readBody();
  const requestedMode = ctx.normalizeModeInput(body.mode);
  if (!requestedMode) {
    sendJson({ ok: false, error: `mode 必须是 ${ctx.VALID_MODES.join(' / ')}（simulation 为 reserved2 的规范名）` }, 400);
    return undefined;
  }
  const modeFile = ctx.path.join(ctx.stateDir, 'mode.json');
  const existing = ctx.readJsonSafe(modeFile, {});
  const next = {
    mode: requestedMode,
    // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
    ...(body.closedAgentPreset !== undefined
      ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
      : { closedAgentPreset: String(existing.closedAgentPreset ?? '') }),
  };
  ctx.atomicWriteJson(modeFile, next);
  ctx.setClosedAgentPreset(next.closedAgentPreset);

  let dshSynced = false;
  try {
    // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
    // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
    ctx.unwrap(await ctx.api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
    dshSynced = true;
  } catch (error) {
    ctx.log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
  }

  const currentMode = ctx.currentMode();
  if (currentMode === 'reserved' && requestedMode !== 'reserved') {
    ctx.cleanupSocialForModeChange();
    ctx.log('控制台：模式离开一代仿真模式，清理社交状态');
  }
  if (currentMode === 'reserved2' && requestedMode !== 'reserved2') {
    ctx.clearAllSocialV2Timers();
    ctx.drainAllPromptQueues('模式切换，已取消排队中的投递');
    ctx.log('控制台：模式离开二代仿真模式，清理 reserved2 定时器与排队投递');
  }
  ctx.setMode(requestedMode);
  ctx.reconcileSessionPolicies();
  if (requestedMode === 'reserved2') {
    const socialV2 = ctx.socialV2();
    for (const key of socialV2.conversations.keys()) {
      ctx.setupSleepTimerV2(key);
      ctx.scheduleProactiveCheckV2(key);
    }
    ctx.log('控制台：模式进入二代仿真模式，重建有限睡眠定时器');
  }
  ctx.log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
  sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
  return undefined;
});

export default {
  name: 'mode',
  title: '运行模式切换',
  inject: [
    'path', 'stateDir', 'log', 'api', 'unwrap',
    'normalizeModeInput', 'VALID_MODES', 'readJsonSafe', 'atomicWriteJson',
    'setClosedAgentPreset', 'setMode', 'currentMode', 'socialV2',
    'cleanupSocialForModeChange', 'clearAllSocialV2Timers', 'drainAllPromptQueues',
    'reconcileSessionPolicies', 'setupSleepTimerV2', 'scheduleProactiveCheckV2',
  ],
  routes: [
    { method: 'POST', path: '/api/mode', kind: 'exact', handler: setMode },
  ],
};