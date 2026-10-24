// ── 控制台测试发送：POST /api/test-send ────────────────────────────────
//
// 这条路是「操作者手动发一条」的入口（控制台面板上的试发按钮），
// 所以它**没有** agent 分支、也不该有 —— 但同样不套 rejectAgent：
// 集中闸门的 agent 白名单本来就不含 /api/test-send，智能体走不到这里；
// 加一层只会在未来放开白名单时悄悄改变语义。
//
// 真正要保住的校验顺序（错一步就会漏发或误发）：
//   kind 归一（只认 'private'，其余一律 'group'）
//     → id 必须是正的有限数
//     → message 非空
//     → SENSITIVE_RE 拦敏感信息（403）
//     → allowed(kind, id, cfg) 白名单（403）
//     → modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode) 模式（403）
//     → escapeCqText(redactKnownTokensOnly(message)) 才真正发出去
// 最后那层转义不能省：控制台里写的 [CQ:...] 不能被当成真的 CQ 码执行。

async function testSend({ sendJson, readBody }) {
  const ctx = this.ctx;
  const body = await readBody();
  const kind = body.kind === 'private' ? 'private' : 'group';
  const id = Number(body.id);
  const message = String(body.message ?? '').trim();
  if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
  if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
  if (ctx.SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
  const mode = ctx.currentMode();
  if (!ctx.allowed(kind, id, ctx.cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
  if (!ctx.modeAllowed(`${kind}:${id}`, kind, id, ctx.cfg, mode)) {
    sendJson({ ok: false, error: `当前模式（${mode}）不允许向 ${kind}:${id} 发送测试消息` }, 403);
    return;
  }
  try {
    const safeMessage = ctx.escapeCqText(ctx.redactKnownTokensOnly(message));
    const result = kind === 'private'
      ? await ctx.bot.sendPrivateMessage(id, ctx.voiceHelpers.text(safeMessage))
      : await ctx.bot.sendGroupMessage(id, ctx.voiceHelpers.text(safeMessage));
    ctx.log(`控制台：测试发送 ${kind}:${id} 成功`);
    sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
  } catch (error) {
    sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
  }
}

// 依赖来源分三类，注入写法不同：
//   SENSITIVE_RE        —— 顶层 import（./sensitive.js），交引用
//   allowed / escapeCqText —— 顶层函数，交引用（bridge.js 的 moduleCtx 注入了它们）
//   redactKnownTokensOnly / modeAllowed —— main() 内的函数，且声明在注入点之后，只能包箭头
//   bot                 —— main() 里 late 绑定（L14045 才 new），必须走访问器
//   voiceHelpers.text   —— @snowluma/sdk 的 text()，由已有模块顺带提供，先复用不另注入
const inject = [
  'cfg', 'log', 'bot', 'allowed', 'modeAllowed', 'currentMode',
  'SENSITIVE_RE', 'escapeCqText', 'redactKnownTokensOnly', 'voiceHelpers',
];

const routes = [
  { method: 'POST', path: '/api/test-send', kind: 'exact', handler: testSend },
];

export default { name: 'test-send', title: '控制台测试发送', inject, routes };
