// 模块：人格 / 预设相关的小接口
//
// 为什么从这几条开始：
//   scripts/classify-routes.mjs 量过——这四条闭包 0、只碰 cfg/state/RoleState 与 `api`，
//   不碰会话状态、不碰消息队列，搬走之后行为可以逐字节比对。
//
// 这些接口都是**控制台**用途（AI 不该调），所以模块里补一道
// 「带 agent token 就拒绝」——与 adminOnlyV2Paths 同一个先例，纵深防御。

/** 带 agent 凭据的请求一律拒绝（控制台专用接口）。返回 true 表示已拦下。 */
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
  inject: ['api', 'unwrap', 'state', 'readRoleState', 'writeRoleState', 'sanitizeRoleName', 'rolesDirExists'],

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
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/role',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const body = await readBody();
        const rs = this.ctx.readRoleState();
        if (body.role && typeof body.role === 'string') {
          const name = this.ctx.sanitizeRoleName(body.role);
          if (!this.ctx.rolesDirExists(name)) {
            sendJson({ ok: false, error: `角色「${name}」不存在（roles/${name}.md）` }, 400);
            return;
          }
          this.ctx.writeRoleState(name, rs.mode);
          this.ctx.log(`控制台：角色已设置为 ${name}`);
          sendJson({ ok: true, role: name });
        } else {
          this.ctx.writeRoleState(null, rs.mode);
          this.ctx.log('控制台：角色已清除');
          sendJson({ ok: true, role: null });
        }
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/sessions',
      async handler({ req, sendJson }) {
        if (rejectAgent({ req, sendJson })) return;
        const list = [];
        for (const [key, sessionId] of Object.entries(this.ctx.state.sessions)) {
          list.push({ key, sessionId, owner: key === `private:${String(this.ctx.cfg.ownerQQ ?? '')}` });
        }
        sendJson({ sessions: list });
      },
    },
  ],

  setup(ctx) {
    // inject 只校验键存在，这里再确认类型 —— 装载期发现问题好过运行期。
    if (typeof ctx.api?.agentPresets?.list !== 'function') {
      throw new Error('ctx.api.agentPresets.list 不可用（DSH 客户端版本不匹配？）');
    }
    if (typeof ctx.readRoleState !== 'function') throw new Error('ctx.readRoleState 不是函数');
  },
};
