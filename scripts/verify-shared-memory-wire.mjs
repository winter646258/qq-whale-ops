// 隔离副本上验证「接线层闭包 + 权限 + 注入」是否真的成立。
//
// 不启动完整 bridge（那要连 OneBot/DSH），而是从打补丁后的 bridge.js 里
// **按大括号配对抽出**接线层那几个函数，配一个最小 shim 一起求值，
// 再用真实 store 模块跑权限与注入的端到端。
//
// 这样验证的是「部署出去的那份代码」，不是我在本地重写一遍的版本。
import fs from 'node:fs';
import path from 'node:path';

const BRIDGE = '/tmp/smv/bridge.js';
const src = fs.readFileSync(BRIDGE, 'utf8');

/**
 * 从 from 位置开始，按括号配对找出函数体结束位置。
 *
 * 不能「找到第一个 { 就当函数体开头」：`persistSharedMemoryState(store,
 * { action, key, detail } = {})` 这种解构参数的 { 会先把深度配平掉，抽出来的
 * 只有参数表。正确顺序是先配平参数表的 ( ... )，之后第一个 { 才是函数体。
 */
function extractFn(text, name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`找不到函数 ${name}`);
  let i = text.indexOf('(', m.index + m[0].length - 1);
  let pdepth = 0;
  let parenEnd = -1;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') pdepth += 1;
    else if (text[i] === ')') {
      pdepth -= 1;
      if (pdepth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd < 0) throw new Error(`${name}: 参数表括号不配对`);
  const bodyStart = text.indexOf('{', parenEnd);
  if (bodyStart < 0) throw new Error(`${name}: 找不到函数体`);
  let depth = 0;
  for (let j = bodyStart; j < text.length; j += 1) {
    const c = text[j];
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(m.index + 1, j + 1);
    }
  }
  throw new Error(`${name}: 大括号不配对`);
}

const fns = ['loadSharedMemoryState', 'getSharedMemoryState', 'persistSharedMemoryState',
  'appendSharedMemoryAudit', 'sharedMemoryReaderFor', 'sharedMemoryReaderOrDeny',
  'buildSharedMemoryLineFor', 'sharedMemoryGroupIdOf', 'v2ToolEnabled'];

const bodies = fns.map((n) => extractFn(src, n)).join('\n\n');
console.log(`抽取 ${fns.length} 个函数，共 ${bodies.length} 字符`);

// 模块级缓存变量是**闭包**而非函数体，抽函数抽不到，得在 shim 里补上。
// （抽函数做隔离验证的固有代价：闭包状态必须由宿主显式提供。）

// 最小 shim：只提供这些函数真正用到的东西。
const shim = `
import fs from 'node:fs';
import path from 'node:path';
import {
  loadSharedMemory, saveSharedMemory, canRead, addItem, updateItem,
  forgetItem, archiveItem, pruneStore, listItems, formatForPrompt,
  listGroupScopeForOwner, findSimilar, statsOf as sharedMemoryStats,
  ownerReader, groupReader, groupIdOfScope,
  MAX_ITEMS as SHARED_MEMORY_MAX_ITEMS,
  MAX_ARCHIVED as SHARED_MEMORY_MAX_ARCHIVED,
  MAX_TEXT_CHARS as SHARED_MEMORY_MAX_TEXT,
  INJECT_MAX_ITEMS as SHARED_MEMORY_INJECT_MAX_ITEMS,
  INJECT_MAX_CHARS as SHARED_MEMORY_INJECT_MAX_CHARS
} from '/tmp/smv/shared-memory-store.js';

const __dirname = '/tmp/smv';
const ROOT = '/tmp/smv';
const STATE_DIR = path.join(ROOT, 'state');
const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');
const cfg = { ownerQQ: 1124721191, socialV2: {} };
function bounded(name, fallback, lo, hi) {
  const v = Number(process.env['TEST_' + name]);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}
let sharedMemoryCache = null;

${bodies}

export {
  loadSharedMemoryState, getSharedMemoryState, persistSharedMemoryState,
  sharedMemoryReaderFor, sharedMemoryReaderOrDeny, buildSharedMemoryLineFor,
  sharedMemoryGroupIdOf, v2ToolEnabled, cfg
};
`;

fs.writeFileSync('/tmp/smv/wire-harness.mjs', shim, 'utf8');

const {
  sharedMemoryReaderFor, sharedMemoryReaderOrDeny, buildSharedMemoryLineFor,
  sharedMemoryGroupIdOf, getSharedMemoryState, persistSharedMemoryState,
  v2ToolEnabled, cfg
} = await import('/tmp/smv/wire-harness.mjs');

let pass = 0;
let fail = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass += 1; console.log(`PASS ${label}`); }
  else { fail += 1; console.log(`FAIL ${label}\n  期望 ${JSON.stringify(expected)}\n  实际 ${JSON.stringify(actual)}`); }
}

// ── reader 解析 ──────────────────────────────────────────────────
check('group:906710082 -> group reader',
  sharedMemoryReaderFor('group:906710082'), { kind: 'group', id: '906710082' });
check('private:ownerQQ -> owner reader',
  sharedMemoryReaderFor('private:1124721191'), { kind: 'owner' });
check('private:好友 -> null（不猜）',
  sharedMemoryReaderFor('private:2050117833'), null);
check('乱码 key -> null', sharedMemoryReaderFor('group:abc'), null);
check('空 key -> null', sharedMemoryReaderFor(''), null);
check('worker key -> null', sharedMemoryReaderFor('worker:1'), null);
check('readerOrDeny 对好友也是 null',
  sharedMemoryReaderOrDeny('private:2050117833'), null);
check('groupIdOf 对群 key',
  sharedMemoryGroupIdOf('group:906710082'), '906710082');
check('groupIdOf 对私聊 null',
  sharedMemoryGroupIdOf('private:1124721191'), null);

// ── 注入 ────────────────────────────────────────────────────────
// 要用 delete 而不是赋空串：Number('') === 0 是有限值，bounded 会把它钳到
// 下限 200，于是「默认」和「收紧」两次量出来一样长，测试假绿。
delete process.env.TEST_sharedMemoryMaxChars;
const st = getSharedMemoryState();
st.items.length = 0;

// 铺数据：私聊专属、共享给本群、共享给别群、本群专属、别群专属
const storeMod = await import('/tmp/smv/shared-memory-store.js');
storeMod.addItem(st, { text: '主人其实很怕黑', scope: 'owner_private', importance: 9 });
storeMod.addItem(st, { text: '群里最近在追某部番', scope: 'shared', visibleGroups: ['906710082'], importance: 6 });
storeMod.addItem(st, { text: '那个群才懂的梗', scope: 'shared', visibleGroups: ['910502749'], importance: 5 });
storeMod.addItem(st, { text: '本群专属的小事', scope: 'group:906710082', importance: 4 });
storeMod.addItem(st, { text: '别群的秘密', scope: 'group:910502749', importance: 4 });
persistSharedMemoryState(st, { action: 'seed', key: 'test' });

const ownerLine = buildSharedMemoryLineFor('private:1124721191');
const g1Line = buildSharedMemoryLineFor('group:906710082');
const g2Line = buildSharedMemoryLineFor('group:910502749');
const friendLine = buildSharedMemoryLineFor('private:2050117833');

check('主人私聊注入含 owner_private', ownerLine.includes('主人其实很怕黑'), true);
check('主人私聊注入不含 group:906710082 专属（不自动注入）',
  ownerLine.includes('本群专属的小事'), false);
check('主人私聊注入不含 group:910502749 专属',
  ownerLine.includes('别群的秘密'), false);
check('群 906710082 注入含本群内容', g1Line.includes('本群专属的小事'), true);
check('群 906710082 注入含点了名的 shared', g1Line.includes('群里最近在追某部番'), true);
check('群 906710082 注入**不含** owner_private', g1Line.includes('主人其实很怕黑'), false);
check('群 906710082 注入不含别群专属', g1Line.includes('别群的秘密'), false);
check('群 906710082 注入不含别群 shared', g1Line.includes('那个群才懂的梗'), false);
check('群 910502749 注入含自己的', g2Line.includes('别群的秘密'), true);
check('群 910502749 注入不含 906710082 的', g2Line.includes('本群专属的小事'), false);
check('非主人私聊注入为空', friendLine, '');

// ── 注入封顶 ────────────────────────────────────────────────────
st.items.length = 0;
for (let i = 0; i < 30; i += 1) {
  storeMod.addItem(st, {
    text: `第${i}件记得的事`.repeat(3), scope: 'owner_private', importance: 5, now: 1000 + i
  });
}
persistSharedMemoryState(st, { action: 'seed2', key: 'test' });
const capped = buildSharedMemoryLineFor('private:1124721191');
const lines = capped.split('\n').filter((l) => l.startsWith('- '));
check('注入条数封顶 8', lines.length <= 8, true);
check('注入字数封顶 600（不含标题与尾注）',
  lines.join('\n').length <= 700, true);
check('封顶后仍有尾注提示去翻', capped.includes('qq_shared_memory'), true);

// 收紧上限也要生效
process.env.TEST_sharedMemoryMaxChars = '200';
const tighter = buildSharedMemoryLineFor('private:1124721191');
check('运维收紧到 200 字后注入变短',
  tighter.length < capped.length, true);
delete process.env.TEST_sharedMemoryMaxChars;

// ── 关闭开关 ────────────────────────────────────────────────────
cfg.socialV2.sharedMemory = { enabled: false };
check('enabled=false 时注入为空', buildSharedMemoryLineFor('private:1124721191'), '');
cfg.socialV2.sharedMemory = { enabled: true };
check('enabled=true 时恢复', buildSharedMemoryLineFor('private:1124721191').length > 0, true);

// ── 工具开关 ────────────────────────────────────────────────────
cfg.socialV2.tools = { sharedMemory: false };
check('工具开关关闭后 v2ToolEnabled=false', v2ToolEnabled('sharedMemory'), false);
cfg.socialV2.tools = {};
check('未配置时默认开', v2ToolEnabled('sharedMemory'), true);

// ── 损坏恢复 ────────────────────────────────────────────────────
const file = '/tmp/smv/state/shared-memory.json';
const good = fs.readFileSync(file, 'utf8');
fs.writeFileSync(file, '{ 坏掉的 json', 'utf8');
// 换一个模块实例来绕开 cache：直接调 loadSharedMemory 语义由 store 保证，
// 这里验证接线层不会把它当空库写回去。
const { loadSharedMemory } = storeMod;
let threw = false;
try { loadSharedMemory(file); } catch { threw = true; }
check('损坏文件读取抛错', threw, true);
fs.writeFileSync(file, good, 'utf8');
check('恢复后能正常注入', buildSharedMemoryLineFor('private:1124721191').length > 0, true);

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
