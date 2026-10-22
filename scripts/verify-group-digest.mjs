// 从打补丁后的 bridge.js 抽真实函数跑真数据 —— 不用 Proxy 万能桩
// （万能桩会把 `bounded is not defined` 这类真实作用域错误吞掉，上次栽过）。
//
// 跑法：cd /tmp/gdv && node verify-group-digest.mjs
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync('/tmp/gdv/bridge.js', 'utf8');

/** 按大括号配对抽函数体。必须先配平参数表 `()` 再找函数体 `{`。 */
function extractFn(source, name) {
  // 找 `function name(` 的定义位置
  const defRe = new RegExp(`\\n( *)function ${name}\\(`);
  const m = defRe.exec(source);
  if (!m) throw new Error(`找不到函数 ${name}`);
  const start = m.index + 1;
  // 先配平参数表
  let i = source.indexOf('(', start);
  let depth = 0;
  for (; i < source.length; i += 1) {
    const c = source[i];
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) {
        i += 1;
        break;
      }
    }
  }
  // 从参数表之后找第一个 `{`
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
    if (c === '"' || c === "'" || c === '`') {
      inStr = c;
      prev = c;
      continue;
    }
    if (c === '/' && source[j + 1] === '/') {
      // 跳过行注释
      const nl = source.indexOf('\n', j);
      j = nl === -1 ? source.length : nl;
      prev = '';
      continue;
    }
    if (c === '{') depth += 1;
    else if (c === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, j + 1);
    }
    prev = c;
  }
  throw new Error(`函数 ${name} 的花括号不配平`);
}

// ── 真实数据 ──────────────────────────────────────────────────────
const CFG = JSON.parse(fs.readFileSync('/opt/qq-bridge/config.json', 'utf8'));
const SOCIAL = JSON.parse(fs.readFileSync('/opt/qq-bridge/state/social-v2.json', 'utf8'));

const FNS = [
  'lastOwnerUtterance',
  'getSleepReviewState',
  'saveSleepReviewState',
  'buildGroupDigestLineFor',
  'buildSleepReviewLineFor'
];

const parts = FNS.map((n) => ({ name: n, body: extractFn(SRC, n) }));

const STORE_SRC = fs.readFileSync('/tmp/gdv/group-digest-store.js', 'utf8')
  .replace(/^export /gm, '');

const shim = `
import fs from 'node:fs';
import path from 'node:path';

${STORE_SRC}

const STATE_DIR = '/tmp/gdv/state';
let logLines = [];
function log(msg) { logLines.push(String(msg)); }
const cfg = ${JSON.stringify(CFG)};
const socialV2 = { conversations: new Map(Object.entries(${JSON.stringify(SOCIAL.conversations)})), paused: false };
function readJsonSafe(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}
const SLEEP_REVIEW_FILE = path.join(STATE_DIR, 'sleep-review.json');
let sleepReviewCache = null;

${parts.map((p) => p.body).join('\n\n')}

export {
  buildGroupDigestLineFor,
  buildSleepReviewLineFor,
  lastOwnerUtterance,
  getSocialV2State as _unused,
  socialV2, cfg, logLines, sleepReviewCache
};
export function getSocialV2State(key) {
  return socialV2.conversations.get(key) || null;
}
export function resetLog() { logLines = []; }
export function getLog() { return logLines; }
export function clearSleepReviewState() {
  sleepReviewCache = null;
  try { fs.unlinkSync(SLEEP_REVIEW_FILE); } catch {}
}
`;

fs.mkdirSync('/tmp/gdv/state', { recursive: true });
// getSocialV2State 必须在使用前定义 —— 用函数声明提升解决
fs.writeFileSync('/tmp/gdv/harness.mjs', shim.replace(
  '${parts.map((p) => p.body).join',
  '${parts.map((p) => p.body).join'
));

const H = await import('/tmp/gdv/harness.mjs');

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
function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assert failed');
}

const OWNER_KEY = `private:${CFG.ownerQQ}`;

console.log('═══ D：群聊近况 ═══');

t('主人私聊里问「群里刚才怎么样」→ 有注入', () => {
  const st = H.socialV2.conversations.get(OWNER_KEY);
  // 模拟：最后一条换成主人问群
  const backup = st.recentMessages.slice();
  st.recentMessages.push({
    sender: '管理员', text: '群里刚才在聊什么',
    plain: '群里刚才在聊什么', isOwner: true, isSelf: false, time: Date.now()
  });
  const out = H.buildGroupDigestLineFor(OWNER_KEY);
  st.recentMessages = backup;
  assert(out.length > 0, `应为非空，实际 ${out.length}`);
  assert(out.includes('【群里的近况】'), '缺少标题');
  console.log('       ' + out.split('\n').slice(0, 4).join('\n       '));
});

t('主人私聊里聊正事 → 不注入', () => {
  const st = H.socialV2.conversations.get(OWNER_KEY);
  const backup = st.recentMessages.slice();
  st.recentMessages.push({
    sender: '管理员', text: '这个 bug 怎么修',
    plain: '这个 bug 怎么修', isOwner: true, isSelf: false, time: Date.now()
  });
  const out = H.buildGroupDigestLineFor(OWNER_KEY);
  st.recentMessages = backup;
  assert(out === '', `应为空，实际 ${out.slice(0, 60)}`);
});

t('群里自己不注入群近况（她就在现场）', () => {
  const out = H.buildGroupDigestLineFor('group:906710082');
  assert(out === '', `应为空，实际 ${out.slice(0, 60)}`);
});

t('好友私聊不注入', () => {
  const out = H.buildGroupDigestLineFor('private:3414115838');
  assert(out === '', '应为空');
});

t('她自己的话不当成主人在问（isSelf 排除）', () => {
  const st = H.socialV2.conversations.get(OWNER_KEY);
  const backup = st.recentMessages.slice();
  st.recentMessages.push({
    sender: '我', text: '群里怎么样我也不太清楚',
    plain: '群里怎么样我也不太清楚', isOwner: true, isSelf: true, time: Date.now()
  });
  const before = H.lastOwnerUtterance(st);
  const out = H.buildGroupDigestLineFor(OWNER_KEY);
  st.recentMessages = backup;
  assert(before !== '群里怎么样我也不太清楚', `lastOwnerUtterance 返回了她自己的话：${before}`);
  assert(out === '', '她自己的话不该触发注入');
});

t('群里没人说话时不报错', () => {
  const out = H.buildGroupDigestLineFor('private:999999');
  assert(out === '', '应为空');
});

console.log('\n═══ 睡眠整合 ═══');

t('4 点前不注入', () => {
  H.clearSleepReviewState();
  const now = new Date();
  const h = now.getHours();
  if (h >= 4) {
    console.log('       （当前 ' + h + ' 点，跳过此用例）');
    return;
  }
  const out = H.buildSleepReviewLineFor(OWNER_KEY);
  assert(out === '', '4 点前不该注入');
});

t('4 点后有活动 → 注入', () => {
  H.clearSleepReviewState();
  const now = new Date();
  if (now.getHours() < 4) {
    console.log('       （当前 ' + now.getHours() + ' 点，跳过此用例）');
    return;
  }
  const out = H.buildSleepReviewLineFor(OWNER_KEY);
  assert(out.length > 0, `应为非空，实际 ${out.length}`);
  assert(out.includes('【今天过完了】'), '缺少标题');
  console.log('       ' + out.split('\n').slice(0, 5).join('\n       '));
});

t('同一天第二次不重复注入 + 落盘', () => {
  H.clearSleepReviewState();
  const now = new Date();
  if (now.getHours() < 4) {
    console.log('       （当前 ' + now.getHours() + ' 点，跳过此用例）');
    return;
  }
  const first = H.buildSleepReviewLineFor(OWNER_KEY);
  const second = H.buildSleepReviewLineFor(OWNER_KEY);
  assert(first.length > 0, '第一次应有');
  assert(second === '', `第二次应为空，实际 ${second.slice(0, 60)}`);
  const saved = JSON.parse(fs.readFileSync('/tmp/gdv/state/sleep-review.json', 'utf8'));
  assert(saved.reviewDays?.[OWNER_KEY], '没落盘');
  console.log('       落盘：' + JSON.stringify(saved.reviewDays));
});

t('关掉开关就不注入', () => {
  H.clearSleepReviewState();
  H.cfg.socialV2 = H.cfg.socialV2 || {};
  const old = H.cfg.socialV2.sleepReview;
  H.cfg.socialV2.sleepReview = { enabled: false };
  const out = H.buildSleepReviewLineFor(OWNER_KEY);
  H.cfg.socialV2.sleepReview = old;
  assert(out === '', '关掉后不该注入');
});

t('两个 key 各自记账', () => {
  H.clearSleepReviewState();
  const now = new Date();
  if (now.getHours() < 4) {
    console.log('       （当前 ' + now.getHours() + ' 点，跳过此用例）');
    return;
  }
  H.buildSleepReviewLineFor(OWNER_KEY);
  const other = H.buildSleepReviewLineFor('private:3414115838');
  console.log('       另一个 key 返回长度 ' + other.length + '（有活动则 >0）');
});

console.log(`\n合计：${pass} PASS / ${fail} FAIL`);
if (fail) process.exit(1);
