// 阶段29：合并转发查看两条（GET /api/socialV2/forward-message、POST /api/socialV2/forward-media）
// 搬进 src/modules/forward/。
//
// 这一批是老 if 链里**最后两条**普通路由（剩下只有 root-page 两处 `GET /`，
// 它们分属不同闸门阶段、不能搬）。
//
// 与前面各阶段相同的三条纪律：
// - 注入块只用注入点之前已声明的名字，其余包箭头（这里是全部包箭头，见下）。
// - 删除区按「下一个 MARKER」收尾，并守卫「删除区里不该出现别的路由判断」。
// - 幂等靠 MARKER，改过注入块内容要手工摘掉旧块再重跑。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'bridge.js');
const REG = path.join(ROOT, 'src', 'modules', 'index.js');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const dryRun = process.argv.includes('--dry-run');

let src = fs.readFileSync(FILE, 'utf8');

// ── 1. 注入 ctx ────────────────────────────────────────────────────────────
const MARK_CTX = '// MARKER: modules-ctx-forward';
const CTX_ANCHOR = '// MARKER: modules-ctx-bili';
const CTX_BLOCK = `${MARK_CTX}
  // 合并转发查看模块的句柄。全部包箭头：
  // getSocialV2State / fetchMediaData / modeAllowed 都在注入点之后声明，
  // bot 是 late 绑定（可能在 main() 里被整体重新赋值），seenForwardIds 是会被清空的 Map。
  Object.assign(moduleCtx, {
    forwardHelpers: {
      currentMode: () => currentMode,
      getSocialV2State: (k) => getSocialV2State(k),
      modeAllowed: (k, kind, id, config, mode) => modeAllowed(k, kind, id, config, mode),
      seenForwardIds: () => seenForwardIds,
      bot: () => bot,
      fetchMediaData: (list) => fetchMediaData(list),
    },
  });
`;
if (src.includes(MARK_CTX)) {
  console.log('跳过 ctx 注入（已存在）');
} else {
  const at = src.indexOf(CTX_ANCHOR);
  if (at < 0) throw new Error('找不到 ctx 注入锚点（modules-ctx-bili）');
  src = src.slice(0, at) + CTX_BLOCK + '\n' + src.slice(at);
  console.log('插入 ' + MARK_CTX);
}

// ── 2. 删老 if ─────────────────────────────────────────────────────────────
const START = "        if (req.method === 'GET' && url.pathname === '/api/socialV2/forward-message') {";
const END = '        // MARKER: bili-route';
const si = src.indexOf(START);
if (si >= 0) {
  const ei = src.indexOf(END, si);
  if (ei < 0) throw new Error('找不到 forward 路由的结束锚点（bili-route）');
  const removed = src.slice(si, ei);
  const extra = removed.slice(START.length);
// 守卫：删除区里只该出现 forward-message 与 forward-media 这两条判断。
  // 注意不能写成 `url.pathname === `（带尾空格）—— 源码里是 `url.pathname === '...'`，
  // 没有空格分隔，那样写永远匹配不到，守卫等于没写。
  const routeJudgements = extra.match(/url\.pathname === '/g) || [];
  if (routeJudgements.length !== 1) {
    throw new Error(`删除区里出现了 ${routeJudgements.length + 1} 条路由判断（应为 2），锚点选错了`);
  }
  if (!removed.includes("url.pathname === '/api/socialV2/forward-media'")) {
    throw new Error('删除区里没有 forward-media，说明切少了');
  }
  src = src.slice(0, si) + src.slice(ei);
  console.log(`删除老 if 共 ${removed.split('\n').length - 1} 行`);
} else {
  console.log('老 if 已不存在（可能已搬过）');
}

// ── 3. 注册模块 ────────────────────────────────────────────────────────────
let reg = fs.readFileSync(REG, 'utf8');
if (!reg.includes("from './forward/index.js'")) {
  reg = "import forwardModule from './forward/index.js';\n" + reg;
  const m = /return\s*\[\s*([\s\S]*?)\s*\];/.exec(reg);
  if (!m) throw new Error('找不到 defineModules 的返回数组');
  const inner = m[1].trimEnd();
  const patched = inner.endsWith(',') ? `${inner}\n    forwardModule,` : `${inner},\n    forwardModule,`;
  reg = reg.replace(m[0], `return [\n    ${patched}\n  ];`);
  console.log('注册 forward 模块');
} else {
  console.log('跳过模块注册（已存在）');
}

if (dryRun) { console.log('dry-run：不写盘'); process.exit(0); }

fs.copyFileSync(FILE, path.join(ROOT, 'src', `bridge.js.bak-stage29-${stamp}`));
fs.writeFileSync(FILE, src);
fs.writeFileSync(REG, reg);
console.log(`已写 src/bridge.js（${fs.statSync(FILE).size} 字节）与 src/modules/index.js`);
