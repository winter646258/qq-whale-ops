// 真跑一遍 buildWakePromptV2(key, 'share')，看主动报告的唤醒文案到底长什么样。
//
// 和 verify-wake-prompt-inject.cjs 同一招：抽出函数体塞进 `with` 块，用 Proxy
// 兜住所有未声明的自由标识符。真正被测的只有 share 那个分支：摘要进没进、
// valence 有没有改语气、来源群写没写对、没投递记录时不炸。
//
// 必须跑在 sloppy 模式（.cjs）：ES 模块是严格模式，`with` 会被禁用。
const fs = require('node:fs');

const BRIDGE = process.env.BRIDGE || '/tmp/ssv/bridge.js';
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

const realConfig = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const realSocial = JSON.parse(fs.readFileSync(`${ROOT}/state/social-v2.json`, 'utf8'));

let pass = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`PASS ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }

// shareLastDeliveryInfo 由本脚本直接喂，不受状态文件影响。
function buildWith(delivery) {
  const env = {
    cfg: realConfig,
    socialV2: { conversations: new Map(Object.entries(realSocial.conversations)), paused: false },
    log: () => {},
    now: Date.now(),
    currentMode: 'reserved2',
    shareLastDeliveryInfo: () => delivery,
    buildSharedMemoryLineFor: () => '',
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
  return factory(proxyEnv);
}

const OWNER = `private:${realConfig.ownerQQ}`;

t('share 分支：摘要、来源群、主动口吻都在', () => {
  const build = buildWith({
    summary: '群里为一部新番吵起来了，两边都挺认真',
    sourceGroup: 'group:906710082',
    valence: 0,
    at: Date.now()
  });
  const out = build(OWNER, 'share');
  assert(out.includes('【跟主人说一声】'), '缺标题');
  assert(out.includes('群里为一部新番吵起来了'), '摘要没进 prompt');
  assert(out.includes('group:906710082'), '来源群没写');
  assert(out.includes('你主动开口'), '缺「主动开口」的口吻约束');
  assert(out.includes('qq_mark_read'), '缺收尾方式');
  console.log('    长度 ' + out.length);
});

t('valence 为负 → 提醒语气可以低落', () => {
  const build = buildWith({ summary: 'x', sourceGroup: 'group:1', valence: -0.8, at: Date.now() });
  const out = build(OWNER, 'share');
  assert(out.includes('不太妙') && out.includes('低落'), '负向没给语气提示');
});

t('valence 为正 → 提醒语气可以高兴', () => {
  const build = buildWith({ summary: 'x', sourceGroup: 'group:1', valence: 0.9, at: Date.now() });
  const out = build(OWNER, 'share');
  assert(out.includes('挺好') && out.includes('高兴'), '正向没给语气提示');
});

t('valence 接近 0 → 不硬塞语气提示', () => {
  const build = buildWith({ summary: 'x', sourceGroup: 'group:1', valence: 0.1, at: Date.now() });
  const out = build(OWNER, 'share');
  assert(!out.includes('低落') && !out.includes('高兴'), '中性不该带语气提示');
});

t('没有投递记录（已过期）→ 不炸，给出可读的占位', () => {
  const build = buildWith(null);
  const out = build(OWNER, 'share');
  assert(out.includes('【跟主人说一声】'), '缺标题');
  assert(out.includes('已经过期'), '应说明信号过期');
});

t('share 分支不吞别的 reason（poke 仍在）', () => {
  const build = buildWith({ summary: 'x', sourceGroup: 'group:1', valence: 0 });
  const out = build(OWNER, 'poke');
  assert(out.includes('拍了一拍'), 'poke 分支被 share 挡住了');
});

// 回归：曾经有个版本把 share 分支插进了 `if (reason === 'poke') {` 里面
// （锚点行被复制了两份 → 多套一层 if），于是所有非 poke 的 reason 都返回
// undefined。node --check 查不出来，靠这条守住。
t('回归：其它 reason 的 prompt 没被 share 分支吞掉', () => {
  const build = buildWith(null);
  const cases = [
    ['private', '私聊里给你发消息'],
    ['atMention', '@ 了你'],
    ['question', '【唤醒】'],
    ['bootstrap', '【引导唤醒】'],
    ['timeout', '有限潜水时间已到'],
    ['replyCheck', '【回复检查】']
  ];
  for (const [reason, must] of cases) {
    const out = build(OWNER, reason);
    assert(typeof out === 'string' && out.length > 200, `${reason} 返回了空/过短的 prompt（长度 ${out && out.length}）`);
    assert(out.includes(must), `${reason} 的文案不对，缺「${must}」`);
  }
});

t('share 文案里没有群聊口吻的残留（不让她对着主人说「大家」）', () => {
  const build = buildWith({ summary: 'x', sourceGroup: 'group:1', valence: 0 });
  const out = build(OWNER, 'share');
  assert(!out.includes('主动冒泡'), '串到群聊版文案了');
  assert(!out.includes('群里已经安静'), '串到群聊版文案了');
});

console.log(`\n=== ${pass} PASS / ${fail} FAIL ===`);
process.exit(fail === 0 ? 0 : 1);
