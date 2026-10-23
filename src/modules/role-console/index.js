// 模块：人格 / 预设相关的小接口（阶段 2 的第一批试点）
//
// 为什么从这两条开始：
//   scripts/classify-routes.mjs 量过——`GET /api/presets` 闭包 0、只碰 `api` 一个句柄；
//   `POST /api/role-mode` 只调两个文件级函数 readRoleState / writeRoleState。
//   它们不碰会话状态、不碰消息队列，搬走之后行为可以逐字节比对。
//
// 这两个接口都是**控制台**用途（AI 不该调），所以模块里再补一道
// 「带 agent token 就拒绝」——与 adminOnlyV2Paths 同一个先例，纵深防御。

/** 带 agent 凭据的请求一律拒绝（控制台专用接口）。 */
function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

export default {
  name: 'role-console',
  title: '人格 / 预设（控制台小接口）',
  inject: ['api', 'unwrap', 'readRoleState', 'writeRoleState'],

  routes: [
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/presets',
      async handler({ req, sendJson }) {
        if (rejectAgent({ req, sendJson })) return;
        let presets = [];
        try {
          const { presets: list } = this.ctx.unwrap(await this.ctx.api.agentPresets.list({}), 'agentPreset.list');
          presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
        } catch {}
        sendJson({ presets });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/role-mode',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const body = await readBody();
        const rs = this.ctx.readRoleState();
        const mode = body.mode === 'silent' ? 'silent' : 'active';
        this.ctx.writeRoleState(rs.role, mode);
        this.ctx.log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
        sendJson({ ok: true, roleMode: mode });
      },
    },
  ],

  setup(ctx) {
    // inject 只校验了键存在，这里再确认类型 —— 装载期发现问题好过运行期。
    if (typeof ctx.api?.agentPresets?.list !== 'function') {
      throw new Error('ctx.api.agentPresets.list 不可用（DSH 客户端版本不匹配？）');
    }
    if (typeof ctx.readRoleState !== 'function') throw new Error('ctx.readRoleState 不是函数');
  },
};
