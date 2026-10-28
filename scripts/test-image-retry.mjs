// 生图「画失败了：terminated」的回归守卫。
// 为什么要有这个用例：2026-10-28 18:19 上游在 38 秒把连接掐了，undici 抛的 message 只有
// 一个词 `terminated`，她只能原样转告主人。修法是「只对网络层断连重试一次，其它一律不重试」——
// 这条边界很容易在后续改动中被抹平（比如有人顺手把所有错误都重试一遍），所以钉在测试里。
//
// 做法：从 src/bridge.js 里把 `MARKER: image-retry-once` 到 `async function generateImageNow`
// 之间的那段抠出来，用 vm 在沙箱里执行（不真发请求、不真等 3 秒），然后对行为逐条断言。

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'src/bridge.js'), 'utf8');

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`);
  }
}

// ---------- 静态检查：这段代码确实在，而且接线对 ----------
console.log('[静态]');
ok('MARKER image-retry-once 恰好一处', src.split('// MARKER: image-retry-once').length - 1 === 1);
ok('模块注入走 generateImageWithRetry', src.includes('generateImageNow: (opts) => generateImageWithRetry(opts),'));
ok(
  '审批路径走 generateImageWithRetry',
  src.includes('await generateImageWithRetry({ prompt: approval.prompt, size: approval.size || undefined })'),
);
ok('重试前有 3 秒等待', /setTimeout\(resolve, 3000\)/.test(src));
ok('二次失败文案带「已重试一次」', src.includes('（已重试一次）'));

// ---------- 抠出包装层，放进沙箱 ----------
const start = src.indexOf('// MARKER: image-retry-once');
const end = src.indexOf('async function generateImageNow({ prompt, size }) {', start);
if (start < 0 || end < 0) {
  console.error('找不到包装层，测试无法继续');
  process.exit(1);
}
const block = src.slice(start, end);

function harness(impl) {
  const logs = [];
  const sandbox = {
    // 沙箱里 setTimeout 立刻执行，测试不用真等 3 秒；unref 要存在，源码里调了它
    setTimeout: (fn) => {
      fn();
      return { unref() {} };
    },
    log: (m) => logs.push(String(m)),
    generateImageNow: impl,
  };
  vm.createContext(sandbox);
  vm.runInContext(`${block}\n;__wrap = generateImageWithRetry;__desc = describeImageError;__re = IMAGE_RETRYABLE_RE;`, sandbox);
  return sandbox;
}

// ---------- 可重试的错误分类 ----------
console.log('[分类]');
const box = harness(async () => ({}));
for (const text of ['terminated', 'TypeError: terminated', 'ECONNRESET', 'socket hang up', 'other side closed', 'fetch failed', 'UND_ERR_SOCKET', 'EPIPE', 'ETIMEDOUT']) {
  ok(`可重试：${text}`, box.__re.test(text));
}
for (const text of ['上游 500：internal error', '上游 180 秒没画完', '上游返回的不是 JSON', '上游没有返回图片', '没有配置生图 apiKey']) {
  ok(`不重试：${text}`, !box.__re.test(text));
}

// ---------- describeImageError ----------
console.log('[报错文案]');
const e1 = new TypeError('terminated');
e1.cause = { code: 'UND_ERR_SOCKET' };
ok('带 cause.code 时一起报出来', box.__desc(e1) === 'terminated（TypeError/UND_ERR_SOCKET）', box.__desc(e1));
const e2 = new Error('boom');
ok('没有 code 时只报 name', box.__desc(e2) === 'boom（Error）', box.__desc(e2));

// ---------- 行为：断连重试一次 ----------
console.log('[行为]');
{
  const calls = [];
  const h = harness(async (args) => {
    calls.push(args);
    if (calls.length === 1) {
      const err = new TypeError('terminated');
      err.cause = { code: 'UND_ERR_SOCKET' };
      throw err;
    }
    return { path: '/tmp/x.png', size: '1024x1024' };
  });
  const result = await h.__wrap({ prompt: '海边' });
  ok('断连后重试一次', calls.length === 2, `实际 ${calls.length} 次`);
  ok('重试成功返回结果', result?.path === '/tmp/x.png');
  ok('重试拿到同样的参数', calls[1]?.prompt === '海边');
}
{
  // 日志断言单独跑一遍，方便看清楚
  const logs = [];
  const sandbox = {
    setTimeout: (fn) => { fn(); return { unref() {} }; },
    log: (m) => logs.push(String(m)),
    generateImageNow: async () => { throw new TypeError('terminated'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(`${block}\n;__wrap = generateImageWithRetry;`, sandbox);
  let caught = '';
  try {
    await sandbox.__wrap({ prompt: 'p' });
  } catch (error) {
    caught = String(error?.message || error);
  }
  ok('两次都断连 → 抛「已重试一次」', caught.includes('terminated') && caught.includes('已重试一次'), caught);
  ok('重试前打了一条日志', logs.some((m) => m.includes('上游连接被掐断')), JSON.stringify(logs));
  ok('二次失败的日志不会再重试', logs.filter((m) => m.includes('重试一次：')).length === 1, JSON.stringify(logs));
}
{
  const calls = [];
  const h = harness(async () => {
    calls.push(1);
    throw new Error('上游 500：internal error');
  });
  let caught = '';
  try {
    await h.__wrap({ prompt: 'p' });
  } catch (error) {
    caught = String(error?.message || error);
  }
  ok('4xx/5xx 不重试', calls.length === 1, `实际 ${calls.length} 次`);
  ok('4xx/5xx 原文带出来', caught.includes('上游 500'), caught);
}
{
  const calls = [];
  const h = harness(async () => {
    calls.push(1);
    throw new Error('上游 180 秒没画完');
  });
  let caught = '';
  try {
    await h.__wrap({ prompt: 'p' });
  } catch (error) {
    caught = String(error?.message || error);
  }
  ok('超时不重试（时间已经烧掉了）', calls.length === 1, `实际 ${calls.length} 次`);
  ok('超时文案不被加料', !caught.includes('已重试一次'), caught);
}

console.log(`\n通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
