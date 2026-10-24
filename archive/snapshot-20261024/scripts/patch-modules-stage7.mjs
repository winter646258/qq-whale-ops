// 阶段7：把 DSH 连接 / 思考强度 / 读取授权 / 重启（4 条路由）搬进 ops 模块。
//
// 幂等：已打过就跳过。先写临时文件过 node --check，再落盘。
//
// 依赖注入的教训（第一版炸在 `agentTokenOk is not defined`）：
//   ① `agentTokenOk` / `isLiveAgentToken` 是 `startConsoleServer()` 里的**局部 const**，
//      main() 作用域看不到 ⇒ 必须由 startConsoleServer 在**创建 server 之前**交出来。
//   ② 同理不能引用声明点在注入点之后的 name —— 那是 TDZ，运行时才炸。
//      modelCatalogErrorLogged / fetchModelCatalog 声明在注入点后面，靠函数体天然延迟求值规避。
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/qq-bridge';
const TARGET = path.join(ROOT, 'src/bridge.js');
const dryRun = process.argv.includes('--dry-run');

const source = fs.readFileSync(TARGET, 'utf8');
let text = source;
const marks = [];

function die(message) {
  console.error(`[stage7] ${message}`);
  process.exit(1);
}

function once(tag, fn) {
  if (text.includes(`// MARKER: ${tag}`)) {
    marks.push(`跳过 ${tag}：已存在`);
    return;
  }
  const before = text.length;
  text = fn(text);
  marks.push(`插入 ${tag}：${text.length - before} 字符`);
}

// ── 1) 把鉴权原语交给 main() 作用域 ────────────────────────────────────
once('modules-ctx-ops-token', (t) => {
  const anchor = '    const v2SessionAllowed = isSessionAllowedInCurrentMode;\n';
  if (!t.includes(anchor)) die('找不到 v2SessionAllowed 锚点');
  return t.replace(anchor, `${anchor}    // MARKER: modules-ctx-ops-token
    // 把鉴权原语交到 main() 作用域：它们是 startConsoleServer() 的局部 const，
    // ops 模块的 /api/authorize/read 要用，但模块拿不到那个闭包。
    Object.assign(moduleCtx, { agentTokenOk, isLiveAgentToken });
`);
});

// ── 2) 注入 dshHelpers ─────────────────────────────────────────────────
once('modules-ctx-ops', (t) => {
  const anchor = '  const modelCatalogErrorLogged = new Set();\n';
  if (!t.includes(anchor)) die('找不到 modelCatalogErrorLogged 声明');
  const block = `  // MARKER: modules-ctx-ops
  // DSH 运维族的依赖包。这里只放**调用时才求值**的东西：
  //   · fetchModelCatalog / modelCatalogErrorLogged 声明在本行之后，
  //     但只出现在函数体里，调用发生在装载之后 ⇒ 不会 TDZ。
  //   · modelCatalogInFlight / modelSelectionEpoch / currentMode 是会被整体重新赋值的
  //     let，只能通过闭包读写，不能交快照值。
  Object.assign(moduleCtx, {
    dshHelpers: {
      effortOptions: REASONING_EFFORT_OPTIONS,
      effortDefault: REASONING_EFFORT_DEFAULT,
      normalizeEffort: normalizeReasoningEffort,
      configFile: path.join(ROOT, 'config.json'),
      readConfigObject,
      atomicWriteJson,
      loadModelCatalog: async () => {
        // 复用同一个在飞请求 + 3 秒兜底：控制台每次刷新都会打这条接口。
        if (!modelCatalogInFlight) {
          modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
            .finally(() => { modelCatalogInFlight = null; });
        }
        return unwrap(await modelCatalogInFlight, 'session.modelCatalog');
      },
      noteCatalogFailure: (error) => {
        // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
        const reason = String(error?.message ?? error);
        if (modelCatalogErrorLogged.has(reason)) return;
        modelCatalogErrorLogged.add(reason);
        log(\`读取 DSH 模型能力失败，思考强度暂用内置清单：\${reason}\`);
      },
      bumpModelSelectionEpoch: () => { modelSelectionEpoch += 1; },
      modeAllowed,
      currentMode: () => currentMode,
      saveState,
      saveSocialV2State,
      releaseLock,
    },
  });
${anchor}`;
  return t.replace(anchor, block);
});

// ── 3) 删四条老路由 ────────────────────────────────────────────────────
const targets = [
  ["if (req.method === 'GET' && url.pathname === '/api/dsh/model') {", '/api/dsh/model'],
  ["if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {", '/api/dsh/effort'],
  ["if (req.method === 'POST' && url.pathname === '/api/authorize/read') {", '/api/authorize/read'],
  ["if (req.method === 'POST' && url.pathname === '/api/restart') {", '/api/restart'],
];

const pending = [];
for (const [signature, label] of targets) {
  if (!text.includes(signature)) { marks.push(`跳过删除 ${label}：已搬走`); continue; }
  pending.push({ signature, label });
}
if (pending.length) {
  // 先把每个块的区间都算出来，再从后往前删，避免前面的删除搅乱后面的行号。
  const lines = text.split('\n');
  const ranges = [];
  for (const { signature, label } of pending) {
    const startIdx = lines.findIndex((line) => line.includes(signature));
    if (startIdx === -1) die(`找不到待删路由块：${label}`);
    const indent = lines[startIdx].match(/^\s*/)[0];
    const closeRe = new RegExp(`^${indent}}\\s*$`);
    let endIdx = -1;
    for (let i = startIdx + 1; i < lines.length; i += 1) {
      if (closeRe.test(lines[i])) { endIdx = i; break; }
    }
    if (endIdx === -1) die(`待删路由块没有闭合：${label}`);
    ranges.push({ label, startIdx, endIdx });
  }
  ranges.sort((a, b) => b.startIdx - a.startIdx);
  for (const { label, startIdx, endIdx } of ranges) {
    const removed = endIdx - startIdx + 1;
    lines.splice(startIdx, removed);
    // 顺手吞掉后面紧邻的一个空行，避免留下双空行
    if (lines[startIdx] === '' && lines[startIdx + 1] === '') lines.splice(startIdx, 1);
    marks.push(`删除 ${label}：${removed} 行（原起始行 ${startIdx + 1}）`);
  }
  text = lines.join('\n');
}

if (text === source) {
  console.log('[stage7] 无需改动（全部已应用）');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const tmp = path.join(ROOT, 'src/.bridge-stage7.tmp.js');
fs.writeFileSync(tmp, text);
const { execFileSync } = await import('node:child_process');
try {
  execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
} catch (error) {
  console.error('[stage7] 语法检查失败，未改动线上文件');
  console.error(String(error.stderr ?? error.message));
  fs.unlinkSync(tmp);
  process.exit(1);
}
fs.unlinkSync(tmp);

if (dryRun) {
  console.log('[stage7] dry-run，未写入');
  for (const line of marks) console.log(`  ${line}`);
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
const backup = path.join(ROOT, `src/bridge.js.bak-stage7b-${stamp}`);
fs.copyFileSync(TARGET, backup);
fs.writeFileSync(TARGET, text);
console.log(`[stage7] 已写入 ${TARGET}（备份 ${path.basename(backup)}）`);
console.log(`[stage7] 行数 ${source.split('\n').length} → ${text.split('\n').length}`);
for (const line of marks) console.log(`  ${line}`);
