// 阶段28：把 POST /api/socialV2/bili 搬进 src/modules/bili/。
//
// 做法与前面各阶段一致：注入 ctx 句柄 → 整段删除老 if → 注册模块。
// 幂等：第二次跑会全部「跳过」。
//
// 注意（前面几个阶段踩过的坑，这里都规避了）：
// - 注入块里**不能出现**在注入点之后才声明的裸标识符（对象字面量的值位置是立即求值的 ⇒ TDZ）。
//   `biliClient` 是懒建工厂（let + function 在 L5008），注入点放在它之后，交箭头即可。
// - 注入块内容一旦改过，别指望重跑补丁 —— once() 只认 MARKER，会静默复用旧块。
// - 删除区必须按「下一个 MARKER」收尾，不能按行数，否则容易切掉相邻路由。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILE = path.join(ROOT, 'src', 'bridge.js');
const REG = path.join(ROOT, 'src', 'modules', 'index.js');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
const dryRun = process.argv.includes('--dry-run');

let src = fs.readFileSync(FILE, 'utf8');

// ── 1. 注入 ctx：紧跟在 biliClient() 函数声明之后 ───────────────────────────
const MARK_CTX = '// MARKER: modules-ctx-bili';
const CTX_ANCHOR = '  /** 给别的模块用：现在能不能刷站（扩展在线吗）。 */';
const CTX_BLOCK = `${MARK_CTX}
  // B 站浏览模块用的句柄。biliClient 懒建一次后复用（内部持有唯一的 PhoneBridge 订阅），
  // 所以交工厂而不是交实例 —— 注入这一刻它还是 null。
  Object.assign(moduleCtx, {
    biliHelpers: {
      biliClient: () => biliClient(),
      phoneOnline: () => phoneOnline(),
      describePhoneOffline,
      describeBiliResult,
    },
  });
`;
if (src.includes(MARK_CTX)) {
  console.log('跳过 ctx 注入（已存在）');
} else {
  const at = src.indexOf(CTX_ANCHOR);
  if (at < 0) throw new Error('找不到 ctx 注入锚点（phoneOnline 的注释行）');
  src = src.slice(0, at) + CTX_BLOCK + '\n' + src.slice(at);
  console.log('插入 ' + MARK_CTX);
}

// ── 2. 删老 if：从 bili 判断起到下一个 MARKER 之前 ─────────────────────────
const START = "        if (url.pathname === '/api/socialV2/bili' && req.method === 'POST') {";
const END = '        // MARKER: share-signal-route';
const si = src.indexOf(START);
if (si >= 0) {
  const ei = src.indexOf(END, si);
  if (ei < 0) throw new Error('找不到 bili 路由的结束锚点（share-signal-route）');
  const removed = src.slice(si, ei);
  // 守卫：删除区里不该出现第二条路由判断，出现就说明锚点选错、切多了
  if (removed.slice(START.length).includes("url.pathname === '")) {
    throw new Error('删除区里出现了别的路由判断，锚点选错了');
  }
  src = src.slice(0, si) + src.slice(ei);
  console.log(`删除老 if 共 ${removed.split('\n').length - 1} 行`);
} else {
  console.log('老 if 已不存在（可能已搬过）');
}

// ── 3. 注册模块 ────────────────────────────────────────────────────────────
let reg = fs.readFileSync(REG, 'utf8');
if (!reg.includes("from './bili/index.js'")) {
  reg = "import biliModule from './bili/index.js';\n" + reg;
  const m = /return\s*\[\s*([\s\S]*?)\s*\];/.exec(reg);
  if (!m) throw new Error('找不到 defineModules 的返回数组');
  const inner = m[1].trimEnd();
  const patched = inner.endsWith(',') ? `${inner}\n    biliModule,` : `${inner},\n    biliModule,`;
  reg = reg.replace(m[0], `return [\n    ${patched}\n  ];`);
  console.log('注册 bili 模块');
} else {
  console.log('跳过模块注册（已存在）');
}

if (dryRun) { console.log('dry-run：不写盘'); process.exit(0); }

fs.copyFileSync(FILE, path.join(ROOT, 'src', `bridge.js.bak-stage28-${stamp}`));
fs.writeFileSync(FILE, src);
fs.writeFileSync(REG, reg);
console.log(`已写 src/bridge.js（${fs.statSync(FILE).size} 字节）与 src/modules/index.js`);
