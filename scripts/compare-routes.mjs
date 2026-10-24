#!/usr/bin/env node
/**
 * 比对两份黄金快照（scripts/golden-routes.mjs 的产物）。
 *
 * 只比「状态码 / 响应键形状 / ok 布尔」这三样，**不比 len**：
 * 会话数、工具日志条数、token 计量这些是活数据，每次跑都不一样，
 * 拿它们当回归标准只会天天报假差异。第一版连 len 一起比，13 条「差异」里
 * 有 11 条是这种噪声，真正要看的信号被埋掉了。
 *
 * 用法：node scripts/compare-routes.mjs <baseline.json> <current.json>
 * 退出码：0 = 无非预期差异；1 = 有
 */
import fs from 'node:fs';

const [aPath, bPath] = process.argv.slice(2);
if (!aPath || !bPath) { console.error('用法: node scripts/compare-routes.mjs <baseline> <current>'); process.exit(2); }
const a = JSON.parse(fs.readFileSync(aPath, 'utf8')).routes ?? {};
const b = JSON.parse(fs.readFileSync(bPath, 'utf8')).routes ?? {};

// 已搬到模块、从老 if 链删掉的路由：它们的「缺席」是预期内的。
// 这里刻意写死历史基线里的已知差异，新增模块时同步加一条，免得每次都要人肉判断。
// 已搬进模块、从老 if 链删掉的路由 —— 它们在当前快照里「缺席」属预期。
// 每做完一个阶段就往这里加一条，否则回归会把正常搬家报成故障。
const EXPECTED_MOVED = new Set([
  // 阶段2/3：role-console / security
  '/api/presets', '/api/role-mode', '/api/role', '/api/sessions', '/api/security',
  // 阶段4：role-console（人格管理）/ approval
  '/api/pending', '/api/roles', '/api/roles/content', '/api/roles/limit',
  '/api/roles/create', '/api/roles/update', '/api/roles/rename', '/api/roles/delete',
  // 阶段7：ops（DSH 连接 / 思考强度 / 读取授权 / 重启）
  '/api/dsh/model', '/api/dsh/effort', '/api/authorize/read', '/api/restart',
  // 阶段20：inspect（工具日志/反馈/我的最近/活跃成员 6 条）
  '/api/socialV2/tool-log', '/api/socialV2/tool-log/clear', '/api/socialV2/feedback',
  '/api/socialV2/feedback-clear', '/api/socialV2/my-recent', '/api/socialV2/active-members',
  // 阶段19：memory（记忆读写 5 条）
  '/api/socialV2/memory', '/api/socialV2/memory-append', '/api/socialV2/memory-update',
  '/api/socialV2/memory-remove', '/api/socialV2/memory-clear',
  // 阶段18：social（仿真群友模式配置/手动状态/摘要落盘）
  '/api/social', '/api/social/flush', '/api/social/state',
  // 阶段17：whitelist（白名单与管理员）
  '/api/whitelist',
  // 阶段16：image（生图 / 审批 / 画像）
  '/api/socialV2/image', '/api/socialV2/image-approval', '/api/socialV2/self-image',
  // 阶段5：preset（仿真提示词管理）
  '/api/preset/sim-prompt', '/api/preset/sim-prompt/backups', '/api/preset/sim-prompt/restore',
  // 阶段6：tokens（用量账本）。快照里 /api/tokens/ 是前缀探测产生的合成键。
  '/api/tokens', '/api/tokens/',
  '/api/tokens/summary', '/api/tokens/series', '/api/tokens/turns',
  '/api/tokens/recent', '/api/tokens/reset',
  '/api/stickers',
  '/api/stickers/sync',
  '/api/stickers/note',
  '/api/stickers/remark',
  '/api/socialV2/sticker-list',
  '/api/socialV2/sticker-image',
  '/api/socialV2/sticker-note',
  '/api/socialV2/sticker-remark',
  '/api/socialV2/voices',
  '/api/voice/list',
  '/api/status',
  '/api/test-send',
  '/api/phone/poll',
  '/api/phone/result',
  '/api/phone/status',
  // 阶段14：slang（黑话库管理）
  '/api/slang', '/api/slang/', '/api/slang/clear', '/api/slang/batch-delete',
  '/api/slang/batch-confirm', '/api/slang/batch-reject', '/api/slang/extract',
  '/api/slang/research', '/api/slang/config',
  // 阶段15：voice（操作者发送通道 + 别名）
  '/api/voice/send', '/api/send/voice',
  '/api/session/reset',
  '/api/workspace/reset',
]);
// 会随运行时间变化的路由：形状可以比，长度不行。
const keysOf = (r) => JSON.stringify([r.status, r.shape, r.ok]);

let bad = 0;
for (const k of Object.keys(a)) {
  if (!(k in b)) {
    if (EXPECTED_MOVED.has(k)) { console.log(`· 预期内缺席 ${k}（已搬到模块）`); continue; }
    console.log(`✗ MISSING ${k}`); bad += 1; continue;
  }
  for (const who of ['anon', 'console', 'agent']) {
    const x = a[k]?.[who], y = b[k]?.[who];
    if (!x || !y) { console.log(`✗ ${k} ${who} 缺身份`); bad += 1; continue; }
    if (keysOf(x) !== keysOf(y)) {
      console.log(`✗ ${k} ${who}\n    old ${keysOf(x)}\n    new ${keysOf(y)}`);
      bad += 1;
    }
  }
}
for (const k of Object.keys(b)) {
  if (!(k in a)) console.log(`+ NEW ${k}${k.startsWith('/api/_') ? '（诊断端点，预期）' : ''}`);
}
console.log(`\n比对 ${Object.keys(a).length} → ${Object.keys(b).length} 条；非预期差异 ${bad} 条`);
process.exit(bad ? 1 : 0);


