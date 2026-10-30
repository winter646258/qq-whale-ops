// scripts/test-slim.mjs —— 2026-10-30 三小项减负的回归断言
//
// 为什么要有这个测试：减负改的是「常驻提示词」，改错了不会报错，只会在
// 某天发现她不再发表情、或者不认识群里的梗。所以把「省的字符数」和
// 「必须还在的关键约束」都写成断言，以后谁再动这两段都得先过这里。
//
// 跑法：node scripts/test-slim.mjs
import assert from 'node:assert';
import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
const { buildStickerStrategyHint, buildStickerContext } = await import(`${ROOT}src/sticker-lib.js`);
const { buildSlangContext } = await import(`${ROOT}src/slang-learner.js`);

let pass = 0;
let fail = 0;
function ok(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`✗ ${name}\n    ${error?.message ?? error}`);
  }
}

// ---------- 一、表情策略 ----------
const hint = buildStickerStrategyHint();

ok('表情策略压到 350 字符以内', () => {
  assert.ok(hint.length <= 350, `实际 ${hint.length} 字符，超过 350`);
});

ok('表情策略保留了「什么场合」', () => {
  assert.match(hint, /自嘲/);
  assert.match(hint, /接梗|被怼/);
});

ok('表情策略保留了「频率」', () => {
  assert.match(hint, /3~5 轮|频率/);
});

ok('表情策略保留了「单独发一条，不能和文字挤同一气泡」', () => {
  assert.match(hint, /qq_send_sticker/);
  assert.match(hint, /同一个气泡|单独发/);
});

ok('表情策略保留了「失败别重试」', () => {
  assert.match(hint, /别重试|直接跳过/);
});

ok('表情策略保留了「从群里学表情」', () => {
  assert.match(hint, /qq_collect_sticker/);
  assert.match(hint, /qq_sticker_note/);
});

ok('表情策略不再提已删的冗长细则', () => {
  // 这几条是原文里能被上面四条推出的，删掉是为了省字；
  // 如果哪天又被加回来，说明有人没看这段注释
  assert.doesNotMatch(hint, /不要每次都用同一个/);
  assert.doesNotMatch(hint, /一条消息里塞多个表情/);
});

// ---------- 二、黑话表 ----------
const slangRaw = JSON.parse(fs.readFileSync(`${ROOT}state/slang.json`, 'utf8'));
const slangEntries = Array.isArray(slangRaw) ? slangRaw : (slangRaw.entries || []);

ok('黑话表：12 条一条不少', () => {
  const out = buildSlangContext(slangEntries, 12, 'group:201188739');
  const lines = out.split('\n').slice(1);
  assert.equal(lines.length, 12);
});

ok('黑话表：单条不超过 130 字符', () => {
  const out = buildSlangContext(slangEntries, 12, 'group:201188739');
  for (const line of out.split('\n').slice(1)) {
    assert.ok(line.length <= 130, `超长 ${line.length}：${line.slice(0, 40)}`);
  }
});

ok('黑话表：长释义被截断并带省略号', () => {
  const out = buildSlangContext(slangEntries, 12, 'group:201188739');
  assert.match(out, /…/, '应该至少有一条被截断');
});

ok('黑话表：截断只影响长条，短条原样保留', () => {
  const out = buildSlangContext(slangEntries, 12, 'group:906710082');
  for (const line of out.split('\n').slice(1)) {
    assert.ok(!line.includes('……'), '不该出现双省略号');
  }
});

ok('黑话表：词条本身不被截断', () => {
  const out = buildSlangContext(slangEntries, 12, 'group:201188739');
  assert.match(out, /- 大肥鱼：/, '词头必须完整');
});

ok('黑话表：教学过的词仍排最前', () => {
  const taught = [{ id: 't1', content: '测试梗', meaning: '测试释义', status: 'confirmed', source: 'taught', count: 0, evidence: [] }];
  const out = buildSlangContext(taught, 12, 'group:x');
  assert.match(out, /测试梗/);
});

// ---------- 三、【积极性】已删 ----------
ok('bridge.js 里 proactiveLine 是空串（积极性已删）', () => {
  const src = fs.readFileSync(`${ROOT}src/bridge.js`, 'utf8');
  assert.match(src, /MARKER: no-proactive-line/);
  assert.match(src, /const proactiveLine = '';/);
  assert.doesNotMatch(src, /【积极性】/, '旧的 75 字文案应该已经删掉');
});

ok('bridge.js 里 proactiveLine 仍被拼进 base（不留悬空变量）', () => {
  const src = fs.readFileSync(`${ROOT}src/bridge.js`, 'utf8');
  assert.match(src, /\+ proactiveLine \+/);
});

// ---------- 四、总账 ----------
ok('三小项合计省下 900 字符以上', () => {
  const stickerNow = hint.length;
  const slangNow = buildSlangContext(slangEntries, 12, 'group:201188739').length;
  const saved = (918 - stickerNow) + (1621 - slangNow) + 75;
  assert.ok(saved >= 900, `实际只省了 ${saved}`);
});

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
if (fail) process.exit(1);