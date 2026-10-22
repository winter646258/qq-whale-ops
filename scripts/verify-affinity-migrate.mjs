// 好感度迁移验证 —— 在隔离副本 /tmp/afm 上真跑打补丁后的代码。
// 跑法：cd /tmp/afm && node verify-affinity-migrate.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/tmp/afm';
const SRC = fs.readFileSync(path.join(ROOT, 'src/bridge.js'), 'utf8');
const MOOD_SRC = fs.readFileSync(path.join(ROOT, 'src/mood-store.js'), 'utf8');
const STORE_SRC = fs.readFileSync(path.join(ROOT, 'src/affinity-store.js'), 'utf8');

function extractFn(source, name) {
  const re = new RegExp('\\n( *)function ' + name + '\\(');
  const m = re.exec(source);
  if (!m) throw new Error('找不到函数 ' + name);
  let i = source.indexOf('(', m.index);
  let d = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') d += 1;
    else if (c === ')') { d -= 1; if (!d) { i += 1; break; } }
  }
  let j = source.indexOf('{', i);
  let inStr = null;
  let prev = '';
  for (; j < source.length; j += 1) {
    const c = source[j];
    if (inStr) {
      if (c === inStr && prev !== '\\') inStr = null;
      prev = c;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; prev = c; continue; }
    if (c === '/' && source[j + 1] === '/') {
      const nl = source.indexOf('\n', j);
      j = nl < 0 ? source.length : nl;
      prev = '';
      continue;
    }
    if (c === '{') d += 1;
    else if (c === '}') { d -= 1; if (!d) return source.slice(m.index + 1, j + 1); }
    prev = c;
  }
  throw new Error('花括号不配平 ' + name);
}

// ── 1. 静态检查：mood-store 里全局 affinity 是否绝迹 ─────────────────────
console.log('═══ 静态：mood-store.js ═══');

function staticCheck(name, fn) {
  try { fn(); pass += 1; console.log(`  PASS ${name}`); }
  catch (e) { fail += 1; failures.push({ name, e }); console.log(`  FAIL ${name}\n       ${e.message}`); }
}
let pass = 0;
let fail = 0;
const failures = [];

staticCheck('normalizeState 不再读 o.affinity', () => {
  if (/o\.affinity/.test(MOOD_SRC)) throw new Error('还有 o.affinity');
});
staticCheck('返回值里没有 affinity 字段', () => {
  if (/^\s+affinity: \{/m.test(MOOD_SRC)) throw new Error('还有 affinity: {');
});
staticCheck('effectiveMood 不再带 affinity', () => {
  if (/affinity: \{ \.\.\.s\.affinity \}/.test(MOOD_SRC)) throw new Error('还在展开 s.affinity');
});
staticCheck('moodStats 不再报 affinityLevel', () => {
  if (/affinityLevel:/.test(MOOD_SRC)) throw new Error('还有 affinityLevel:');
});
staticCheck('setAffinity 已删除且有墓碑', () => {
  if (/export function setAffinity/.test(MOOD_SRC)) throw new Error('setAffinity 还在');
  if (!/MARKER: affinity-migrate-set/.test(MOOD_SRC)) throw new Error('墓碑不在');
});
staticCheck('bridge 不再 import setAffinity', () => {
  if (/resolveUndercurrent, setAffinity, setBaseline/.test(SRC)) throw new Error('还在 import');
});
staticCheck('bridge 不再读 store.affinity', () => {
  if (/store\.affinity/.test(SRC)) throw new Error('还在读 store.affinity');
});

// ── 2. 动态：真跑 mood-store ───────────────────────────────────────────
console.log('\n═══ 动态：真跑 mood-store.js ═══');
const M = await import(path.join(ROOT, 'src/mood-store.js'));

staticCheck('老文件里的 affinity 被 normalizeState 丢掉', () => {
  const legacy = {
    pad: { pleasure: 0.1, arousal: 0, dominance: 0.1 },
    label: '有点烦', reason: '被吵醒了',
    affinity: { level: 6, note: '群里那群人的评价', updatedAt: Date.now() }
  };
  const s = M.normalizeState(legacy, Date.now());
  if ('affinity' in s) throw new Error('normalizeState 还产出 affinity：' + JSON.stringify(s.affinity));
  if (s.label !== '有点烦') throw new Error('label 丢了');
});
staticCheck('moodStats 不再有 affinityLevel', () => {
  const st = M.moodStats(M.createDefaultMood(), Date.now());
  if ('affinityLevel' in st) throw new Error('还有 affinityLevel=' + st.affinityLevel);
  if ('hasNote' in st) throw new Error('还有 hasNote');
  if (!('label' in st)) throw new Error('label 不该丢');
});
staticCheck('effectiveMood 不再带 affinity', () => {
  const eff = M.effectiveMood(M.createDefaultMood(), Date.now());
  if ('affinity' in eff) throw new Error('还有 affinity');
});
staticCheck('setAffinity 确实不存在了', () => {
  if (typeof M.setAffinity === 'function') throw new Error('还能调用');
});
staticCheck('心情功能本身没坏（setMood 仍可用）', () => {
  const next = M.setMood(M.createDefaultMood(), { label: '挺高兴', reason: '主人回来了' });
  const view = M.describeMood(next, Date.now());
  if (!view.includes('挺高兴')) throw new Error('describeMood 没输出：' + view);
  console.log('       ' + view.replace(/\n/g, ' | '));
});

// ── 3. 动态：真跑 bridge 的 affinity 接线 ──────────────────────────────
console.log('\n═══ 动态：真跑 bridge.js 的 affinity 接线 ═══');

const storeCleaned = STORE_SRC.replace(/^export /gm, '').replace(/^import [^\n]*\n/gm, '');
const FNS = ['getAffinityState', 'saveAffinitySafe', 'affinityEntryFor', 'recordAffinityForKey', 'buildAffinityLineFor'];
const shim = [
  "import fs from 'node:fs';",
  "import path from 'node:path';",
  storeCleaned,
  'const setAffinityByKey = setAffinity;',
  "const STATE_DIR = '/tmp/afm/state';",
  'const LOG = [];',
  'function log(m) { LOG.push(String(m)); }',
  `const cfg = JSON.parse(fs.readFileSync('/tmp/afm/config.json', 'utf8'));`,
  "const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');",
  'let affinityCache = null;',
  ...FNS.map((n) => extractFn(SRC, n)),
  'export { getAffinityState, saveAffinitySafe, affinityEntryFor, recordAffinityForKey, buildAffinityLineFor, cfg, LOG };',
  'export function resetCache() { affinityCache = null; }',
  'export function writeFile(obj) { fs.writeFileSync(AFFINITY_FILE, JSON.stringify(obj, null, 2)); }',
  'export function readFileRaw() { return fs.readFileSync(AFFINITY_FILE, "utf8"); }'
].join('\n');
fs.writeFileSync(path.join(ROOT, 'shim.mjs'), shim);
const H = await import(path.join(ROOT, 'shim.mjs'));

const OWNER = 'private:1124721191';
const GROUP = 'group:906710082';
const FRIEND = 'private:3414115838';

staticCheck('主人读到自己那份', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  if (!out.includes('半夜折腾着')) throw new Error('读不到：' + out);
  if (!out.includes('主人')) throw new Error('该用「主人」：' + out);
});
staticCheck('群里读到群里那份，不串到主人', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(GROUP);
  if (!out.includes('这群人')) throw new Error('读不到群里那份：' + out);
  if (out.includes('半夜折腾着')) throw new Error('串台了：' + out);
  if (!out.includes('这个人')) throw new Error('群里该用「这个人」：' + out);
});
staticCheck('好友私聊读到空（没存过就是没有，不回退）', () => {
  H.resetCache();
  if (H.buildAffinityLineFor(FRIEND) !== '') throw new Error('不该有注入');
});
staticCheck('注入里没有数字', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(GROUP);
  if (/\d/.test(out)) throw new Error('出现数字：' + out);
});
staticCheck('写入只落到按会话表，不碰全局', () => {
  H.resetCache();
  H.recordAffinityForKey(FRIEND, { level: 7, note: '话不多但每次都认真回' });
  const file = JSON.parse(H.readFileRaw());
  if (file.affinities[FRIEND].level !== 7) throw new Error('没写进去');
  if (Object.keys(file).some((k) => ['affinity', 'level', 'note'].includes(k))) throw new Error('出现了全局字段');
  H.resetCache();
  if (!H.buildAffinityLineFor(FRIEND).includes('话不多')) throw new Error('写后读不到');
});
staticCheck('别人的写入不影响主人那份', () => {
  H.resetCache();
  H.recordAffinityForKey(GROUP, { level: 3, note: '这群人今天有点吵' });
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  if (!out.includes('半夜折腾着')) throw new Error('主人那份被改了：' + out);
});
staticCheck('文件损坏时拒绝写入（不用空表覆盖）', () => {
  fs.writeFileSync(path.join(ROOT, 'state/affinity.json'), '{坏掉的');
  H.resetCache();
  let threw = false;
  try { H.recordAffinityForKey(OWNER, { level: 5, note: '不该写进去' }); } catch { threw = true; }
  if (!threw) throw new Error('应该抛错');
  const raw = H.readFileRaw();
  if (raw !== '{坏掉的') throw new Error('坏文件被覆盖了：' + raw);
  console.log('       ' + H.LOG[H.LOG.length - 1]);
});
staticCheck('损坏后读也不注入（但不会崩）', () => {
  H.resetCache();
  if (H.buildAffinityLineFor(OWNER) !== '') throw new Error('不该注入');
});
staticCheck('修好文件后恢复正常', () => {
  H.writeFile({
    version: 1,
    affinities: {
      'private:1124721191': { level: 4, note: '修好之后依然是他', updatedAt: Date.now() }
    },
    nudgeAt: {}
  });
  H.resetCache();
  if (!H.buildAffinityLineFor(OWNER).includes('修好之后依然是他')) throw new Error('没恢复');
});

console.log(`\n合计：${pass} PASS / ${fail} FAIL`);
if (fail) {
  for (const f of failures) console.log(`\n✗ ${f.name}\n  ${f.e.message ?? f.e}`);
  process.exit(1);
}
