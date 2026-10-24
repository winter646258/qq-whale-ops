// ── DSH 连接 / 思考强度 / 读取授权 / 重启（运维与鉴权族）────────────
//
// 这四条原来散落在 bridge.js 的 if 链里（L5302 / L5349 / L9066 / L9386），
// 但因为共享同一组「ai / 思考强度 / 鉴权 / 退出」语义，合并成一个模块更清楚。
//
// 全部只给控制台用：模块内各自 `rejectAgent()`，与 agent 白名单
// （bridge.js 里那条 `agentAllowed`）互为纵深防御。注意 /api/authorize/read
// 是目前唯一**在 agent 白名单里**的端点 —— 它是给 MCP 的旧只读工具用来换读取
// 授权的，所以它必须允许 agent 流量，但要求 key+token 双校验，行为原样保留。
//
// let 变量（modelSelectionEpoch / modelCatalogInFlight / currentMode）
// 都通过 this.ctx 的访问器读写，不交快照值。

const inject = ['cfg', 'log', 'stateDir', 'dshHelpers', 'agentTokenOk'];

const routes = [
  { method: 'GET', path: '/api/dsh/model', kind: 'exact', handler: dshModel },
  { method: 'POST', path: '/api/dsh/effort', kind: 'exact', handler: dshEffort },
  { method: 'POST', path: '/api/authorize/read', kind: 'exact', handler: authorizeRead },
  { method: 'POST', path: '/api/restart', kind: 'exact', handler: restart },
];

/** 拒绝智能体调用。返回 true 表示已经响应完毕。 */
function rejectAgent(req, sendJson) {
  if (req.headers['x-agent-token'] === undefined) return false;
  sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
  return true;
}

async function dshModel({ req, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const h = this.ctx.dshHelpers;
  const cfg = this.ctx.cfg;
  const provider = String(cfg.dsh?.provider || 'deepseek-official');
  const model = String(cfg.dsh?.model || 'deepseek-flash');
  // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
  let options = h.effortOptions.slice();
  let labels = {};
  let providerDefault = null;
  let catalogSource = 'fallback';
  try {
    const catalog = await h.loadModelCatalog();
    const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
    const entry = (group?.models ?? []).find((m) => m?.id === model);
    const efforts = entry?.reasoning?.efforts ?? [];
    const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => h.effortOptions.includes(id));
    if (advertised.length) {
      options = advertised;
      labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
      providerDefault = entry.reasoning.defaultEffort ?? null;
      catalogSource = 'dsh';
    }
  } catch (error) {
    // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
    h.noteCatalogFailure(error);
  }
  sendJson({
    provider,
    model,
    reasoningEffort: String(cfg.dsh?.reasoningEffort || h.effortDefault),
    options,
    labels,
    default: h.effortDefault,
    providerDefault,
    catalogSource,
    // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
    // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
    globalSideEffect: true,
  });
}

async function dshEffort({ req, sendJson, readBody }) {
  if (rejectAgent(req, sendJson)) return;
  const h = this.ctx.dshHelpers;
  const cfg = this.ctx.cfg;
  const body = await readBody();
  let effort;
  try { effort = h.normalizeEffort(body.reasoningEffort); }
  catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
  const configFile = h.configFile;
  // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
  const file = h.readConfigObject(configFile);
  file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
  h.atomicWriteJson(configFile, file);
  cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
  // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
  h.bumpModelSelectionEpoch();
  this.ctx.log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
  sendJson({ ok: true, reasoningEffort: effort });
}

async function authorizeRead({ sendJson, readBody }) {
  const h = this.ctx.dshHelpers;
  const body = await readBody();
  const key = String(body.key ?? '').trim();
  const token = String(body.token ?? '').trim();
  const keyMatch = /^(group|private):(\d+)$/.exec(key);
  if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
  if (!token || !this.ctx.agentTokenOk(key, token)) {
    // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
    // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
    // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
    sendJson({ ok: false, error: token ? 'agent token 无效' : '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的 v2 读工具' }, 403);
    return;
  }
  const kind = keyMatch[1];
  const id = Number(keyMatch[2]);
  if (!Number.isFinite(id) || id <= 0 || !h.modeAllowed(key, kind, id, this.ctx.cfg, h.currentMode())) {
    sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
    return;
  }
  sendJson({ ok: true, key });
}

function restart({ req, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const h = this.ctx.dshHelpers;
  sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
  setTimeout(() => {
    this.ctx.log('控制台：重启桥接');
    // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSocialV2State()，
    // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
    try { h.saveState(); } catch (error) { this.ctx.log('重启前保存会话映射失败:', error?.message ?? error); }
    try { h.saveSocialV2State(); } catch (error) { this.ctx.log('重启前保存二代会话状态失败:', error?.message ?? error); }
    h.releaseLock();
    process.exit(0);
  }, 500);
}

export default { name: 'ops', title: 'DSH 连接与运维', inject, routes };
