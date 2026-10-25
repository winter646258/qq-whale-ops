// ── 仿真提示词管理（/api/preset/*）──────────────────────────────
//
// 这四条路由搬进模块前挂在 main() 的 if 链里（原 L4961–L5070）。
// 读的是「预设文件里 persona.prefix 那一段」，写会把源文件与 DSH 的安装
// 副本一起改掉 —— 所以保存与还原两侧都做**同样的安全不变量校验**
// （presetPromptBlockers），旧备份来自安全基线之前时还原会被拒。
//
// 写路由额外对待智能体一律 403（纵深防御，与 /api/roles 等模块同一口径）：
// 老 if 链里这几条对 agent 其实是无拦的，属于顺手收口。

const name = 'preset';
const title = '仿真提示词管理';

const inject = ['cfg', 'log', 'stateDir', 'fs', 'path', 'presetHelpers'];

const routes = [
  { method: 'GET', path: '/api/preset/sim-prompt', kind: 'exact', handler: readSimPrompt },
  { method: 'GET', path: '/api/preset/sim-prompt/backups', kind: 'exact', handler: listBackups },
  { method: 'POST', path: '/api/preset/sim-prompt', kind: 'exact', handler: saveSimPrompt },
  { method: 'POST', path: '/api/preset/sim-prompt/restore', kind: 'exact', handler: restoreSimPrompt },
];

/** 拒绝智能体调用。返回 true 表示已经响应完毕。 */
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

async function readSimPrompt({ req, url, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.presetHelpers;
  const preset = h.resolveName(url.searchParams.get('preset'));
  try {
    const { prefix } = h.readPromptText(preset);
    sendJson({
      ok: true,
      content: prefix,
      chars: prefix.length,
      bytes: Buffer.byteLength(prefix, 'utf8'),
      warnings: h.promptWarnings(prefix),
      status: h.status(preset),
      presets: Object.values(h.names).map((n) => h.status(n)),
    });
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: h.status(preset) }, 500);
  }
}

async function listBackups({ req, url, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.presetHelpers;
  try {
    sendJson({ ok: true, backups: h.listBackups(h.resolveName(url.searchParams.get('preset'))) });
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
  }
}

async function saveSimPrompt({ req, sendJson, readBody }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.presetHelpers;
  const fs = this.ctx.fs;
  const body = await readBody();
  const preset = h.resolveName(body.preset);
  let nextText;
  try {
    const { text, prefix } = h.readPromptText(preset);
    // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
    // 让一次「打开又保存」把整个提示词块变成全删全加的 diff，失去可复审性。
    const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
    if (normalized === prefix) {
      sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: h.promptWarnings(prefix), synced: fs.existsSync(h.installedYaml(preset)), requiresRestart: false, status: h.status(preset) });
      return;
    }
    nextText = h.renderPromptYaml(text, body.content, preset === h.names.v1 ? 'v1' : 'v2');
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
    return;
  }
  const warnings = h.promptWarnings(body.content);
  let sourceBackup = null;
  try {
    sourceBackup = h.backupFile(preset);
    h.atomicWriteText(h.sourceYaml(preset), nextText);
    // 同步到 DSH 实际读取的安装目录。
    // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
    // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
    const installed = h.installedYaml(preset);
    if (fs.existsSync(installed)) {
      fs.copyFileSync(h.sourceYaml(preset), installed);
    }
  } catch (error) {
    // 尽力回滚源文件，避免留下半截状态
    if (sourceBackup && fs.existsSync(sourceBackup)) {
      try { fs.copyFileSync(sourceBackup, h.sourceYaml(preset)); } catch {}
    }
    sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
    return;
  }
  this.ctx.log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
  sendJson({
    ok: true,
    chars: String(body.content ?? '').length,
    warnings,
    synced: fs.existsSync(h.installedYaml(preset)),
    requiresRestart: true,
    status: h.status(preset),
  });
}

async function restoreSimPrompt({ req, sendJson, readBody }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.presetHelpers;
  const fs = this.ctx.fs;
  const body = await readBody();
  const preset = h.resolveName(body.preset);
  try {
    const requested = String(body.file ?? '').trim();
    const candidates = h.listBackups(preset).map((b) => b.file);
    const target = requested || candidates[0];
    // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
    if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
    const backupPath = this.ctx.path.join(h.backupDir, target);
    const restored = fs.readFileSync(backupPath, 'utf8');
    const restoredPrefix = h.extractPrefix(restored);
    if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
    // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
    // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
    // 不变量清单**按预设取**：一代本来就没有「你没有本地工具」这类工具面表述。
    const blockers = h.promptBlockers(restoredPrefix, preset === h.names.v1 ? 'v1' : 'v2');
    if (blockers.length) {
      sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
      return;
    }
    h.backupFile(preset);
    h.atomicWriteText(h.sourceYaml(preset), restored);
    const installed = h.installedYaml(preset);
    if (fs.existsSync(installed)) fs.copyFileSync(h.sourceYaml(preset), installed);
    this.ctx.log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
    sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
  } catch (error) {
    sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
  }
}

export default { name, title, inject, routes };

