// 模块：安全设置（控制台）
//
// 两条路由都是控制台用途：GET 报告拦截通知开关与 state/ 的 ACL 收紧结果，
// POST 改开关、或重试收紧 state/ 权限。
//
// 这里要搬的三样东西都依赖 main() 闭包里的东西：
//   · `stateDirHardened` 是 main() 里的 let，模块要**回写**它（否则控制台显示的是旧状态）；
//   · `hardenStateDirAcl()` 会重新赋值它，所以只能由 bridge 交进来一个 setter
//     （`ctx.setStateDirHardened(v)`），不能直接拿变量引用 —— 数字/布尔是值传递；
//   · `manualDirCommand(STATE_DIR)` 是 import 进来的纯函数。

/** 带 agent 凭据的请求一律拒绝（控制台专用接口）。返回 true 表示已拦下。 */
function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

export default {
  name: 'security',
  title: '安全设置（拦截通知 / state 目录 ACL）',
  inject: [
    'cfg', 'log', 'stateDir', 'getStateDirHardened', 'setStateDirHardened',
    'hardenStateDirAcl', 'manualDirCommand', 'readConfigObject', 'atomicWriteJson', 'configFile',
  ],

  routes: [
    {
      method: 'GET',
      kind: 'exact',
      path: '/api/security',
      async handler({ req, sendJson }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        sendJson({
          security: ctx.cfg.security ?? { interceptNotify: true },
          // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
          // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
          // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
          // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
          stateDir: {
            hardened: ctx.getStateDirHardened(),
            path: ctx.stateDir,
            manualCommand: process.platform === 'win32'
              ? ctx.manualDirCommand(ctx.stateDir)
              : `chmod 700 "${ctx.stateDir}"`,
          },
        });
      },
    },
    {
      method: 'POST',
      kind: 'exact',
      path: '/api/security',
      async handler({ req, sendJson, readBody }) {
        if (rejectAgent({ req, sendJson })) return;
        const ctx = this.ctx;
        const body = await readBody();
        // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
        if (body.rehardenStateDir === true) {
          ctx.setStateDirHardened(null);
          ctx.hardenStateDirAcl();
          sendJson({ ok: ctx.getStateDirHardened() === true, hardened: ctx.getStateDirHardened(), path: ctx.stateDir });
          return;
        }
        const file = ctx.readConfigObject(ctx.configFile);
        const next = { ...(file.security ?? {}), ...body };
        if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
        else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
        file.security = next;
        ctx.atomicWriteJson(ctx.configFile, file);
        ctx.cfg.security = { ...(ctx.cfg.security ?? {}), ...next };
        ctx.log(`控制台：安全拦截通知已更新（interceptNotify=${ctx.cfg.security.interceptNotify}）`);
        sendJson({ ok: true, security: ctx.cfg.security });
      },
    },
  ],
};
