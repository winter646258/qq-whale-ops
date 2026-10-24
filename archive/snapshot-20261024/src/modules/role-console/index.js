// 模块：人格 / 预设相关的小接口
//
// 为什么从这几条开始：
//   scripts/classify-routes.mjs 量过——这四条闭包 0、只碰 cfg/state/RoleState 与 `api`，
//   不碰会话状态、不碰消息队列，搬走之后行为可以逐字节比对。
//
// 这些接口都是**控制台**用途（AI 不该调），所以模块里补一道
// 「带 agent token 就拒绝」——与 adminOnlyV2Paths 同一个先例，纵深防御。

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
  name: 'role-console',
  title: '人格 / 预设 / 会话（控制台）',
  inject: [
    'api', 'unwrap', 'state', 'readRoleState', 'writeRoleState',
    'sanitizeRoleName', 'rolesDirExists',
    // 人格管理一整族用到的常量与纯函数（都是文件级的，不碰 main() 闭包）
    'roleSummaries', 'roleHelpers',
  ],

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
    // ── 人格管理（7 条）────────────────────────────────────────────────────
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/roles',
      async handler({ req, sendJson }) {
        if (rejectAgent({ req, sendJson })) return;
        const rs = this.ctx.readRoleState();
        const summaries = this.ctx.roleSummaries();
        sendJson({
          // roles 保持「人格名字符串数组」的既有契约（scripts/test-console.mjs 等调用方依赖它）；
          // 富信息放在 summaries 里，新老调用方互不影响。
          roles: summaries.map((role) => role.name),
          summaries,
          current: rs.role ?? null,
          limits: { nameMax: this.ctx.roleHelpers.NAME_MAX, contentMaxBytes: this.ctx.roleHelpers.CONTENT_MAX_BYTES, injectMaxChars: this.ctx.roleHelpers.getInjectMaxChars() },
        });
      },
    },
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/roles/content',
      async handler({ req, sendJson, url }) {
        if (rejectAgent({ req, sendJson })) return;
        const h = this.ctx.roleHelpers;
        let name;
        try { name = h.validateName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!h.fileExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        const content = h.readContent(name);
        sendJson({
          ok: true,
          name,
          content,
          chars: content.length,
          bytes: Buffer.byteLength(content, 'utf8'),
          warnings: h.warnings(content, 'v2', this.ctx.cfg.role?.allowCjkSpaces !== false),
          limits: { injectMaxChars: h.getInjectMaxChars() },
          stats: h.charStats(content),
          // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
          sections: { v1: h.sectionReport(content, 'v1'), v2: h.sectionReport(content, 'v2') },
        });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/roles/limit',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const h = ctx.roleHelpers;
        const body = await readBody();
        const next = h.applyInjectLimit(body.maxInjectChars);
        const file = ctx.readConfigObject(ctx.configFile);
        file.role = { ...(file.role ?? {}), maxInjectChars: next };
        ctx.atomicWriteJson(ctx.configFile, file);
        ctx.cfg.role = { ...(ctx.cfg.role ?? {}), maxInjectChars: next };
        h.setInjectMaxChars(next);
        ctx.log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
        sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/roles/create',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const h = ctx.roleHelpers;
        const body = await readBody();
        let name; let content;
        try { name = h.validateName(body.name); content = h.validateContent(body.content); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (h.fileExists(name)) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
        h.writeContent(name, content);
        ctx.log(`控制台：创建人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, warnings: h.warnings(content, 'v2', ctx.cfg.role?.allowCjkSpaces !== false) });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/roles/update',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const h = ctx.roleHelpers;
        const body = await readBody();
        let name; let content;
        try { name = h.validateName(body.name); content = h.validateContent(body.content); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!h.fileExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        h.writeContent(name, content);
        ctx.log(`控制台：更新人格「${name}」（${content.length} 字符）`);
        sendJson({ ok: true, role: name, chars: content.length, warnings: h.warnings(content, 'v2', ctx.cfg.role?.allowCjkSpaces !== false) });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/roles/rename',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const h = ctx.roleHelpers;
        const body = await readBody();
        let from; let to;
        try { from = h.validateName(body.from); to = h.validateName(body.to); }
        catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
        if (!h.fileExists(from)) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
        if (h.fileExists(to)) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
        h.renameFile(from, to);
        const rs = ctx.readRoleState();
        const switched = rs.role === from;
        if (switched) ctx.writeRoleState(to, rs.mode);
        ctx.log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
        sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/roles/delete',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const h = ctx.roleHelpers;
        const body = await readBody();
        let name;
        try { name = h.validateName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
        if (!h.fileExists(name)) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
        h.removeFile(name);
        const rs = ctx.readRoleState();
        const cleared = rs.role === name;
        if (cleared) ctx.writeRoleState(null, rs.mode);
        ctx.log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
        sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
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
