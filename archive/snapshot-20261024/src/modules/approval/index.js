// 模块：挂起审批 / 提问的只读清单（控制台）
//
// `/api/pending` 是控制台用来显示「这个会话卡在等谁」的接口：AI 触发的审批、
// 需要用户回答的提问，都挂在 `pending` 这个 Map 上（key -> { kind, rpcId, ... }）。
//
// 注意：`pending` 是 main() 里的 `const`，从不被整体重新赋值（只 add/delete/clear），
// 所以可以直接把 Map 引用交进来；如果哪天改成 `let` 重新赋值，这里就会读到旧对象。

/** 带 agent 凭据的请求一律拒绝（控制台专用接口）。返回 true 表示已拦下。 */
/**
 * 拒绝智能体调用。返回 true 表示已经响应完毕。
 *
 * 口径与 bridge.js 里 image-approval 那处**逐字一致**：只要带了 `x-agent-call`，
 * 或者 `x-agent-token` 是非空串，就认定是智能体调用。
 *
 * 为什么不能只判 `x-agent-token === undefined`：MCP 端在缺令牌时会带
 * `x-agent-call: 1` + 空串令牌（详见 bridge.js 里 x-agent-call 闸门的注释）。
 * 只判 undefined 会把这种调用当成控制台，**漏令牌 = 升级成全权**，
 * 正是那个闸门要堵的 confused deputy。
 */
function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

export default {
  name: 'approval',
  title: '挂起审批 / 提问清单',
  inject: ['pending'],

  routes: [
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/pending',
      async handler({ req, sendJson }) {
        if (rejectAgent({ req, sendJson })) return;
        const list = [];
        for (const [key, p] of this.ctx.pending.entries()) {
          list.push({
            key,
            kind: p.kind,
            sessionId: p.sessionId,
            ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
            ...(p.kind === 'question' ? { questions: p.questions } : {}),
          });
        }
        sendJson({ pending: list });
      },
    },
  ],

  setup(ctx) {
    // Map 引用只在这个进程里有效，确认一下类型，免得装载后第一次请求才炸。
    if (!(ctx.pending instanceof Map)) throw new Error('ctx.pending 不是 Map');
  },
};
