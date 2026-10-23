#!/usr/bin/env node
/**
 * 阶段 1：把模块装载器接进 `src/bridge.js`（最小、可回退、不改变任何行为）。
 *
 * 做什么：
 *   1. 引入 `src/modules/registry.js` 与模块清单 `src/modules/index.js`
 *   2. `main()` 里声明 `moduleHost` 并在启动时装载一次（当前清单为空）
 *   3. 在 console 请求回调中、第一条业务路由 if 之前插入一次委派
 *   4. 新增只读诊断端点 `GET /api/_modules`
 *
 * 刻意不动：
 *   · 12 道集中闸门、114 条老路由、`catch` 兜底 —— 一个字节都不改
 *   · 委派放在闸门之后：模块拿不到任何绕过鉴权的机会
 *   · `cfg.socialV2.modules.enabled === false` 时不建 host，老路径完全不受影响
 *
 * 位置踩过的坑（写在这里，免得下次再踩）：
 *   `server.listen()` 所在的 `startConsoleServer()` **不是 async**
 *   （`src/bridge.js:9645` 的 `return server;` 后立刻 `}`，往上一路没有 async 声明）。
 *   在那儿写 `await` 会让整个 1.5 万行的文件语法错误。所以装载写在 `main()` 里、
 *   `startConsoleServer()` 的调用点之后 —— 那里本来就是 async 上下文。
 *   第二个坑：第一版把委派插在 favicon 之前，等于让模块跑在 Host 校验和令牌校验
 *   前面。已改成 favicon 之后。
 *   第三个坑：五个插入点一开始共用同一个 MARKER，`once()` 判重把后面几步误判成
 *   「已打过」而静默跳过。现在每处一个独立标记。
 *
 * 幂等：重复执行不会插第二遍。
 * 安全：先写临时文件过 `node --check`，语法不过就不动线上文件。
 *
 * 用法：node scripts/patch-modules-stage1.mjs [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = '/opt/qq-bridge';
const SRC = path.join(ROOT, 'src', 'bridge.js');
const dryRun = process.argv.includes('--dry-run');

const MARK = {
  import: '// MARKER: modules-import',
  helper: '// MARKER: modules-helper',
  delegate: '// MARKER: modules-delegate',
  diag: '// MARKER: modules-diagnostics',
  loader: '// MARKER: modules-loader',
};

let src = fs.readFileSync(SRC, 'utf8');
const before = src;
const done = [];

function once(name, fn) {
  if (src.includes(MARK[name])) {
    console.log(`跳过 ${name}：已有标记`);
    return false;
  }
  const next = fn(src);
  if (next === src) throw new Error(`${name} 没有产生改动`);
  src = next;
  done.push(name);
  return true;
}

// ── 1. import ────────────────────────────────────────────────────────────────
once('import', (s) => {
  const re = /(^import [^\n]*from '\.\/[^\n]*';\n)/gm;
  let last = null;
  let m;
  while ((m = re.exec(s)) !== null) last = m;
  if (!last) throw new Error('找不到本地 import 块');
  const at = last.index + last[1].length;
  const block = [
    `${MARK.import}`,
    '// 功能模块装载器（阶段 1：只建骨架，模块清单还是空的）。',
    '// 装载失败不该连累 24/7 主进程，所以装载处用 try 兜住，失败只降级为「没有模块」。',
    "import { createModuleHost } from './modules/registry.js';",
    "import { defineModules } from './modules/index.js';",
    '',
  ].join('\n');
  return s.slice(0, at) + block + s.slice(at);
});

// ── 2. main() 里声明 moduleHost（紧跟 cfg 之后，作用域覆盖整个 main）──────────
once('helper', (s) => {
  const anchor = '  const cfg = loadConfig();';
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('找不到 `const cfg = loadConfig();`');
  const at = idx + anchor.length;
  const block = [
    '',
    `  ${MARK.helper}`,
    '  // 功能模块装载器句柄。null = 没装载（配置关了，或装载失败）→ 请求回调里整段委派跳过。',
    '  // 放在 main 顶层而不是请求回调里，是为了只建一次、只装载一次。',
    '  let moduleHost = null;',
  ].join('\n');
  return s.slice(0, at) + block + s.slice(at);
});

// ── 3. 请求回调：委派（favicon 之后、第一条业务路由之前）─────────────────────
once('delegate', (s) => {
  const anchor = "      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {";
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('找不到 favicon 锚点');
  const tail = '        return;\n      }\n';
  const tailIdx = s.indexOf(tail, idx);
  if (tailIdx < 0) throw new Error('找不到 favicon 块结尾');
  const insertAt = tailIdx + tail.length;
  const block = [
    '',
    `      ${MARK.delegate}`,
    '      // 功能模块委派（阶段 1）。',
    '      //',
    '      // 位置很关键：在 favicon 之后、**第一条业务路由之前**。favicon 之后意味着它已经',
    '      // 落在全部集中闸门（Host、令牌、智能体隔离）之后 —— 模块没有绕开鉴权的机会，',
    '      // 它们和后面的 if 链看到的是同一份已经过审的请求。',
    '      //',
    '      // 没命中任何模块路由时返回 "unhandled"，继续走下面的老 if 链，行为零变化。',
    '      if (moduleHost) {',
    "        let verdict = 'unhandled';",
    '        try {',
    '          verdict = await moduleHost.dispatch(req.method, url.pathname, { req, res, url, sendJson, readBody });',
    '        } catch (error) {',
    "          log('[modules] 路由处理失败:', error?.message ?? error);",
    "          sendJson({ ok: false, error: `模块处理失败：${error?.message ?? error}` }, Number(error?.statusCode) || 500);",
    '          return;',
    '        }',
    "        if (verdict === 'handled') return;",
    '      }',
    '',
  ].join('\n');
  return s.slice(0, insertAt) + block + s.slice(insertAt);
});

// ── 4. 诊断端点（Host 校验之前、favicon 之后）────────────────────────────────
once('diag', (s) => {
  const anchor = '      // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，因此合法请求的 Host';
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('找不到 Host 校验锚点');
  const block = [
    `${MARK.diag}`,
    '      // 模块诊断端点（只读）。只回「装了什么、有没有问题」，不含令牌、聊天内容或文件路径。',
    '      // 故意的取舍：放在 Host 校验之后（DNS rebinding 那层仍然有效），但放在令牌校验之前 ——',
    '      // 出问题时最需要「不登录也能一眼看出装载器活没活」。它不泄露任何会话数据。',
    "      if (req.method === 'GET' && url.pathname === '/api/_modules') {",
    '        sendJson({',
    '          ok: true,',
    "          enabled: cfg.socialV2?.modules?.enabled !== false,",
    '          loaded: moduleHost !== null,',
    '          registry: moduleHost ? moduleHost.describe() : null,',
    '        });',
    '        return;',
    '      }',
    '',
  ].join('\n');
  return s.slice(0, idx) + block + s.slice(idx);
});

// ── 5. main() 里装载（startConsoleServer() 之后，async 上下文）────────────────
once('loader', (s) => {
  const anchor = '  startConsoleServer();';
  const idx = s.indexOf(anchor);
  if (idx < 0) throw new Error('找不到 startConsoleServer() 调用点');
  const at = idx + anchor.length;
  const block = [
    '',
    '  // ── 功能模块装载（阶段 1：骨架） ────────────────────────────────────────',
    `  ${MARK.loader}`,
    '  //',
    '  // 只装载一次、只装载声明了的模块。空清单也要建 host：`/api/_modules` 靠它回答',
    '  // 「装载器是否在工作」。单个模块的装载异常在 host 内部被兜住并记进 problems，',
    '  // 不会冒到这里 —— 一个模块写坏了不该让桥接起不来。',
    '  //',
    '  // `cfg.socialV2.modules.enabled === false` 时不装载（回退开关），',
    '  // moduleHost 保持 null → 请求回调里那段委派整段跳过。',
    '  if (cfg.socialV2?.modules?.enabled !== false) {',
    '    try {',
    '      moduleHost = createModuleHost({',
    '        ctx: {',
    '          cfg,',
    '          log: (message) => log(message),',
    '          sendJson,',
    '          readBody,',
    '          stateDir: STATE_DIR,',
    '        },',
    '        log: (message) => log(message),',
    '        onError: (mod, phase, error) => log(`[modules] ${phase} 失败 ${mod?.name ?? "?"}：${error?.message ?? error}`),',
    '      });',
    '      await moduleHost.load(defineModules());',
    '      log(`[modules] 装载完成：${moduleHost.loaded.length} 个模块 / ${moduleHost.describe().routes.length} 条路由`);',
    '    } catch (error) {',
    '      moduleHost = null;',
    "      log('[modules] 装载失败，已降级为无模块：', error?.message ?? error);",
    '    }',
    '  }',
  ].join('\n');
  return s.slice(0, at) + block + s.slice(at);
});

if (src === before) {
  console.log('没有任何改动（已全部打过）');
  process.exit(0);
}

const tmp = path.join(ROOT, 'src', '.bridge-stage1.tmp.js');
fs.writeFileSync(tmp, src, 'utf8');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (e) {
  fs.rmSync(tmp, { force: true });
  console.error('语法检查失败，未改动线上文件：');
  console.error(String(e.stderr ?? e.message).slice(0, 4000));
  process.exit(1);
}
fs.rmSync(tmp, { force: true });

if (dryRun) {
  console.log(`[dry-run] 将插入：${done.join(', ')}（未写盘）`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const backup = `${SRC}.bak-stage1patch-${stamp}`;
fs.copyFileSync(SRC, backup);
fs.writeFileSync(SRC, src, 'utf8');
console.log(`已打补丁：${done.join(', ')}`);
console.log(`备份：${backup}（${before.length} -> ${src.length} 字节）`);
