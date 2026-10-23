// ── Token 用量账本（/api/tokens/*）────────────────────────────────
//
// 一整个前缀块（原 bridge.js L8151–8185）搬进模块。原来是一个
// `if (summary === || startsWith('/api/tokens/'))` 的「大前缀 if 内套五条小 if」，
// 模块化之后拆成五条独立声明式路由 —— 顺序不再重要，也不再需要内层
// 手写 `sendJson 404` 兜底（registry 的精确优先匹配天然做到这一点）。
//
// 安全口径沿用原样：整族对智能体一律 403（token 账本是运营数据）。
//
// 依赖说明：tokenLedger / priceTable 都是 main() 内 const（只建一次、
// 之后只调方法不改引用），直接交引用安全；log 用 this.ctx.log。

const inject = ['cfg', 'log', 'stateDir', 'tokenLedger', 'priceTable'];

/** 拒绝智能体调用。返回 true 表示已经响应完毕。 */
function rejectAgent(req, sendJson) {
  if (req.headers['x-agent-token'] === undefined) return false;
  sendJson({ ok: false, error: '该接口仅控制台可用' }, 403);
  return true;
}

const routes = [
  { method: 'GET', path: '/api/tokens/summary', kind: 'exact', handler: summary },
  { method: 'GET', path: '/api/tokens/series', kind: 'exact', handler: series },
  { method: 'GET', path: '/api/tokens/turns', kind: 'exact', handler: turns },
  { method: 'GET', path: '/api/tokens/recent', kind: 'exact', handler: recent },
  { method: 'POST', path: '/api/tokens/reset', kind: 'exact', handler: reset },
];

function summary({ req, url, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const ledger = this.ctx.tokenLedger;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  sendJson({ ...ledger.summary({ limit }), ledger: ledger.stats() });
}

function series({ req, url, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
  const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
  sendJson(this.ctx.tokenLedger.series({ hours, maxBuckets }));
}

function turns({ req, url, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const key = String(url.searchParams.get('key') ?? '').trim();
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const detail = this.ctx.tokenLedger.conversation(key, { turnLimit: limit });
  if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
  sendJson(detail);
}

function recent({ req, url, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
  sendJson({
    ok: true,
    symbol: this.ctx.priceTable.symbol,
    entries: this.ctx.tokenLedger.recent(limit),
  });
}

function reset({ req, sendJson }) {
  if (rejectAgent(req, sendJson)) return;
  this.ctx.tokenLedger.reset();
  this.ctx.log('控制台：token 用量账本已重置');
  sendJson({ ok: true });
}

export default { name: 'tokens', title: 'Token 用量账本', inject, routes };

