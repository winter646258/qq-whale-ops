// ── 浏览器桥：扩展来领任务 / 回传结果 / 看状态 ──────────────────────────
//
// 这一族有三个地方和别的不一样，搬的时候逐条照抄：
//
// 1) **不走控制台令牌**，走扩展自己的 `x-phone-token`（`state/phone-token`）。
//    集中闸门里有一段 `phonePathExempt` 专门为 `/api/phone/` 放行 —— 扩展装在
//    主人浏览器里，不该持有控制台全权令牌。所以这里**不能**套 rejectAgent，
//    也不能校验 console token，只能校验 phoneTokenOk。
//
// 2) **CORS 是必需的**：请求从浏览器扩展发出。非 OPTIONS 的 `/api/phone/*`
//    要补 `access-control-allow-origin: *` 与另两个头；OPTIONS 预检必须在
//    **任何鉴权之前**回 204，否则浏览器直接失败。
//    这套头要覆盖整个 `/api/phone/` 前缀（含未知子路径），做法是：
//    registry 的路由优先级「exact 优先」，所以三条 exact 先被匹配；
//    三条 exact 的 handler 各自调 phoneCors() 补头；
//    再挂一条 `kind: 'prefix'` 的兜底，只对未知子路径补头后交回老链路。
//
// 3) `/api/phone/result` 的 body 要在**令牌校验之后**才读：
//    读早了等于给未授权请求一次无成本的 body 解析。

function phoneCors(res) {
  if (!res || typeof res.setHeader !== 'function') return;
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, x-phone-token');
  res.setHeader('access-control-allow-methods', 'POST, GET, OPTIONS');
}

async function poll({ req, res, sendJson }) {
  phoneCors(res);
  if (!this.ctx.phoneTokenOk(req.headers['x-phone-token'])) {
    sendJson({ ok: false, error: '令牌无效' }, 401);
    return;
  }
  const task = await this.ctx.phoneBridge.poll();
  sendJson({ ok: true, task });
}

async function submitResult({ req, res, sendJson, readBody }) {
  phoneCors(res);
  if (!this.ctx.phoneTokenOk(req.headers['x-phone-token'])) {
    sendJson({ ok: false, error: '令牌无效' }, 401);
    return;
  }
  // 注意：console server 里没有全局 body —— 每个路由都自己 readBody()。
  const resultBody = await readBody();
  const r = this.ctx.phoneBridge.submitResult(resultBody ?? {});
  sendJson(r, r.ok ? 200 : 400);
}

async function status({ req, res, sendJson }) {
  phoneCors(res);
  if (!this.ctx.phoneTokenOk(req.headers['x-phone-token'])) {
    sendJson({ ok: false, error: '令牌无效' }, 401);
    return;
  }
  sendJson({ ok: true, ...this.ctx.phoneBridge.status() });
}

// CORS 预检：必须在鉴权之前回 204（老代码是第一条 `/api/phone/` 判断）。
function preflight({ res }) {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, x-phone-token',
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-max-age': '600',
  });
  res.end();
}

// 未知的 /api/phone/* 子路径与其它方法：只补 CORS 头，然后交回老链路。
// 返回 'unhandled' —— 老 if 链里已经删掉这一段了，所以最终会走到全局 404，
// 与搬家前「闸门放行 + 路由不命中 → 404」的结果一致（只是响应头多了 CORS）。
function corsOnly({ res }) {
  phoneCors(res);
  return 'unhandled';
}

// ⚠️ 已知限制：模块委派点在**全局 CSRF 闸门之后**
//    （`if (req.method !== 'GET')` 要求 content-type 含 application/json，否则 415）。
//    所以 `OPTIONS /api/phone/*` 只有在带 `content-type: application/json` 时才回 204，
//    不带就到了不了 `preflight`（实测 415）。搬家前老 if 链里那段 OPTIONS 预检
//    位于该闸门**之前**，所以无 type 的预检能直接 204。
//
//    要修就得把预检放回闸门之前（在 `// MARKER: modules-delegate` 那一层往上加一个
//    专门的 `/api/phone/` OPTIONS 分支），但那等于在全局闸门前开一个洞，
//    需要单独评估后再动 —— 见 docs/模块契约.md 的「委派点在闸门之后」一节。
//    影响面：浏览器扩展若发不带 content-type 的预检，会看到 415。
//    curl 里带 `-H 'content-type: application/json'` 的预检是正常的 204 + CORS 头。

const inject = ['log', 'phoneBridge', 'phoneTokenOk'];

// 顺序：OPTIONS 先登记（预检与 method 无关地抢前缀），但 registry 的 compareRoutes
// 规则是「exact 优先」，所以三条 exact 依然优先于所有 prefix。
const routes = [
  { method: 'OPTIONS', path: '/api/phone/', kind: 'prefix', handler: preflight },
  { method: 'POST', path: '/api/phone/poll', kind: 'exact', handler: poll },
  { method: 'POST', path: '/api/phone/result', kind: 'exact', handler: submitResult },
  { method: 'GET', path: '/api/phone/status', kind: 'exact', handler: status },
  { path: '/api/phone/', kind: 'prefix', handler: corsOnly },
];

export default { name: 'phone', title: '浏览器桥（扩展领取任务）', inject, routes };
