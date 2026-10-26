import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  // MARKER: panel-model-switch
  { method: 'POST', path: '/api/dsh/model', kind: 'exact', handler: dshModelSet },
  { method: 'GET', path: '/api/channels', kind: 'exact', handler: channelHealth },
  { method: 'POST', path: '/api/dsh/effort', kind: 'exact', handler: dshEffort },
  { method: 'POST', path: '/api/authorize/read', kind: 'exact', handler: authorizeRead },
  { method: 'POST', path: '/api/restart', kind: 'exact', handler: restart },
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

async function dshModel({ req, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
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
  const { groups, source: groupsSource } = await collectModelGroups(h, provider, model);
  sendJson({
    provider,
    model,
    groups,
    groupsSource,
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
  if (rejectAgent({ req, sendJson })) return;
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
  if (rejectAgent({ req, sendJson })) return;
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


// ── MARKER: panel-model-switch ────────────────────────────────────────────────
// 模型目录：优先问 DSH（权威），问不到就退回服务器上各渠道的 catalog.json。
// 两条路都给「提供方 → 模型」两级，前端直接渲染两个下拉。

const PROVIDER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:@\-\/]{0,159}$/;

const AVAILABILITY_LABEL = {
  available: { ok: true, text: '可用' },
  ok: { ok: true, text: '可用' },
  unknown: { ok: true, text: '未探测' },
  throttled: { ok: false, text: '限流中' },
  'region-blocked': { ok: false, text: '地区封锁' },
  unavailable: { ok: false, text: '不可用' },
  deprecated: { ok: false, text: '已下线' },
};

function dshHome() {
  return path.join(os.homedir(), '.dsh');
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** 把 DSH 的 session/modelCatalog 结果规整成 [{id,name,models:[{id,name,status,statusText}]}] */
function normalizeDshCatalog(catalog, h) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  // 思考强度档位是**模型级**能力：同一个 provider 下有的模型支持 light、有的一个都不支持。
  // 把 efforts 带出来，面板才能在海报选模型时把档位一起校准（见 dshModelSet）。
  const whitelist = Array.isArray(h?.effortOptions) ? h.effortOptions : null;
  const out = [];
  for (const g of groups) {
    const id = String(g?.id ?? '').trim();
    if (!id) continue;
    const models = (Array.isArray(g?.models) ? g.models : [])
      .map((m) => {
        const mid = String(m?.id ?? '').trim();
        if (!mid) return null;
        const efforts = (Array.isArray(m?.reasoning?.efforts) ? m.reasoning.efforts : [])
          .map((e) => String(e?.id ?? '').trim())
          .filter((eid) => eid && (!whitelist || whitelist.includes(eid)));
        const defaultEffort = String(m?.reasoning?.defaultEffort ?? '').trim() || null;
        return { id: mid, name: String(mid), status: 'available', statusText: '', efforts, defaultEffort };
      })
      .filter(Boolean);
    if (!models.length) continue;
    out.push({ id, name: String(g?.name ?? id), models });
  }
  return out;
}

/** 退回本地：扫 ~/.dsh/<provider>/catalog.json + availability.json */
function readLocalModelGroups() {
  const base = dshHome();
  let dirs = [];
  try {
    dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  const out = [];
  for (const dir of dirs.sort()) {
    if (dir.startsWith('channel-pack') || dir.includes('.bak-') || dir.startsWith('.') || dir === 'plugins' || dir === 'sessions' || dir === 'storages' || dir === 'cache' || dir === 'attachments' || dir === 'profiles') continue;
    const catalog = readJsonSafe(path.join(base, dir, 'catalog.json'));
    if (!catalog) continue;
    const entries = Array.isArray(catalog.entries) ? catalog.entries : [];
    const availability = readJsonSafe(path.join(base, dir, 'availability.json'))?.results ?? {};
    const models = entries
      .map((e) => (typeof e === 'string' ? e : String(e?.id ?? '')))
      .filter(Boolean)
      .map((mid) => {
        const state = availability?.[mid]?.state;
        const label = AVAILABILITY_LABEL[state] ?? { ok: true, text: '' };
        return { id: mid, name: mid, status: state ?? 'unknown', statusText: label.text, detail: availability?.[mid]?.detail ?? '' };
      });
    if (!models.length) continue;
    // 可用的排前面，未探测次之，其余按原顺序垫底
    const rank = (m) => (AVAILABILITY_LABEL[m.status]?.ok ? (m.status === 'unknown' ? 1 : 0) : 2);
    models.sort((a, b) => rank(a) - rank(b));
    out.push({ id: dir, name: dir, models });
  }
  return out;
}

async function collectModelGroups(h, provider, model) {
  try {
    const groups = normalizeDshCatalog(await h.loadModelCatalog(), h);
    if (groups.length) return { groups, source: 'dsh' };
  } catch (error) {
    h.noteCatalogFailure(error);
  }
  const groups = readLocalModelGroups();
  // 当前在跑的 provider/model 一定要能在下拉里选到，否则保存时会把当前值弄丢
  const current = groups.find((g) => g.id === provider);
  if (!current) groups.unshift({ id: provider, name: provider, models: [{ id: model, name: model, status: 'current', statusText: '当前', efforts: [], defaultEffort: null }] });
  else if (!current.models.some((m) => m.id === model)) current.models.unshift({ id: model, name: model, status: 'current', statusText: '当前', efforts: [], defaultEffort: null });
  return { groups, source: groups.length ? 'files' : 'none' };
}

/** 切换模型：只写 config.json 的 dsh.provider/model，再递增代号让下一条消息重新 selectModel。 */
async function dshModelSet({ req, sendJson, readBody }) {
  if (rejectAgent({ req, sendJson })) return;
  const h = this.ctx.dshHelpers;
  const cfg = this.ctx.cfg;
  const body = await readBody();
  const provider = String(body.provider ?? '').trim();
  const model = String(body.model ?? '').trim();
  if (!PROVIDER_ID_RE.test(provider)) { sendJson({ ok: false, error: 'provider 不合法' }, 400); return; }
  if (!PROVIDER_ID_RE.test(model)) { sendJson({ ok: false, error: 'model 不合法' }, 400); return; }
  // 思考强度和模型是绑定的：DSH 会因为「该模型不支持某个档位」直接拒绝 selectModel
  // （session/model-unavailable: does not support reasoning effort "light"），
  // 结果是切完之后这个会话**每条消息都发不出去**。所以切模型时顺手把档位校准到
  // 这个模型公布的能力范围内，宁可自动改档，也不要让面板一按就把助手按哑。
  let reasoningEffort = String(cfg.dsh?.reasoningEffort || h.effortDefault);
  let effortAdjusted = false;
  let effortNote = '';
  try {
    const groups = normalizeDshCatalog(await h.loadModelCatalog(), h);
    const entry = (groups.find((g) => g.id === provider)?.models ?? []).find((m) => m.id === model);
    const efforts = Array.isArray(entry?.efforts) ? entry.efforts : [];
    if (efforts.length && !efforts.includes(reasoningEffort)) {
      const next = entry.defaultEffort && efforts.includes(entry.defaultEffort) ? entry.defaultEffort : efforts[0];
      effortAdjusted = true;
      effortNote = `该模型不支持档位 ${reasoningEffort}，已自动改为 ${next}`;
      reasoningEffort = next;
    } else if (efforts.length && efforts.includes(reasoningEffort)) {
      effortNote = `档位 ${reasoningEffort} 该模型支持`;
    }
  } catch (error) {
    // 目录取不到就不动档位：宁可切模型失败被日志记下来，也不要瞎猜一个档位。
    h.noteCatalogFailure?.(error);
    effortNote = '模型目录读取失败，档位保持原值';
  }
  // fail-fast：配置损坏时直接 500，绝不回写（与白名单/档位接口同语义）
  const file = h.readConfigObject(h.configFile);
  file.dsh = { ...(file.dsh ?? {}), provider, model, ...(effortAdjusted ? { reasoningEffort } : {}) };
  h.atomicWriteJson(h.configFile, file);
  cfg.dsh = { ...(cfg.dsh ?? {}), provider, model, ...(effortAdjusted ? { reasoningEffort } : {}) };
  h.bumpModelSelectionEpoch();
  this.ctx.log(`控制台：DSH 模型已切到 ${provider}/${model}（对已有会话于下一条消息生效）${effortAdjusted ? '；' + effortNote : ''}`);
  sendJson({ ok: true, provider, model, reasoningEffort, effortAdjusted, effortNote, note: '下一条消息生效' });
}

/** 把名字里的邮箱/手机号打码：面板只展示，不该把账号原文摊在屏幕上。 */
function maskNickname(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const at = s.indexOf('@');
  if (at > 0) {
    const head = s.slice(0, at);
    const keep = head.slice(0, Math.min(2, head.length));
    return `${keep}***@${s.slice(at + 1)}`;
  }
  if (/^\d{5,}$/.test(s)) return `${s.slice(0, 3)}****${s.slice(-2)}`;
  if (s.length <= 4) return s;
  return `${s.slice(0, 2)}***${s.slice(-2)}`;
}

function fmtDay(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 渠道健康：只读。数据源 ~/.dsh/channel-pack/{state,auto-checkin}.json，凭据一律不返回。 */
function channelHealth({ req, sendJson }) {
  if (rejectAgent({ req, sendJson })) return;
  const pack = path.join(dshHome(), 'channel-pack');
  const state = readJsonSafe(path.join(pack, 'state.json'));
  if (!state) { sendJson({ ok: false, error: '读不到 channel-pack/state.json' }, 500); return; }
  const checkin = readJsonSafe(path.join(pack, 'auto-checkin.json')) ?? {};
  const now = Date.now();
  const accounts = (Array.isArray(state.accounts) ? state.accounts : []).map((a) => {
    const rateLimits = Object.entries(a?.modelRateLimits ?? {})
      .map(([m, until]) => ({ model: String(m), until: Number(until), untilText: fmtDay(until) }))
      .filter((x) => Number.isFinite(x.until) && x.until > now);
    const exp = Number(a?.expiresAt);
    const expired = Number.isFinite(exp) && exp > 0 && exp < now;
    const expiresInDays = Number.isFinite(exp) && exp > 0 ? Math.round((exp - now) / 86400000) : null;
    return {
      id: String(a?.id ?? ''),
      provider: String(a?.provider ?? ''),
      nickname: maskNickname(a?.nickname),
      enabled: a?.enabled !== false,
      refreshable: a?.refreshable === true,
      expiresAt: Number.isFinite(exp) ? exp : null,
      expiresText: fmtDay(exp),
      expiresInDays,
      expired,
      rateLimits,
    };
  });
  const providers = new Set(accounts.map((a) => a.provider));
  const expiredCount = accounts.filter((a) => a.expired).length;
  const disabledCount = accounts.filter((a) => !a.enabled).length;
  const limitCount = accounts.filter((a) => a.rateLimits.length).length;
  sendJson({
    ok: true,
    at: now,
    summary: `${providers.size} 个渠道 / ${accounts.length} 个账号 ｜ 过期 ${expiredCount} ｜ 停用 ${disabledCount} ｜ 有模型限流 ${limitCount}`,
    accounts,
    checkin: {
      enabled: checkin.enabled === true,
      lastDate: checkin.lastDate ?? '',
      lastResult: checkin.lastResult ?? '',
      lastAt: Number(checkin.lastAt) || null,
      channels: (Array.isArray(checkin.channels) ? checkin.channels : []).map((c) => ({ provider: String(c?.provider ?? ''), text: String(c?.text ?? '') })),
    },
  });
}

export default { name: 'ops', title: 'DSH 连接与运维', inject, routes };
