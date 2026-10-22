// 用**线上正在跑的那份 bridge.js** + **线上真实 state** 验证注入文本。
//
// 之所以不直接打 /api/socialV2/wake：那会真的发起一次模型回合、真的给主人发消息，
// 为了看一眼字符串不值得。这里同样是从部署文件里抽函数求值，但数据来自
// /opt/qq-bridge/state/shared-memory.json，等于「部署代码 + 真实数据」的组合。
import fs from 'node:fs';

const BRIDGE = process.env.BRIDGE || '/opt/qq-bridge/src/bridge.js';
const ROOT = process.env.QROOT || '/opt/qq-bridge';
const src = fs.readFileSync(BRIDGE, 'utf8');

function extractFn(text, name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`找不到函数 ${name}`);
  let i = text.indexOf('(', m.index + m[0].length - 1);
  let pdepth = 0;
  let parenEnd = -1;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') pdepth += 1;
    else if (text[i] === ')') { pdepth -= 1; if (pdepth === 0) { parenEnd = i; break; } }
  }
  const bodyStart = text.indexOf('{', parenEnd);
  let depth = 0;
  for (let j = bodyStart; j < text.length; j += 1) {
    if (text[j] === '{') depth += 1;
    else if (text[j] === '}') { depth -= 1; if (depth === 0) return text.slice(m.index + 1, j + 1); }
  }
  throw new Error(`${name}: 大括号不配对`);
}

const fns = ['loadSharedMemoryState', 'getSharedMemoryState', 'sharedMemoryReaderFor',
  'buildSharedMemoryLineFor', 'sharedMemoryGroupIdOf'];
const bodies = fns.map((n) => extractFn(src, n)).join('\n\n');

const shim = `
import fs from 'node:fs';
import path from 'node:path';
import {
  loadSharedMemory, saveSharedMemory, canRead, addItem, updateItem,
  forgetItem, archiveItem, pruneStore, listItems, formatForPrompt,
  listGroupScopeForOwner, findSimilar, statsOf as sharedMemoryStats,
  ownerReader, groupReader, groupIdOfScope,
  INJECT_MAX_ITEMS as SHARED_MEMORY_INJECT_MAX_ITEMS,
  INJECT_MAX_CHARS as SHARED_MEMORY_INJECT_MAX_CHARS
} from '${ROOT}/src/shared-memory-store.js';

const STATE_DIR = path.join('${ROOT}', 'state');
const SHARED_MEMORY_FILE = path.join(STATE_DIR, 'shared-memory.json');
const cfg = { ownerQQ: 1124721191, socialV2: {} };
function bounded(name, fallback, lo, hi) {
  const v = Number(process.env['TEST_' + name]);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(hi, Math.max(lo, v));
}
let sharedMemoryCache = null;

${bodies}

export { buildSharedMemoryLineFor, sharedMemoryReaderFor };
`;

const tmp = `${ROOT}/state/.verify-inject.mjs`;
fs.writeFileSync(tmp, shim, 'utf8');
const { buildSharedMemoryLineFor, sharedMemoryReaderFor } = await import(tmp);
fs.unlinkSync(tmp);

console.log('=== 线上真实数据下的注入文本 ===\n');
for (const key of ['private:1124721191', 'group:906710082', 'group:910502749', 'private:2050117833']) {
  const line = buildSharedMemoryLineFor(key);
  console.log(`【${key}】reader=${JSON.stringify(sharedMemoryReaderFor(key))}`);
  console.log(line ? line.trimEnd() : '(空——这个会话看不到任何共享记忆)');
  console.log('');
}

// 断言
const owner = buildSharedMemoryLineFor('private:1124721191');
const g1 = buildSharedMemoryLineFor('group:906710082');
const g2 = buildSharedMemoryLineFor('group:910502749');
const other = buildSharedMemoryLineFor('private:2050117833');
const checks = [
  ['主人私聊能看到 owner_private', owner.includes('不喜欢被打断'), true],
  ['主人私聊拿不到群专属', owner.includes('追那部新番'), false],
  ['群 906710082 能看到本群专属', g1.includes('追那部新番'), true],
  ['群 906710082 看不到私聊层', g1.includes('不喜欢被打断'), false],
  ['群 910502749 看不到别群专属', g2.includes('追那部新番'), false],
  ['非主人私聊完全看不到', other, ''],
];
let fail = 0;
for (const [label, actual, expected] of checks) {
  const ok = actual === expected;
  if (!ok) fail += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`);
}
console.log(`\n=== ${checks.length - fail} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
