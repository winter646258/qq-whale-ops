// ── 运行状态：GET /api/status ──────────────────────────────────────────
//
// 这是整条 if 链里唯一一个「刻意让智能体也能读到」的接口：它在 agent 白名单里
// （`url.pathname === '/api/status'`），所以搬进来之后**不能**套 rejectAgent，
// 而是要在内部按「智能体 / 操作者」分流成两个截然不同的对象。
//
// 分流的判据是 `x-agent-token || x-agent-call !== undefined` ——
// **两个头都要看**。只认 token 的老写法会让「不带令牌但打了 x-agent-call 的智能体调用」
// 落到下面那份完整对象上，等于把 A 群的 AI 变成管理端。这些都是跨群管理信息：
//   ownerQQ、allowGroups、allowPrivate、activity（含其它群的发言片段）、
//   snowluma（上游网关诊断 good/hint）、closedAgentPreset。
//
// `socialV2` 是 main() 里的 const 对象字面量（约 L10132），它的字段会被就地改写、
// 但对象引用本身不变 ⇒ 直接交引用是安全的；这里仍用访问器包一层，
// 免得未来有人把它改成 let 重新赋值。

async function getStatus({ req, sendJson }) {
  const ctx = this.ctx;
  const rs = ctx.readRoleState();
  // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
  if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
    sendJson({
      mode: ctx.currentMode(),
      role: rs.role ?? null,
      roleMode: rs.mode ?? 'active',
      dshReady: ctx.dshReady(),
      socialV2Paused: ctx.socialV2().paused,
    });
    return;
  }
  sendJson({
    mode: ctx.currentMode(),
    closedAgentPreset: ctx.closedAgentPreset(),
    role: rs.role ?? null,
    roleMode: rs.mode ?? 'active',
    dshReady: ctx.dshReady(),
    ownerQQ: ctx.cfg.ownerQQ ?? null,
    allowGroups: ctx.cfg.allow?.groups ?? [],
    allowPrivate: ctx.cfg.allow?.private ?? [],
    socialV2Paused: ctx.socialV2().paused,
    // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
    // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
    snowluma: ctx.snowlumaHealthSnapshot(),
    activity: ctx.readActivityTail(100),
  });
}

const inject = [
  'cfg', 'log', 'readRoleState', 'readActivityTail', 'snowlumaHealthSnapshot',
  'currentMode', 'dshReady', 'closedAgentPreset', 'socialV2',
];

const routes = [
  { method: 'GET', path: '/api/status', kind: 'exact', handler: getStatus },
];

export default { name: 'status', title: '运行状态（智能体只读受限视图）', inject, routes };
