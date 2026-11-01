// Breeze TTS 单测：纯函数 + 请求体形状 + 错误翻译。
// 不发真实请求（那由 scripts/probe-breeze-live.mjs 负责），这样调参数时不会烧额度。
import assert from 'node:assert/strict';
import {
  BREEZE_DEFAULTS, BREEZE_VOICES, TTS_DEFAULTS, TTS_VOICES,
  buildBreezeBody, buildTtsBody, describeBreezeError, describeTtsHttpError,
  pickBreezeVoice, pickVoice, splitSpeechText, synthesize, synthesizeBreeze
} from '../src/tts.js';

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass += 1; } catch (e) { fail += 1; console.log(`✗ ${name}\n  ${e?.message ?? e}`); }
}
async function ta(name, fn) {
  try { await fn(); pass += 1; } catch (e) { fail += 1; console.log(`✗ ${name}\n  ${e?.message ?? e}`); }
}

// ── 音色归一 ────────────────────────────────────────────────────────────────
t('dashscope 音色大小写不敏感', () => {
  assert.equal(pickVoice('cherry'), 'Cherry');
  assert.equal(pickVoice('SERENA'), 'Serena');
});
t('dashscope 认不出的音色回落默认，不报错', () => {
  assert.equal(pickVoice('不存在的声音'), TTS_DEFAULTS.voice);
  assert.equal(pickVoice(''), TTS_DEFAULTS.voice);
  assert.equal(pickVoice(null), TTS_DEFAULTS.voice);
});
t('breeze 认 id', () => {
  assert.equal(pickBreezeVoice('voc_8yud7hz7c9q2'), 'voc_8yud7hz7c9q2');
});
t('breeze 认中文名', () => {
  assert.equal(pickBreezeVoice('大肥鱼（迷糊版）'), 'voc_8yud7hz7c9q2');
  assert.equal(pickBreezeVoice('哈基米娘'), 'voc_rh6e8hdbraz6');
});
t('breeze 认不出的 voc_ 前缀原样放行（新音色不用改代码）', () => {
  assert.equal(pickBreezeVoice('voc_brandnew123'), 'voc_brandnew123');
});
t('breeze 完全不认识的回落默认', () => {
  assert.equal(pickBreezeVoice('随便一个名字'), BREEZE_DEFAULTS.voice);
});
t('breeze 音色表五个都在，且 id 都是 voc_ 前缀', () => {
  assert.equal(BREEZE_VOICES.length, 5);
  for (const v of BREEZE_VOICES) {
    assert.ok(v.id.startsWith('voc_'), v.id);
    assert.ok(v.name.length > 0);
  }
});

// ── 请求体 ──────────────────────────────────────────────────────────────────
t('breeze 最小请求体只要 text', () => {
  const b = buildBreezeBody('你好');
  assert.equal(b.text, '你好');
  assert.equal(b.model_id, 'breeze-tts-2');
  assert.equal(b.language_code, 'zh');
  assert.equal(b.instructions, undefined, '没传 tone 就不该出现 instructions');
  assert.equal(b.voice_settings, undefined, '没传参数就不该出现 voice_settings');
});
t('breeze tone 原样进 instructions 并去首尾空白', () => {
  const b = buildBreezeBody('哼', { instructions: '  用撒娇的语气  ' });
  assert.equal(b.instructions, '用撒娇的语气');
});
t('breeze tone 只有空白等于没有', () => {
  const b = buildBreezeBody('哼', { instructions: '   ' });
  assert.equal(b.instructions, undefined);
});
t('breeze speed / guidanceScale 只在合法区间才写', () => {
  assert.deepEqual(buildBreezeBody('x', { speed: 1.5 }).voice_settings, { speed: 1.5 });
  assert.equal(buildBreezeBody('x', { speed: 3 }).voice_settings, undefined, '超上限要丢');
  assert.equal(buildBreezeBody('x', { speed: 0.1 }).voice_settings, undefined, '超下限要丢');
  assert.deepEqual(buildBreezeBody('x', { guidanceScale: 4 }).voice_settings, { guidance_scale: 4 });
  assert.equal(buildBreezeBody('x', { guidanceScale: 0 }).voice_settings, undefined);
  assert.equal(buildBreezeBody('x', { guidanceScale: 11 }).voice_settings, undefined);
});
t('breeze speed 与 guidance 同时给，两个都在', () => {
  const b = buildBreezeBody('x', { speed: 0.8, guidanceScale: 2 });
  assert.deepEqual(b.voice_settings, { guidance_scale: 2, speed: 0.8 });
});
t('dashscope 请求体形状没被改坏', () => {
  const b = buildTtsBody('你好', {});
  assert.equal(b.model, 'qwen3-tts-flash');
  assert.deepEqual(b.input, { text: '你好', voice: 'Cherry', language_type: 'Chinese' });
});

// ── 切段 ────────────────────────────────────────────────────────────────────
t('短文本不切', () => {
  assert.deepEqual(splitSpeechText('你好', 600), ['你好']);
});
t('长文本按句末切，每段不超限', () => {
  const src = ('今天天气很好。').repeat(50); // 350 字
  const segs = splitSpeechText(src, 100);
  assert.ok(segs.length > 1);
  for (const s of segs) assert.ok(s.length <= 100, `段长 ${s.length} 超了`);
  assert.equal(segs.join(''), src.replace(/\s+/g, ' ').trim());
});
t('没有标点时硬切也保证不超限', () => {
  const src = 'a'.repeat(300);
  const segs = splitSpeechText(src, 100);
  for (const s of segs) assert.ok(s.length <= 100);
  assert.equal(segs.join(''), src);
});
t('空文本返回空数组', () => {
  assert.deepEqual(splitSpeechText(''), []);
  assert.deepEqual(splitSpeechText('   '), []);
});

// ── 错误翻译 ────────────────────────────────────────────────────────────────
t('breeze 401 提到 key', () => {
  const m = describeBreezeError(401, '{"detail":"invalid key"}');
  assert.ok(m.includes('BREEZE_API_KEY'), m);
});
t('breeze 422 会把 detail 带出来', () => {
  const m = describeBreezeError(422, '{"detail":"language_code not supported"}');
  assert.ok(m.includes('language_code not supported'), m);
});
t('breeze 429 / 503 都提示稍后再试', () => {
  assert.ok(describeBreezeError(429, '').includes('稍后再试'));
  assert.ok(describeBreezeError(503, '').includes('稍后再试'));
});
t('breeze 错误体不是 JSON 也不炸', () => {
  const m = describeBreezeError(500, '<html>oops</html>');
  assert.ok(m.includes('500'));
  assert.ok(m.includes('oops'));
});
t('dashscope 错误翻译没被改坏', () => {
  assert.ok(describeTtsHttpError(401, '').includes('DASHSCOPE_API_KEY'));
  assert.ok(describeTtsHttpError(429, '').includes('限流'));
});

// ── synthesize 分流（不真发请求，用假 fetch 断言走哪条）────────────────────
await ta('provider 缺省走 dashscope', async () => {
  let hit = '';
  const fake = async (url) => { hit = String(url); return { ok: false, status: 401, text: async () => 'x' }; };
  const r = await synthesize('hi', { apiKey: 'k', fetchImpl: fake });
  assert.ok(hit.includes('dashscope'), hit);
  assert.equal(r.ok, false);
});
await ta('provider=breeze 走 breeze 且带 xi-api-key', async () => {
  let seen = null;
  const fake = async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return { ok: true, status: 200, arrayBuffer: async () => new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x41, 0x56, 0x45, 0, 0]).buffer, headers: new Map() };
  };
  const r = await synthesize('hi', { provider: 'breeze', apiKey: 'k', fetchImpl: fake });
  assert.ok(seen.url.includes('api.breeze.blue'), seen.url);
  assert.ok(seen.url.includes('/v1/text-to-speech/'), seen.url);
  assert.ok(seen.url.includes('output_format=wav_24000'), seen.url);
  assert.equal(seen.headers['xi-api-key'], 'k');
  assert.equal(r.ok, true);
  assert.ok(r.bytes > 0);
});
await ta('breeze 没 key 直接报错，不发请求', async () => {
  let called = false;
  const fake = async () => { called = true; return {}; };
  const r = await synthesizeBreeze('hi', { fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('BREEZE_API_KEY'), r.error);
  assert.equal(called, false);
});
await ta('breeze 文本超限不请求', async () => {
  let called = false;
  const fake = async () => { called = true; return {}; };
  const r = await synthesizeBreeze('字'.repeat(2000), { apiKey: 'k', maxChars: 1000, fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('过长'), r.error);
  assert.equal(called, false);
});
await ta('breeze 返回非 wav 时拒绝（不把错误页当音频）', async () => {
  const fake = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('<html>error page</html>').buffer, headers: new Map() });
  const r = await synthesizeBreeze('hi', { apiKey: 'k', fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('不是 wav'), r.error);
});
await ta('breeze 音频超 maxBytes 拒绝', async () => {
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(2000)]);
  const fake = async () => ({ ok: true, status: 200, arrayBuffer: async () => wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.length), headers: new Map() });
  const r = await synthesizeBreeze('hi', { apiKey: 'k', maxBytes: 100, fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('过大'), r.error);
});
await ta('fetch 抛 TimeoutError 时翻译成超时', async () => {
  const fake = async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; };
  const r = await synthesizeBreeze('hi', { apiKey: 'k', fetchImpl: fake });
  assert.equal(r.ok, false);
  assert.ok(r.error.includes('超时'), r.error);
});
await ta('breeze tone 真的进了请求体', async () => {
  let body = null;
  const fake = async (url, init) => {
    body = JSON.parse(init.body);
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('RIFF....WAVE....').buffer, headers: new Map() };
  };
  await synthesizeBreeze('哼', { apiKey: 'k', instructions: '用撒娇的语气', fetchImpl: fake });
  assert.equal(body.instructions, '用撒娇的语气');
});

console.log(`\n结果：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
