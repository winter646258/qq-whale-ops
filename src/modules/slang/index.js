// 模块：slang —— 黑话库（群聊网络用语）管理
//
// 这一族原在 src/bridge.js 的 if 链里连成一片（GET/POST /api/slang、
// clear、batch-delete、batch-confirm、batch-reject、PATCH/DELETE /:id、
// POST /:id/confirm、/:id/reject、extract、research、config），共 9 条
// 精确路由 + 4 条带 id 的路径路由。
//
// 关键设计约束（踩了才知道）：
//   1. `slangEntries` 会被**整体重新赋值**（清空、批量删、过滤都用 `slangEntries = ...`），
//      所以模块里绝对不能拿快照数组，必须每次通过 `state.entries()` 现取。
//   2. 几个 Map/Set（slangWindows / slangExtractionCooldowns / slangSubmitTimes /
//      slangResearchingIds）是 const 容器，交引用安全，但清空操作要由模块发起，
//      所以一并放进 `state` 里。
//   3. `queueSlangTask` / `runSlangExtraction` / `runSlangResearch` / `saveSlangStore`
//      都是 main() 里的函数声明，运行到 request handler 时早已初始化 ⇒ 交闭包即可。
//   4. `SLANG_STATUS` / `createSlangEntry` 是顶层 import 的常量与纯函数，直接交引用。

const inject = [
  'log', 'cfg', 'readConfigObject', 'atomicWriteJson', 'path', 'rootDir',
  'slangHelpers',
  // 阶段25：AI 工具面新增
  'agentTokenOk', 'v2SessionAllowed', 'v2ToolEnabled',
  'redactKnownTokensOnly', 'appendActivity',
];

// 路径里出现的 id 形状：黑话 id 是 createSlangEntry 生成的字符串，
// 只允许字母数字与 - _，避免把奇怪的东西喂给正则之后的分支。
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function parseIdPath(pathname) {
  const m = pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
  if (!m) return null;
  if (!ID_RE.test(m[1])) return null;
  return { id: m[1], action: m[2] ?? null };
}

function enabledError(cfg, sendJson) {
  if (cfg.slang?.enabled === false) {
    sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400);
    return true;
  }
  return false;
}

async function list({ url, sendJson }) {
  const h = this.ctx.slangHelpers;
  const status = url.searchParams.get('status') || '';
  const list = status ? h.entries().filter((e) => e.status === status) : h.entries();
  sendJson({ entries: list, config: this.ctx.cfg.slang });
}

async function create({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const body = (await readBody()) ?? {};
  const content = String(body.content ?? '').trim();
  if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
  if (h.entries().some((e) => e.content === content)) {
    sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400);
    return;
  }
  const entry = h.createEntry({
    content,
    meaning: String(body.meaning ?? '').trim(),
    usage: String(body.usage ?? '').trim(),
    example: String(body.example ?? '').trim(),
    risk: String(body.risk ?? '').trim(),
    sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
    status: body.status === h.SLANG_STATUS.CANDIDATE ? h.SLANG_STATUS.CANDIDATE : h.SLANG_STATUS.CONFIRMED,
    source: 'manual',
    evidence: Array.isArray(body.evidence) ? body.evidence : [],
  });
  // 注意：这里必须 push 进**当前那个数组**，而不是 push 到快照再换回去。
  const arr = h.entries();
  arr.push(entry);
  h.save();
  this.ctx.log(`控制台：新增黑话「${content}」`);
  sendJson({ ok: true, entry });
}

async function clear({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const body = (await readBody()) ?? {};
  const status = String(body.status ?? '').trim();
  if (status && ![h.SLANG_STATUS.CANDIDATE, h.SLANG_STATUS.CONFIRMED, h.SLANG_STATUS.REJECTED].includes(status)) {
    sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
    return;
  }
  let removedCount = 0;
  if (status) {
    removedCount = h.entries().filter((e) => e.status === status).length;
    h.setEntries(h.entries().filter((e) => e.status !== status));
  } else {
    removedCount = h.entries().length;
    h.setEntries([]);
    // 清空所有时同步清掉待提取窗口和冷却，避免「删了又回来」
    h.windows.clear();
    h.cooldowns.clear();
    h.submitTimes.clear();
    h.researchingIds.clear();
  }
  h.save();
  this.ctx.log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
  sendJson({ ok: true, removedCount });
}

async function batchDelete({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const body = (await readBody()) ?? {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const status = String(body.status ?? '').trim();
  if (ids.length) {
    const idSet = new Set(ids);
    const before = h.entries().length;
    h.setEntries(h.entries().filter((e) => !idSet.has(e.id)));
    const removedCount = before - h.entries().length;
    if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
    h.save();
    this.ctx.log(`控制台：批量删除黑话 ${removedCount} 条`);
    sendJson({ ok: true, removedCount });
    return;
  }
  if (status && ![h.SLANG_STATUS.CANDIDATE, h.SLANG_STATUS.CONFIRMED, h.SLANG_STATUS.REJECTED].includes(status)) {
    sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
    return;
  }
  if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
  const removedCount = h.entries().filter((e) => e.status === status).length;
  h.setEntries(h.entries().filter((e) => e.status !== status));
  h.save();
  this.ctx.log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
  sendJson({ ok: true, removedCount });
}

async function batchConfirm({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const body = (await readBody()) ?? {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
  const entries = h.entries();
  let confirmedCount = 0;
  let skippedCount = 0;
  const skipped = [];
  for (const id of ids) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
    const entry = entries[idx];
    if (entry.status !== h.SLANG_STATUS.CANDIDATE) {
      skippedCount++;
      skipped.push({ id, content: entry.content, reason: '不是候选' });
      continue;
    }
    if (!entry.meaning || !String(entry.meaning).trim()) {
      // MARKER: fix2bugs
      // 说清楚为什么不能确认：提示词里要显示「词：含义」，没有含义的条目
      // 即使确认了也不会进黑话表（buildSlangContext 会把它过滤掉），
      // 等于白确认。这里给出可操作的下一步，而不是只报「缺少含义」。
      skippedCount++;
      skipped.push({
        id,
        content: entry.content,
        count: Number(entry.count) || 0,
        reason: '缺少含义：请先等 AI 研究出释义（或手动补 meaning）再确认，否则确认了也不会进黑话表',
      });
      continue;
    }
    entry.status = h.SLANG_STATUS.CONFIRMED;
    entry.updatedAt = new Date().toISOString();
    confirmedCount++;
  }
  if (confirmedCount) h.save();
  this.ctx.log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
  sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
}

async function batchReject({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const body = (await readBody()) ?? {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
  const entries = h.entries();
  let rejectedCount = 0;
  for (const id of ids) {
    const idx = entries.findIndex((e) => e.id === id);
    if (idx < 0) continue;
    const entry = entries[idx];
    if (entry.status === h.SLANG_STATUS.REJECTED) continue;
    entry.status = h.SLANG_STATUS.REJECTED;
    entry.updatedAt = new Date().toISOString();
    rejectedCount++;
  }
  if (rejectedCount) h.save();
  this.ctx.log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
  sendJson({ ok: true, rejectedCount });
}

async function update({ url, sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const parsed = parseIdPath(url.pathname);
  const id = parsed.id;
  const idx = h.entries().findIndex((e) => e.id === id);
  if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
  const body = (await readBody()) ?? {};
  const entry = { ...h.entries()[idx] };
  if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
  if (body.content !== undefined && h.entries().some((e) => e.id !== id && e.content === entry.content)) {
    sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
    return;
  }
  if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
  if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
  if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
  if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
  if (body.sources !== undefined) {
    entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
  }
  if (body.status !== undefined
    && [h.SLANG_STATUS.CANDIDATE, h.SLANG_STATUS.CONFIRMED, h.SLANG_STATUS.REJECTED].includes(body.status)) {
    entry.status = body.status;
  }
  if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
  entry.updatedAt = new Date().toISOString();
  h.entries()[idx] = entry;
  h.save();
  this.ctx.log(`控制台：更新黑话「${entry.content}」`);
  sendJson({ ok: true, entry });
}

async function confirmOne({ url, sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const id = parseIdPath(url.pathname).id;
  const idx = h.entries().findIndex((e) => e.id === id);
  if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
  const body = (await readBody()) ?? {};
  const entry = h.entries()[idx];
  if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
  if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
  if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
  if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
  if (body.sources !== undefined) {
    entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
  }
  if (!entry.meaning) {
    sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
    return;
  }
  entry.status = h.SLANG_STATUS.CONFIRMED;
  entry.updatedAt = new Date().toISOString();
  h.save();
  this.ctx.log(`控制台：确认黑话「${entry.content}」`);
  sendJson({ ok: true, entry });
}

async function rejectOne({ url, sendJson }) {
  const h = this.ctx.slangHelpers;
  const id = parseIdPath(url.pathname).id;
  const idx = h.entries().findIndex((e) => e.id === id);
  if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
  const entry = h.entries()[idx];
  entry.status = h.SLANG_STATUS.REJECTED;
  entry.updatedAt = new Date().toISOString();
  h.save();
  this.ctx.log(`控制台：拒绝黑话「${entry.content}」`);
  sendJson({ ok: true, entry });
}

async function removeOne({ url, sendJson }) {
  const h = this.ctx.slangHelpers;
  const id = parseIdPath(url.pathname).id;
  const idx = h.entries().findIndex((e) => e.id === id);
  if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
  const [removed] = h.entries().splice(idx, 1);
  h.save();
  this.ctx.log(`控制台：删除黑话「${removed.content}」`);
  sendJson({ ok: true, removed });
}

async function extract({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  if (enabledError(this.ctx.cfg, sendJson)) return;
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  if (key && h.windows.has(key)) {
    h.queueTask(() => h.runExtraction(key));
    sendJson({ ok: true, key });
    return;
  }
  const firstKey = h.windows.keys().next().value;
  if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
  h.queueTask(() => h.runExtraction(firstKey));
  sendJson({ ok: true, key: firstKey });
}

async function research({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  if (enabledError(this.ctx.cfg, sendJson)) return;
  const body = (await readBody()) ?? {};
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  const candidates = ids.length
    ? h.entries().filter((e) => ids.includes(e.id) && e.status === h.SLANG_STATUS.CANDIDATE)
    : h.entries().filter((e) => e.status === h.SLANG_STATUS.CANDIDATE);
  if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
  h.queueTask(() => h.runResearch(candidates));
  sendJson({ ok: true, count: candidates.length });
}

async function updateConfig({ sendJson, readBody }) {
  const h = this.ctx.slangHelpers;
  const { cfg, log, path, rootDir, readConfigObject, atomicWriteJson } = this.ctx;
  const body = (await readBody()) ?? {};
  const oldPreset = cfg.slang?.learnerPreset;
  const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
  const configFile = path.join(rootDir, 'config.json');
  const file = readConfigObject(configFile);
  const merged = { ...(file.slang ?? {}), ...body };
  if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
  else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
  if (merged.extractMinMessages !== undefined) {
    merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
  }
  if (merged.extractCooldownMs !== undefined) {
    merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
  }
  if (merged.injectMax !== undefined) {
    merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
  }
  if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
  if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
  if (merged.workspaceTitle !== undefined) {
    merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
  }
  if (body.inferenceThresholds !== undefined) {
    const raw = Array.isArray(body.inferenceThresholds)
      ? body.inferenceThresholds
      : String(body.inferenceThresholds).split(/[,，\s]+/);
    merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))]
      .sort((a, b) => a - b);
    if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
  }
  file.slang = merged;
  atomicWriteJson(configFile, file);
  cfg.slang = { ...cfg.slang, ...merged };
  if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
    h.invalidateLearnerSession();
    log('黑话学习 preset 已变更，已重置学习会话');
  } else if (body.workspaceTitle !== undefined
    && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
    h.invalidateLearnerSession();
    log('黑话学习工作区名已变更，已重置学习会话');
  }
  log('控制台：黑话系统配置已更新');
  sendJson({ ok: true, config: cfg.slang });
}

// POST 到 id 形路径：/api/slang/<id>/confirm 与 /api/slang/<id>/reject 分派，
// 其余（含裸 /api/slang/<id>）一律自己回 404。
//
// 这里必须 sendJson 而不是 return false —— registry 的 dispatch 约定是
// 'handled' / 'unhandled'，而值为 false 的 return 会被当成「未处理」交回老链路继续往下跑。
// 早先 return false 的写法会让这类请求一路落进老 if 链外的 readBody() 分支挂满 15 秒
// （实测 POST /api/slang/nope → curl exit 28 超时）。
async function postIdPath({ url, sendJson }) {
  const parsed = parseIdPath(url.pathname);
  if (!parsed) { sendJson({ ok: false, error: 'not found' }, 404); return; }
  if (parsed.action === 'confirm') return confirmOne.call(this, { url, sendJson });
  if (parsed.action === 'reject') return rejectOne.call(this, { url, sendJson });
  // 老代码没有「裸 id 的 POST」这条分支，等效于 404。
  sendJson({ ok: false, error: 'not found' }, 404);
}
// ── AI 工具面（reserved2）／api/socialV2/slang/{query,submit} ──────────────
// 鉴权口径与 memory / share 一致：带 x-agent-token 才校验
// agentTokenOk → v2SessionAllowed → v2ToolEnabled(<flag>)；不带令牌 = 控制台。
function rejectAi({ ctx, req, sendJson, key, tool, what }) {
  const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
  if (!agentToken) return false;
  if (!ctx.agentTokenOk(key, agentToken)) {
    sendJson({ ok: false, error: 'agent token 无效' }, 403);
    return true;
  }
  if (!ctx.v2SessionAllowed(key)) {
    sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
    return true;
  }
  if (!ctx.v2ToolEnabled(tool)) {
    sendJson({ ok: false, error: `工具未启用：${what}` }, 403);
    return true;
  }
  return false;
}

// GET /api/socialV2/slang/query —— 让她查「这个说法我们群里是什么意思」
async function aiQuery({ req, url, sendJson }) {
  const key = String(url.searchParams.get('key') ?? '').trim();
  const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  const ctx = this.ctx;
  if (rejectAi({ ctx, req, sendJson, key, tool: 'slangQuery', what: 'qq_slang_query' })) return;
  const list = ctx.slangHelpers.confirmedList().filter((e) => {
    if (!q) return true;
    return e.content.toLowerCase().includes(q)
      || e.meaning.toLowerCase().includes(q)
      || e.usage.toLowerCase().includes(q)
      || e.example.toLowerCase().includes(q);
  });
  sendJson({
    ok: true,
    key,
    total: list.length,
    entries: list,
    block: ctx.slangHelpers.buildContext(ctx.slangHelpers.entries(), ctx.cfg.slang?.injectMax ?? 8)
  });
}

// POST /api/socialV2/slang/submit —— 让她把遇到的新词交上来
async function aiSubmit({ req, sendJson, readBody }) {
  const body = (await readBody()) ?? {};
  const key = String(body.key ?? '').trim();
  const content = this.ctx.redactKnownTokensOnly(String(body.content ?? '')).trim();
  const context = this.ctx.redactKnownTokensOnly(String(body.context ?? '')).trim();
  const ctx = this.ctx;
  if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
  if (rejectAi({ ctx, req, sendJson, key, tool: 'slangSubmit', what: 'qq_slang_submit' })) return;
  if (ctx.cfg.slang?.enabled === false) {
    sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403);
    return;
  }
  if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
  if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
  const h = ctx.slangHelpers;
  if (!h.allowSubmit(key)) {
    sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429);
    return;
  }
  const existing = h.entries().find((e) => e.content === content);
  if (existing) {
    if (existing.status === h.SLANG_STATUS.CONFIRMED) {
      sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: h.publicEntry(existing) });
      return;
    }
    if (existing.status === h.SLANG_STATUS.REJECTED) {
      sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
      return;
    }
    // candidate：累计出现次数并追加语境证据
    existing.count = (Number(existing.count) || 0) + 1;
    if (context) {
      existing.evidence = h.mergeEvidence(existing.evidence, [{
        key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now()
      }]);
    }
    existing.updatedAt = new Date().toISOString();
    h.save();
    if (ctx.cfg.slang?.autoResearch !== false) {
      const thresholds = Array.isArray(ctx.cfg.slang?.inferenceThresholds)
        ? ctx.cfg.slang.inferenceThresholds.map(Number).filter(Boolean)
        : [2, 4, 8];
      if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
        h.queueTask(() => h.runResearch([existing]));
      }
    }
    ctx.log(`[reserved2] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
    sendJson({ ok: true, duplicate: true, status: 'candidate', entry: h.publicEntry(existing) });
    return;
  }
  const entry = h.createEntry({
    content,
    source: 'ai',
    status: h.SLANG_STATUS.CANDIDATE,
    evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
  });
  h.entries().push(entry);
  h.save();
  if (ctx.cfg.slang?.autoResearch !== false) {
    h.queueTask(() => h.runResearch([entry]));
  }
  ctx.log(`[reserved2] AI 提交黑话候选「${content}」(${key})`);
  ctx.appendActivity(`${key} [reserved2] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
  sendJson({ ok: true, entry: h.publicEntry(entry) });
}

// 路由表：id 型路由用 prefix 挂号再在 handler 里 parseIdPath 复核（exact 无法表达可变段）。
// 注意 registry 的 compareRoutes 是「exact 优先」，所以 `/api/slang/clear` 这类
// 固定后缀永远赢过 `/api/slang/<id>`，无需担心顺序。
// MARKER: slang-console-only —— 管理类接口只给控制台。
// 集中闸门只挡「没有控制台令牌」的请求；智能体进程同时握有控制台令牌，
// 所以这些管理接口必须在 handler 层自己拒掉 agent（与白名单/记忆同口径）。
// 判据用「带了 agent 标识」而不是「令牌对错」：空串令牌也算带，否则会被绕过。
// 注意 handler 的签名是单个对象 { req, res, url, sendJson, readBody }。
function consoleOnly(fn) {
  return async function guarded(arg) {
    const req = arg?.req;
    if (req && (req.headers['x-agent-call'] !== undefined || String(req.headers['x-agent-token'] ?? '') !== '')) {
      arg.sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
      return;
    }
    return fn.call(this, arg);
  };
}

const routes = [
  { method: 'GET', path: '/api/slang', kind: 'exact', handler: consoleOnly(list) },
  { method: 'POST', path: '/api/slang', kind: 'exact', handler: consoleOnly(create) },
  { method: 'POST', path: '/api/slang/clear', kind: 'exact', handler: consoleOnly(clear) },
  { method: 'POST', path: '/api/slang/batch-delete', kind: 'exact', handler: consoleOnly(batchDelete) },
  { method: 'POST', path: '/api/slang/batch-confirm', kind: 'exact', handler: consoleOnly(batchConfirm) },
  { method: 'POST', path: '/api/slang/batch-reject', kind: 'exact', handler: consoleOnly(batchReject) },
  { method: 'POST', path: '/api/slang/extract', kind: 'exact', handler: consoleOnly(extract) },
  { method: 'POST', path: '/api/slang/research', kind: 'exact', handler: consoleOnly(research) },
  { method: 'POST', path: '/api/slang/config', kind: 'exact', handler: consoleOnly(updateConfig) },
  // AI 工具面（原 v2:memory 族）
  { method: 'GET', path: '/api/socialV2/slang/query', kind: 'exact', handler: aiQuery },
  { method: 'POST', path: '/api/socialV2/slang/submit', kind: 'exact', handler: aiSubmit },
  { method: 'PATCH', path: '/api/slang/', kind: 'prefix', handler: consoleOnly(update) },
  { method: 'DELETE', path: '/api/slang/', kind: 'prefix', handler: consoleOnly(removeOne) },
  { method: 'POST', path: '/api/slang/', kind: 'prefix', handler: consoleOnly(postIdPath) },
];

export default { name: 'slang', title: '黑话库管理', inject, routes };
