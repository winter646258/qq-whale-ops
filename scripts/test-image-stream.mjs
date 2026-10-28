// 生图流式读取的回归守卫。
//
// 背景（2026-10-28 18:19）：非流式时上游整张图画完之前连接上一个字节都没有，
// 中间层在 35~40 秒把空闲连接掐掉，undici 抛 `terminated`。改成 `stream: true` 之后
// 上游会周期性吐 `progress_text` 心跳 —— 这个用例把「怎么从流里认出图」和
// 「静默多久算卡死」钉死，免得以后有人顺手把解析改坏。

import { IMAGE_STREAM_DEFAULTS, parseSseImage, readImageStream } from '../src/image-stream.js';

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

function throws(name, fn, matcher) {
  let caught = null;
  try {
    const out = fn();
    if (out && typeof out.catch === 'function') {
      return out.then(
        () => { fail += 1; console.log(`  ✗ ${name}（没有抛错）`); },
        (error) => {
          const text = String(error?.message || error);
          if (matcher.test(text)) { pass += 1; console.log(`  ✓ ${name}`); }
          else { fail += 1; console.log(`  ✗ ${name} — 错误文案不符：${text}`); }
        },
      );
    }
  } catch (error) {
    caught = error;
  }
  const text = String(caught?.message || caught);
  if (caught && matcher.test(text)) { pass += 1; console.log(`  ✓ ${name}`); }
  else { fail += 1; console.log(`  ✗ ${name} — ${text || '没有抛错'}`); }
  return Promise.resolve();
}

const B64 = 'iVBORw0KGgoAAAANSUhEUg' + 'A'.repeat(60);

// ---------- 解析：中转自己的形状 ----------
console.log('[解析 · 中转形状]');
{
  const text = [
    ': stream-open',
    '',
    'data: {"object":"image.generation.chunk","created":1793183138,"model":"gpt-image-2","index":1,"total":1,"progress_text":"","data":[]}',
    '',
    'data: {"object":"image.generation.chunk","progress_text":"正在构图","data":[]}',
    '',
    `data: {"object":"image.generation.result","data":[{"b64_json":"${B64}","url":"https://images.example/x.png"}]}`,
    '',
    'data: [DONE]',
    '',
  ].join('\n');
  const got = parseSseImage(text);
  ok('拿到 b64', got.b64 === B64);
  ok('拿到 url', got.url === 'https://images.example/x.png');
  ok('进度只留非空的', got.progress.length === 1 && got.progress[0] === '正在构图', JSON.stringify(got.progress));
  ok('空进度不占位', !got.progress.includes(''));
}

// ---------- 解析：OpenAI 原生事件 ----------
console.log('[解析 · OpenAI 原生]');
{
  const text = [
    `data: {"type":"image_generation.partial_image","partial_image_index":0,"b64_json":"${B64}"}`,
    `data: {"type":"image_generation.completed","b64_json":"${B64}","revised_prompt":"一只鲸鱼"}`,
  ].join('\n');
  const got = parseSseImage(text);
  ok('从 b64_json 字段认图', got.b64 === B64);
}

// ---------- 解析：整段就是一个 JSON（非流式老形状） ----------
console.log('[解析 · 整体 JSON]');
{
  const text = JSON.stringify({ data: [{ b64_json: B64, revised_prompt: 'x' }] });
  ok('整体 JSON 也能认', parseSseImage(text).b64 === B64);
  ok('只有 url 也能认', parseSseImage(JSON.stringify({ data: [{ url: 'https://a/b.png' }] })).url === 'https://a/b.png');
  ok('空文本不炸', parseSseImage('').b64 === '' && parseSseImage('').url === '');
  ok('null 不炸', parseSseImage(null).b64 === '');
  ok('半块 JSON 不炸', parseSseImage('data: {"object":"image.generation.chunk","progress_').progress.length === 0);
  ok('纯注释行不炸', parseSseImage(': stream-open\n\nevent: ping\n\n').b64 === '');
}

// ---------- 读流 ----------
function fakeBody(chunks, { delayMs = 0 } = {}) {
  let i = 0;
  const encoder = new TextEncoder();
  return {
    getReader() {
      return {
        read: async () => {
          if (i >= chunks.length) return { done: true, value: undefined };
          const value = encoder.encode(chunks[i]);
          i += 1;
          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
          return { done: false, value };
        },
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
  };
}

console.log('[读流 · 正常]');
{
  const progress = [];
  const body = fakeBody([
    'data: {"object":"image.generation.chunk","progress_text":"排队中","data":[]}\n\n',
    'data: {"object":"image.generation.chunk","progress_text":"画一半","data":[]}\n\n',
    `data: {"object":"image.generation.result","data":[{"b64_json":"${B64}","url":"https://x/y.png"}]}\n\n`,
  ]);
  const got = await readImageStream(body, {
    onProgress: (text, ms) => progress.push([text, ms]),
  });
  ok('拿到 b64', got.b64 === B64);
  ok('拿到 url', got.url === 'https://x/y.png');
  ok('进度回调两条', progress.length === 2, JSON.stringify(progress));
  ok('块数统计对', got.chunks === 3, String(got.chunks));
  ok('字节数 > 0', got.bytes > 0);
}

console.log('[读流 · 半个 JSON 跨块]');
{
  const full = `data: {"object":"image.generation.result","data":[{"b64_json":"${B64}"}]}\n\n`;
  const cut = Math.floor(full.length / 2);
  const body = fakeBody([full.slice(0, cut), full.slice(cut)]);
  const got = await readImageStream(body);
  ok('跨块也能拼出图', got.b64 === B64);
}

console.log('[读流 · 异常]');
await throws('流里没有图 → 报错', () => readImageStream(fakeBody(['data: {"object":"image.generation.chunk","progress_text":"画","data":[]}\n\n'])), /没有图/);
await throws('没有 body → 报错', () => readImageStream(null), /可读的流/);
await throws('流太大 → 报错', () => readImageStream(fakeBody(['x'.repeat(200), 'y'.repeat(200)]), { maxBytes: 300 }), /流太大/);

console.log('[读流 · 卡住]');
{
  let aborted = false;
  const stalled = {
    getReader() {
      return {
        read: () => new Promise(() => {}), // 永远不返回
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
  };
  const startedAt = Date.now();
  let caught = '';
  // 这几个定时器源码里都 unref 了（生产里 bridge 有 HTTP server 撑着，不会空转）；
  // 单独跑用例时事件循环会被抽干，所以用一个 ref 的 interval 顶住。
  const keepAlive = setInterval(() => {}, 20);
  try {
    await readImageStream(stalled, { stallAbortMs: 60, abort: () => { aborted = true; } });
  } catch (error) {
    caught = String(error?.message || error);
  } finally {
    clearInterval(keepAlive);
  }
  const cost = Date.now() - startedAt;
  ok('静默超时报 stall', /没有吐任何字节/.test(caught), caught);
  ok('stall 会 abort 掉连接', aborted === true);
  ok('不会等到天荒地老', cost >= 50 && cost < 2000, `${cost}ms`);
}

console.log('[读流 · 卡住但明确允许继续等]');
{
  // stallAbortMs=0 的语义：只记日志，绝不因为静默而中止。
  // 这条很重要 —— 实测这条中转是「攒完再吐」，响应头 22 秒才到、之后 1 秒全到，
  // 静默≠连接坏。要是默认 60 秒就掐，70 秒才画完的图会被白杀。
  let aborted = false;
  const stalled = {
    getReader() {
      return {
        read: () => new Promise(() => {}),
        cancel: async () => {},
        releaseLock: () => {},
      };
    },
  };
  const keepAlive = setInterval(() => {}, 20);
  const running = readImageStream(stalled, { stallAbortMs: 0, abort: () => { aborted = true; } });
  const settled = await Promise.race([
    running.then(() => 'settled').catch(() => 'settled'),
    new Promise((resolve) => setTimeout(() => resolve('pending'), 250)),
  ]);
  clearInterval(keepAlive);
  ok('显式 0 时不会因静默中止', settled === 'pending', settled);
  ok('显式 0 时也不会 abort 连接', aborted === false);
}

console.log(`\n默认值：maxBytes=${IMAGE_STREAM_DEFAULTS.maxBytes} stallLogMs=${IMAGE_STREAM_DEFAULTS.stallLogMs} stallAbortMs=${IMAGE_STREAM_DEFAULTS.stallAbortMs}`);
ok('默认 stallAbortMs 是 0（静默只记账不中止）', IMAGE_STREAM_DEFAULTS.stallAbortMs === 0, String(IMAGE_STREAM_DEFAULTS.stallAbortMs));
console.log(`通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
