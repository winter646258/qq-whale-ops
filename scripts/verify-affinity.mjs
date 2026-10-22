// 好感度接线验证 —— 从打补丁后的 bridge.js 抽真函数，喂真数据跑。
// 跑法：cd /tmp/afv && node verify-affinity.mjs
import fs from 'node:fs';

const SRC = fs.readFileSync('/tmp/afv/bridge.js', 'utf8');

/** 按大括号配对抽函数体（先配平参数表再找函数体）。 */
function extractFn(source, name) {
  const defRe = new RegExp(`\\n( *)function ${name}\\(`);
  const m = defRe.exec(source);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const start = m.index + 1;
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  let j = source.indexOf('{', i);
  depth = 0;
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
      j = nl === -1 ? source.length : nl;
      prev = '';
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') { depth -= 1; if (depth === 0) return source.slice(start, j + 1); }
    prev = c;
  }
  throw new Error(`函数 ${name} 花括号不配平`);
}

const FNS = [
  'getAffinityState',
  'saveAffinitySafe',
  'affinityEntryFor',
  'recordAffinityForKey',
  'buildAffinityLineFor'
];
const parts = FNS.map((n) => ({ name: n, body: extractFn(SRC, n) }));

const STORE_SRC = fs.readFileSync('/tmp/afv/affinity-store.js', 'utf8')
  .replace(/^export /gm, '')
  .replace(/^import .*?;\s*$/gm, '');   // 剥掉 store 自己的 import，避免与 shim 重复声明

fs.mkdirSync('/tmp/afv/state', { recursive: true });
// 造一份老数据：全局 affinity level=4，但按会话表里只有主人那一条
const legacy = {
  affinities: {
    'private:1124721191': {
      level: 4,
      note: '半夜折腾着给我接生图、捏mc小人的那个，嘴上爱怼，活儿是真干',
      updatedAt: Date.now() - 1000
    }
  }
};
fs.writeFileSync('/tmp/afv/state/affinity.json', JSON.stringify(legacy, null, 2));

const shim = `
import fs from 'node:fs';
import path from 'node:path';

${STORE_SRC}
const setAffinityByKey = setAffinity;

const STATE_DIR = '/tmp/afv/state';
globalThis.__LOG = [];
function log(msg) { globalThis.__LOG.push(String(msg)); }
const cfg = JSON.parse(fs.readFileSync('/opt/qq-bridge/config.json', 'utf8'));
const AFFINITY_FILE = path.join(STATE_DIR, 'affinity.json');
let affinityCache = null;

${parts.map((p) => p.body).join('\n\n')}

export { getAffinityState, saveAffinitySafe, affinityEntryFor, recordAffinityForKey, buildAffinityLineFor, cfg };
export function resetCache() { affinityCache = null; }
export function readFile() { return JSON.parse(fs.readFileSync(AFFINITY_FILE, 'utf8')); }
export function writeFile(obj) { fs.writeFileSync(AFFINITY_FILE, JSON.stringify(obj, null, 2)); }
`;

fs.writeFileSync('/tmp/afv/harness.mjs', shim);
const H = await import('/tmp/afv/harness.mjs');

let pass = 0;
let fail = 0;
const failures = [];
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  PASS ${name}`);
  } catch (error) {
    fail += 1;
    failures.push({ name, error });
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assert failed'); }
// assert 是函数，挂不了 assert.equal；单独写一个。
assert.equal = (actual, expected, msg) => {
  if (actual !== expected) {
    throw new Error(`${msg || 'assert.equal 不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
};

const OWNER = 'private:1124721191';

console.log('═══ 注入 ═══');

t('主人私聊能读到注入行', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert(out.length > 0, `应为非空，实际 ${out.length}`);
  assert(out.includes('半夜折腾着给我接生图'), '缺少 note 原文');
  console.log('       ' + out.trim().replace(/\n/g, ' | '));
});

t('注入里没有任何数字（核心约束：不被数字框住）', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert(!/\d/.test(out), `不该出现数字：${out}`);
});

t('群会话读不到主人那份（不串台）', () => {
  H.resetCache();
  assert.equal(H.buildAffinityLineFor('group:906710082'), '');
  assert.equal(H.buildAffinityLineFor('group:910502749'), '');
});

t('好友私聊读不到（不串台）', () => {
  H.resetCache();
  assert.equal(H.buildAffinityLineFor('private:3414115838'), '');
});

t('没有 note 的会话不注入', () => {
  H.resetCache();
  H.writeFile({ affinities: { 'group:1': { level: 5, note: '', updatedAt: Date.now() } } });
  H.resetCache();
  assert.equal(H.buildAffinityLineFor('group:1'), '');
});

t('关掉开关就不注入', () => {
  H.resetCache();
  const old = H.cfg.socialV2?.affinity;
  H.cfg.socialV2 = H.cfg.socialV2 || {};
  H.cfg.socialV2.affinity = { enabled: false };
  const out = H.buildAffinityLineFor(OWNER);
  H.cfg.socialV2.affinity = old;
  assert.equal(out, '');
});

console.log('\n═══ 写入 ═══');

t('写入新会话生效', () => {
  H.resetCache();
  const entry = H.recordAffinityForKey('group:906710082', { level: 6, note: '这群人挺有意思' });
  assert.equal(entry.level, 6);
  assert.equal(entry.note, '这群人挺有意思');
  H.resetCache();
  const out = H.buildAffinityLineFor('group:906710082');
  assert(out.includes('这群人挺有意思'), `注入没生效：${out}`);
  console.log('       ' + out.trim().replace(/\n/g, ' | '));
});

t('写入已落盘（不是只在内存）', () => {
  H.resetCache();
  const saved = H.readFile();
  assert(saved.affinities['group:906710082'], '文件里没有');
  assert.equal(saved.affinities['group:906710082'].level, 6);
});

t('只改 note 不动 level', () => {
  H.resetCache();
  const entry = H.recordAffinityForKey('group:906710082', { note: '改了一句' });
  assert.equal(entry.level, 6);
  assert.equal(entry.note, '改了一句');
});

t('主人那份没被别人的写入影响', () => {
  // 每个用例自己铺前置：上面几条已经往文件里写过别的会话，不能假设还在。
  H.writeFile({
    affinities: {
      'private:1124721191': {
        level: 4,
        note: '半夜折腾着给我接生图、捏mc小人的那个，嘴上爱怼，活儿是真干',
        updatedAt: Date.now() - 1000
      },
      'group:906710082': { level: 6, note: '这群人挺有意思', updatedAt: Date.now() }
    }
  });
  H.resetCache();
  H.recordAffinityForKey('group:906710082', { level: 2, note: '改低了' });
  H.resetCache();
  const e = H.affinityEntryFor(OWNER);
  assert(e, '主人那份不该消失');
  assert.equal(e.level, 4);
  assert(e.note.includes('半夜折腾着'));
});

t('超范围写入被拒', () => {
  H.resetCache();
  let threw = false;
  try { H.recordAffinityForKey('group:1', { level: 99 }); } catch { threw = true; }
  assert(threw, '应该抛错');
});

console.log('\n═══ 提醒 ═══');

t('刚改过不提醒', () => {
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert(!out.includes('好感度'), `刚改过不该提醒：${out}`);
});

t('超过 14 天会提醒一次', () => {
  H.writeFile({
    affinities: {
      'private:1124721191': {
        level: 4,
        note: '很久以前写的评价',
        updatedAt: Date.now() - 20 * 24 * 3600 * 1000
      }
    }
  });
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert(out.includes('好感度'), `应该提醒：${out}`);
  assert(out.includes('qq_mood'), '提醒里该指向 qq_mood');
  console.log('       ' + out.trim().split('\n').pop());
});

t('提醒过一次后 7 天内不再念', () => {
  // 前置：一条 20 天前的评价 + 没有 nudgeAt（不能借上一个用例留下的状态）
  H.writeFile({
    affinities: {
      'private:1124721191': {
        level: 4,
        note: '很久以前写的评价',
        updatedAt: Date.now() - 20 * 24 * 3600 * 1000
      }
    }
  });
  H.resetCache();
  const first = H.buildAffinityLineFor(OWNER);
  H.resetCache();
  const second = H.buildAffinityLineFor(OWNER);
  assert(first.includes('好感度'), '第一次该提醒');
  assert(!second.includes('好感度'), `第二次不该提醒：${second}`);
});

t('提醒状态已落盘', () => {
  H.writeFile({
    affinities: {
      'private:1124721191': {
        level: 4,
        note: '很久以前写的评价',
        updatedAt: Date.now() - 20 * 24 * 3600 * 1000
      }
    }
  });
  H.resetCache();
  H.buildAffinityLineFor(OWNER);
  H.resetCache();
  const saved = H.readFile();
  assert(saved.nudgeAt?.[OWNER], 'nudgeAt 没落盘');
  console.log('       nudgeAt: ' + JSON.stringify(saved.nudgeAt));
});

console.log('\n═══ 健壮性 ═══');

t('文件损坏时不崩，只是不注入', () => {
  fs.writeFileSync('/tmp/afv/state/affinity.json', '{坏掉的');
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert.equal(out, '');
  console.log('       log: ' + (globalThis.__LOG[globalThis.__LOG.length - 1] ?? '(无)'));
});

t('恢复文件后正常', () => {
  H.writeFile({ affinities: { 'private:1124721191': { level: 5, note: '恢复了', updatedAt: Date.now() } } });
  H.resetCache();
  const out = H.buildAffinityLineFor(OWNER);
  assert(out.includes('恢复了'), `应恢复：${out}`);
});

console.log(`\n合计：${pass} PASS / ${fail} FAIL`);
if (fail) {
  for (const f of failures) console.log(`\n✗ ${f.name}\n  ${f.error?.message ?? f.error}`);
  process.exit(1);
}
