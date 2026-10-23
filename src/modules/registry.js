// 功能模块注册表：把「一个功能」从 `bridge.js` 的 `main()` 闭包里挪出来。
//
// 为什么要有它：
//   `src/bridge.js` 现在是 1.5 万行、267 个函数全在 `main()` 里（闭包），
//   加一个功能就要在同一个文件里改七八处，改动之间还互相踩。
//   这里给出一个**最小的**装载器：功能声明自己的名字、依赖、路由和生命周期钩子，
//   由 `bridge.js` 统一装载。不引入新依赖、不改启动流程、不要求热重载。
//
// 刻意**不做**的事（都是为了不把现有 24/7 进程搞坏）：
//   · 不做懒激活 —— 所有模块在启动时一次性 `setup()`，出错就是启动期可见的错误；
//   · 不做封装边界 —— 模块能拿到整个 `ctx`，想干什么干什么，先解决问题再谈纯净；
//   · 不做动态安装 —— 模块是仓库里的文件，`bridge.js` 显式 import 后传进来。
//
// 路由一律是**声明式**的：模块给出 `routes`，由装载器按**固定优先级**匹配（精确优先、
// 前缀按长度降序、同级按注册序），**不靠** if 链在文件里的先后顺序。这就是这次改造要
// 解决的核心风险：现有 135 条路由的先后顺序是隐式契约，挪动任何一段都可能让
// `/api/socialV2/state` 被 `/api/socialV2/states` 之类的前缀抢走。
//
// 回退：`cfg.socialV2.modules.enabled === false` 时全部模块不装载，走老路径。

/** 未接入装载器的功能在 `name` 上挂这个名字，装载器会跳过（并记一条日志）。 */
export const RESERVED_NAME = '(待接入)';

/**
 * 装载器。
 *
 * @param {object} opts
 * @param {object} opts.ctx           模块共享上下文（cfg、log、state、各种句柄）
 * @param {(msg: string) => void} opts.log
 * @param {(module: object, phase: string, error: any) => void} [opts.onError]
 */
export function createModuleHost({ ctx, log, onError } = {}) {
  if (!ctx) throw new Error('createModuleHost 需要 ctx');
  const logger = typeof log === 'function' ? log : () => {};

  /** name -> 模块定义 */
  const modules = new Map();
  /** 已装载并完成 setup 的模块名，按装载顺序 */
  const loaded = [];
  /** 路由表：{ method, path, kind: 'exact'|'prefix', module, handler, order } */
  const routes = [];
  /** 装载过程中的问题（启动后可通过 /api/_modules 查看） */
  const problems = [];
  let routeOrder = 0;

  function fail(module, phase, message) {
    const name = module?.name ?? '(无名)';
    const entry = { module: name, phase, message: String(message) };
    problems.push(entry);
    if (typeof onError === 'function') {
      try { onError(module, phase, message); } catch {}
    }
    logger(`[modules] ${phase} 失败 ${name}：${entry.message}`);
  }

  /**
   * 校验一个模块定义。返回 null 表示通过，否则返回错误原因。
   *
   * 这里做的是**装载期**校验（抄 Koishi 的 `inject` 思路）：模块声明 `inject`
   * 就必须真的有那些依赖可用，缺了就在启动时炸出来，而不是等到半夜某次唤醒
   * 才发现 `ctx.sendReply is not a function`。
   */
  function validate(def) {
    if (!def || typeof def !== 'object') return '模块定义必须是对象';
    if (typeof def.name !== 'string' || !def.name.trim()) return '缺少 name';
    if (def.name === RESERVED_NAME) return null; // 预留位，跳过
    if (modules.has(def.name)) return `模块名重复：${def.name}`;
    const inject = def.inject ?? [];
    if (!Array.isArray(inject)) return 'inject 必须是数组';
    const missing = inject.filter((k) => k !== 'cfg' && !(k in ctx));
    if (missing.length) return `ctx 缺少依赖：${missing.join(', ')}`;
    if (def.routes !== undefined && !Array.isArray(def.routes)) return 'routes 必须是数组';
    for (const r of def.routes ?? []) {
      if (!r || typeof r.path !== 'string' || !r.path.startsWith('/')) {
        return `路由 path 必须是以 / 开头的字符串：${JSON.stringify(r?.path)}`;
      }
      if (typeof r.handler !== 'function') return `路由 ${r.path} 缺少 handler`;
      if (r.kind !== 'exact' && r.kind !== 'prefix') return `路由 ${r.path} 的 kind 必须是 exact / prefix`;
      if (r.method !== undefined && !/^(GET|POST|PUT|DELETE|PATCH)$/.test(r.method)) {
        return `路由 ${r.path} 的 method 非法：${r.method}`;
      }
    }
    for (const hookName of ['setup', 'teardown', 'tick']) {
      if (def[hookName] !== undefined && typeof def[hookName] !== 'function') {
        return `${hookName} 必须是函数`;
      }
    }
    return null;
  }

  /**
   * 装载全部模块。
   *
   * 顺序：
   *   1. 校验 + 登记（不调用任何用户代码）
   *   2. 逐个 `setup(ctx)`，失败的模块整体回滚（它的路由不生效）
   *   3. 路由排序：exact 优先，prefix 按长度降序，同级保持注册序
   */
  async function load(defs) {
    const list = Array.isArray(defs) ? defs : [];
    // ── 1. 校验 + 登记 ──
    const ready = [];
    for (const def of list) {
      const err = validate(def);
      if (err) { fail(def, 'validate', err); continue; }
      if (def.name === RESERVED_NAME) continue;
      modules.set(def.name, def);
      ready.push(def);
    }

    // ── 2. setup ──
    const settled = [];
    for (const def of ready) {
      try {
        if (typeof def.setup === 'function') await def.setup(ctx);
        settled.push(def);
        loaded.push(def.name);
      } catch (error) {
        fail(def, 'setup', error?.message ?? error);
        modules.delete(def.name);
      }
    }

    // ── 3. 路由登记 + 排序 ──
    for (const def of settled) {
      for (const r of def.routes ?? []) {
        routes.push({
          method: r.method ?? null,
          path: r.path,
          kind: r.kind,
          module: def.name,
          handler: r.handler,
          order: routeOrder++,
        });
      }
    }
    routes.sort(compareRoutes);

    // 前缀路由互相遮蔽检查：/a 与 /a/b 同时存在时，/a 会先吃掉 /a/b。
    // 这不是错误（老代码里就有这种分层），但要显式记下来，免得以后误改顺序。
    for (const a of routes) {
      if (a.kind !== 'prefix') continue;
      for (const b of routes) {
        if (a === b) continue;
        if (b.path.length > a.path.length && b.path.startsWith(a.path)) {
          problems.push({
            module: a.module, phase: 'route-shadow',
            message: `前缀 ${a.path} 会遮蔽更长的 ${b.path}（模块 ${b.module}）`,
          });
        }
      }
    }

    logger(`[modules] 已装载 ${loaded.length} 个模块、${routes.length} 条路由${problems.length ? `，${problems.length} 条告警` : ''}`);
    return { loaded: [...loaded], routes: routes.length, problems: problems.length };
  }

  /**
   * 路由优先级：**精确优先**，其次按路径长度降序，再按注册序。
   * 这样 `/api/socialV2/state` 永远赢过 `/api/socialV2/`，与 if 链的书写顺序无关。
   */
  function compareRoutes(a, b) {
    if (a.kind !== b.kind) return a.kind === 'exact' ? -1 : 1;
    if (a.kind === 'exact') {
      if (a.path !== b.path) return a.path < b.path ? -1 : 1;
      return a.order - b.order;
    }
    if (a.path.length !== b.path.length) return b.path.length - a.path.length;
    return a.order - b.order;
  }

  /** 找当前请求该交给哪个模块。没有就返回 null（交回老 if 链）。 */
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== null && r.method !== method) continue;
      if (r.kind === 'exact' ? pathname === r.path : pathname.startsWith(r.path)) return r;
    }
    return null;
  }

  /**
   * 调用命中的路由。返回值约定：
   *   'handled' 已处理（handler 自己写了响应）
   *   'unhandled' 明确表示「这条不归我」→ 装载器继续往下试
   * 出异常时**不**把响应留给老路径（那会写出两次响应头），直接抛给调用方记日志。
   */
  async function dispatch(method, pathname, ...args) {
    const r = match(method, pathname);
    if (!r) return 'unhandled';
    const def = modules.get(r.module);
    // handler 的 this 是「模块定义 + ctx」：模块里写 this.ctx.readRoleState() 才能拿到注入项。
    // 第一版 only `.call(def)`，handler 里 this.ctx 是 undefined —— 实测 POST /api/role-mode
    // 直接 500「Cannot read properties of undefined (reading 'readRoleState')」。
    const receiver = { ...def, ctx };
    const result = await r.handler.call(receiver, ...args);
    return result === 'unhandled' ? 'unhandled' : 'handled';
  }

  async function teardown() {
    for (const name of [...loaded].reverse()) {
      const def = modules.get(name);
      if (!def || typeof def.teardown !== 'function') continue;
      try { await def.teardown(ctx); } catch (error) {
        fail(def, 'teardown', error?.message ?? error);
      }
    }
    modules.clear();
    loaded.length = 0;
    routes.length = 0;
  }

  /** 给 `/api/_modules` 用的只读视图（不含 handler 函数本体）。 */
  function describe() {
    return {
      enabled: true,
      loaded: [...loaded],
      modules: [...modules.values()].map((d) => ({
        name: d.name,
        title: d.title ?? '',
        inject: d.inject ?? [],
        routes: (d.routes ?? []).map((r) => ({ method: r.method ?? '*', kind: r.kind, path: r.path })),
        hasSetup: typeof d.setup === 'function',
        hasTeardown: typeof d.teardown === 'function',
        hasTick: typeof d.tick === 'function',
      })),
      routes: routes.map((r) => ({ method: r.method ?? '*', kind: r.kind, path: r.path, module: r.module })),
      problems: [...problems],
    };
  }

  return {
    load, match, dispatch, teardown, describe,
    get loaded() { return [...loaded]; },
    get problems() { return [...problems]; },
    get size() { return modules.size; },
  };
}

/**
 * 功能模块的空壳。
 *
 * 用来**占位**：把「这个功能将来是一个模块」这件事先钉进代码，而不是留在文档里。
 * 装载器看到 `name === RESERVED_NAME` 会跳过它，`/api/_modules` 会把它们列成
 * 「待接入」，谁挪的谁把 `name` 改成正式的。
 */
export function reservedModule(title, note = '') {
  return { name: RESERVED_NAME, title, note, inject: [], routes: [] };
}
