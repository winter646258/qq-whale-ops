// 真跑一遍 buildWakePromptV2，看注入行到底进没进最终 prompt。
//
// buildWakePromptV2 依赖十几个外部函数/对象（角色卡、心情、画像、日程、表情…），
// 逐个手写 stub 又多又脆。这里换一招：从部署文件抽出函数体，包进一个 `with`
// 块，用 Proxy 兜住所有未声明的自由标识符——返回一个「既能当函数调、又能当值用」
// 的万能桩。于是真正被测的只有一件事：拼装序列里 sharedMemoryLine 在不在。
//
// 必须跑在 sloppy 模式（.cjs），因为 ES 模块是严格模式，`with` 会被禁用。
const fs = require('node:fs');

const BRIDGE = process.env.BRIDGE || '/opt/qq-bridge/src/bridge.js';
const ROOT = process.env.QROOT || '/opt/qq-bridge';
const src = fs.readFileSync(BRIDGE, 'utf8');

function extractFn(text, name) {
  const re = new RegExp(`\\n  function ${name}\\s*\\(`);
  const m = re.exec(text);
  if (!m) throw new Error(`找不到函数 ${name}`);
  let i = text.indexOf('(', m.index + m[0].length - 1);
  let d = 0;
  let e = -1;
  for (; i < text.length; i += 1) {
    if (text[i] === '(') d += 1;
    else if (text[i] === ')') { d -= 1; if (d === 0) { e = i; break; } }
  }
  const b = text.indexOf('{', e);
  let dep = 0;
  for (let j = b; j < text.length; j += 1) {
    if (text[j] === '{') dep += 1;
    else if (text[j] === '}') { dep -= 1; if (dep === 0) return text.slice(m.index + 1, j + 1); }
  }
  throw new Error(`${name}: 大括号不配对`);
}

const fnSrc = extractFn(src, 'buildWakePromptV2');

// 万能桩：函数、对象、字符串语义都兼容，避免被 `now()` / `x.y` / `'a'+x` 任意一种用法搞崩。
function makeStub() {
  const fn = function () { return stub; };
  const stub = new Proxy(fn, {
    get(t, p) {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'toString') return () => '';
      if (p === Symbol.iterator) return function* () {};
      if (p === 'length') return 0;
      if (p === 'then') return undefined;
      return stub;
    },
    apply() { return stub; },
    construct() { return stub; }
  });
  return stub;
}
const stub = makeStub();

// 真实数据由宿主提供；其余一律走桩。
const realConfig = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const realSocial = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8'));
const sharedMem = JSON.parse(fs.readFileSync(`${ROOT}/state/shared-memory.json`, 'utf8'));

const storeMod = require(`${ROOT}/src/shared-memory-store.js`);

const env = {
  cfg: realConfig,
  socialV2: { conversations: new Map(Object.entries(realSocial.conversations)), paused: false },
  log: () => {},
  now: Date.now(),
  currentMode: 'reserved2',
  // 只把「注入链路」换成真的，其它保持桩：
  buildSharedMemoryLineFor(key) {
    const reader = /^group:(\d+)$/.test(key)
      ? storeMod.groupReader(RegExp.$1)
      : (key === `private:${realConfig.ownerQQ}` ? storeMod.ownerReader() : null);
    if (!reader) return '';
    const text = storeMod.formatForPrompt(sharedMem, {
      reader,
      max: storeMod.INJECT_MAX_ITEMS,
      maxChars: storeMod.INJECT_MAX_CHARS
    });
    return text ? `${text}\n\n` : '';
  },
  getSocialV2State(key) {
    const st = realSocial.conversations[key];
    return st ? { ...st } : { recentMessages: [], wakeConfig: {}, agentToken: 'tok' };
  }
};

const proxyEnv = new Proxy(env, {
  has() { return true; },
  get(t, p) {
    if (p in t) return t[p];
    if (p === Symbol.unscopables) return undefined;
    return stub;
  }
});

const factory = new Function('__env', `
  with (__env) {
    return (${fnSrc.replace(/^  function buildWakePromptV2/, 'function')});
  }
`);
const buildWakePromptV2 = factory(proxyEnv);

const cases = [
  ['private:1124721191', 'private'],
  ['group:906710082', 'private'],
  ['group:910502749', 'private']
];

let fail = 0;
for (const [key, reason] of cases) {
  let out;
  try {
    out = buildWakePromptV2(key, reason);
  } catch (err) {
    console.log(`FAIL ${key} 抛错: ${err.message}`);
    fail += 1;
    continue;
  }
  const hasHeader = out.includes('【你还记得的事】');
  const leakPrivate = out.includes('不喜欢被打断');
  const hasGroup = out.includes('追那部新番');
  console.log(`\n【${key}】prompt 长度 ${out.length}`);
  console.log('  含【你还记得的事】:', hasHeader);
  console.log('  含本群内容        :', hasGroup);
  console.log('  泄漏私聊层        :', leakPrivate);
  const idx = out.indexOf('【你还记得的事】');
  if (idx >= 0) {
    console.log('  注入片段:', JSON.stringify(out.slice(idx, idx + 90)));
  }
  if (key === 'private:1124721191') {
    // 主人私聊本来就该同时看到 owner_private 层和 shared 层（访问矩阵：
    // 主人读 shared + owner_private）。真正要防的是反方向——群里不能看到
    // 主人专属。这里原本写成「私聊也不能有群内容」，
    // 把隔离当成了双向都断，是测试写错了。
    if (!hasHeader || !out.includes('不喜欢被打断') || !hasGroup) { console.log('  FAIL 私聊注入不对'); fail += 1; }
  } else if (key === 'group:906710082') {
    if (!hasHeader || !hasGroup || leakPrivate) { console.log('  FAIL 群注入不对'); fail += 1; }
  } else if (key === 'group:910502749') {
    if (hasHeader || leakPrivate || hasGroup) { console.log('  FAIL 无关群不应有注入'); fail += 1; }
  }
}

console.log(`\n=== ${fail === 0 ? '全部通过' : fail + ' 项失败'} ===`);
process.exit(fail === 0 ? 0 : 1);
