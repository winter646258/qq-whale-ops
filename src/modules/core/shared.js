// v2:core 的共享小工具：跨文件共用的鉴权判定与数值归一。
//
// 单独放一个文件是因为 self.js / config.js / messages.js 三处都要用 rejectAi，
// 而 rejectConsoleOnly 又只在 config.js 用 —— 混在任一个业务文件里都会让
// 「这条路由凭什么被拒」变得难查，这里一眼能看到全部口径。

/** 控制台专用：带智能体身份的一律 403（判 x-agent-call 与 x-agent-token 两种写法）。 */
export function rejectConsoleOnly({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

/** 智能体工具面：只有带 x-agent-token 才校验，三道门顺序固定，不能交换。 */
export function rejectAi({ ctx, req, sendJson, key, tool, what }) {
  if (!req.headers['x-agent-token']) return false;
  if (!ctx.agentTokenOk(key, req.headers['x-agent-token'])) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403);
    return true;
  }
  if (!ctx.v2SessionAllowed(key)) {
    sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true;
  }
  if (!ctx.v2ToolEnabled(tool)) {
    sendJson({ ok: false, error: `工具未启用：${what}` }, 403);
    return true;
  }
  return false;
}

export function num(value, fallback, { min = 0 } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.round(n));
}

export function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
