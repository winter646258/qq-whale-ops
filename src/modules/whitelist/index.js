// ── 白名单可视化编辑（/api/whitelist）─────────────────────────────────
//
// 阶段17。原先挂在 main() 的 if 链 L5173/L5177。
//
// 这两条路由改的是「谁能跟机器人说话」，是整个桥接最硬的边界之一，所以：
//   ① 只在控制台开放 —— 智能体进程同时握着 x-console-token，集中闸门挡不住它，
//      必须在 handler 里自己拒（与其它控制台模块同一套 rejectAgent 口径）；
//   ② 读 config.json 时 fail-fast —— 文件损坏就 500，绝不回写。
//      回写过一次坏文件会把整个配置清成只剩 allow/deny/ownerQQ，那是运维事故级；
//   ③ ownerQQ 空值 = 清除管理员（fail-closed），非法值拒绝写入。
//
// POST 既写盘也热更新内存，最后调 reconcileSessionPolicies() 把已开的会话
// 按新白名单重新裁决 —— 不然改完得重启才生效。

function rejectAgent({ req, sendJson }) {
  if (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '') {
    sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
    return true;
  }
  return false;
}

function toNumList(arr) {
  if (!Array.isArray(arr)) return undefined;
  return [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))];
}

async function listWhitelist({ req, sendJson }) {
  const { cfg } = this.ctx;
  if (rejectAgent({ req, sendJson })) return;
  sendJson({
    allow: cfg.allow ?? { private: [], groups: [] },
    deny: cfg.deny ?? { private: [], groups: [] },
    ownerQQ: cfg.ownerQQ ?? null
  });
}

async function saveWhitelist({ req, sendJson, readBody }) {
  const { cfg, log, path, rootDir, readConfigObject, atomicWriteJson, normalizeOwnerQQ, reconcileSessionPolicies } = this.ctx;
  if (rejectAgent({ req, sendJson })) return;
  const body = (await readBody()) ?? {};
  const configFile = path.join(rootDir, 'config.json');
  // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
  const file = readConfigObject(configFile);
  const allow = {
    private: toNumList(body.allow?.private) ?? (file.allow?.private ?? []),
    groups: toNumList(body.allow?.groups) ?? (file.allow?.groups ?? [])
  };
  const deny = {
    private: toNumList(body.deny?.private) ?? (file.deny?.private ?? []),
    groups: toNumList(body.deny?.groups) ?? (file.deny?.groups ?? [])
  };
  // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
  let ownerQQ = cfg.ownerQQ ?? null;
  if (body.ownerQQ !== undefined) {
    try {
      ownerQQ = normalizeOwnerQQ(body.ownerQQ);
    } catch (error) {
      sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
      return;
    }
  }
  file.allow = allow;
  file.deny = deny;
  file.ownerQQ = ownerQQ;
  atomicWriteJson(configFile, file);
  // 热更新：allow/deny 只有两个数组，整体替换是安全的（没有别处长期握着这两个数组）。
  cfg.allow = { private: allow.private, groups: allow.groups };
  cfg.deny = { private: deny.private, groups: deny.groups };
  cfg.ownerQQ = ownerQQ;
  reconcileSessionPolicies();
  log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
  sendJson({ ok: true, allow, deny, ownerQQ });
}

const routes = [
  { method: 'GET', path: '/api/whitelist', kind: 'exact', handler: listWhitelist },
  { method: 'POST', path: '/api/whitelist', kind: 'exact', handler: saveWhitelist },
];

export default {
  name: 'whitelist',
  title: '白名单与管理员',
  inject: ['cfg', 'log', 'path', 'rootDir', 'readConfigObject', 'atomicWriteJson', 'normalizeOwnerQQ', 'reconcileSessionPolicies'],
  routes,
};
