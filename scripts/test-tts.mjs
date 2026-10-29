// TTS 纯逻辑单测（不联网，全部用 mock fetch）。
// 跑法：node scripts/test-tts.mjs
import {
  TTS_DEFAULTS,
  TTS_VOICES,
  pickVoice,
  splitSpeechText,
  buildTtsBody,
  parseTtsResponse,
  describeTtsHttpError,
  synthesize,
  downloadTtsAudio,
  readEnvValue,
} from '../src/tts.js';

let pass = 0;
const fails = [];
function ok(cond, name) {
  if (cond) { pass += 1; return; }
  fails.push(name);
  console.error(`✗ ${name}`);
}
function eq(a, b, name) {
  ok(JSON.stringify(a) === JSON.stringify(b), `${name}（得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}）`);
}

// ── pickVoice ──────────────────────────────────────────────────────────
eq(pickVoice('cherry'), 'Cherry', 'pickVoice 大小写不敏感');
eq(pickVoice('DYLAN'), 'Dylan', 'pickVoice 全大写');
eq(pickVoice('不存在的音色'), TTS_DEFAULTS.voice, 'pickVoice 未知回落默认');
eq(pickVoice(''), TTS_DEFAULTS.voice, 'pickVoice 空值回落默认');
eq(pickVoice(null), TTS_DEFAULTS.voice, 'pickVoice null 回落默认');
eq(TTS_VOICES.length, 7, '预置音色共 7 个');

// ── splitSpeechText ────────────────────────────────────────────────────
eq(splitSpeechText(''), [], '空文本返回空数组');
eq(splitSpeechText('   '), [], '纯空白返回空数组');
eq(splitSpeechText('短句。'), ['短句。'], '短文本原样返回');

const long = '第一句话在这里。'.repeat(120); // 960 字符
const parts = splitSpeechText(long, 600);
ok(parts.length >= 2, `超长文本被切段（${parts.length} 段）`);
ok(parts.every((p) => p.length <= 600), '每段都不超过上限');
ok(parts.join('') === long.replace(/\s+/g, ' ').trim(), '切段后拼回等于原文');

// 优先切在句末：切点应在「。」之后
ok(parts[0].endsWith('。'), '优先切在句末标点');

// 没标点的长串走硬切，但每段仍受限
const noPunct = 'あ'.repeat(1300);
const parts2 = splitSpeechText(noPunct, 600);
ok(parts2.every((p) => p.length <= 600), '无标点长串硬切后仍不超上限');
ok(parts2.join('') === noPunct, '无标点长串切段无丢失');

// 英文/数字不被切断语义（这里只验证不产生空段与长度正确）
const mixed = 'abc 123 def 456. '.repeat(80);
const parts3 = splitSpeechText(mixed, 200);
ok(parts3.every((p) => p.length > 0 && p.length <= 200), '英文长串每段非空且不超限');

eq(splitSpeechText('  a   b  '), ['a b'], '连续空白折叠');

// ── buildTtsBody ───────────────────────────────────────────────────────
const body = buildTtsBody('你好', { voice: 'Serena' });
eq(body.model, 'qwen3-tts-flash', '默认模型');
eq(body.input.text, '你好', '文本透传');
eq(body.input.voice, 'Serena', '音色生效');
eq(body.input.language_type, 'Chinese', '默认语言');
eq(buildTtsBody('x', { model: 'm2', languageType: 'English' }).model, 'm2', '模型可覆盖');
eq(buildTtsBody('x', { languageType: 'English' }).input.language_type, 'English', '语言可覆盖');

// ── parseTtsResponse ───────────────────────────────────────────────────
const good = parseTtsResponse({
  output: { audio: { url: 'https://x/a.wav', id: 'audio_1', expires_at: 1793371046 } },
  usage: { characters: 30 },
  request_id: 'req-1',
});
eq(good.ok, true, '正常响应 ok');
eq(good.url, 'https://x/a.wav', '取出 url');
eq(good.characters, 30, '取出 characters');
eq(good.expiresAt, 1793371046, '取出 expires_at');
eq(good.requestId, 'req-1', '取出 request_id');

eq(parseTtsResponse({}).ok, false, '空响应判失败');
eq(parseTtsResponse({ output: { audio: {} } }).ok, false, '无 url 判失败');
eq(parseTtsResponse(null).ok, false, 'null 判失败');
ok(String(parseTtsResponse({ code: 'InvalidApiKey', message: 'bad' }).error).includes('bad'), '错误信息带 message');

// ── describeTtsHttpError ───────────────────────────────────────────────
ok(describeTtsHttpError(401, 'x').includes('鉴权失败'), '401 归为鉴权');
ok(describeTtsHttpError(403, 'x').includes('鉴权失败'), '403 归为鉴权');
ok(describeTtsHttpError(429, 'x').includes('限流'), '429 归为限流');
ok(describeTtsHttpError(400, 'x').includes('超长'), '400 提示超长');
ok(describeTtsHttpError(500, 'boom').includes('boom'), '500 带原文片段');
ok(describeTtsHttpError(500, 'y'.repeat(1000)).length < 400, '错误片段被截断');

// ── synthesize（mock fetch）─────────────────────────────────────────────
const okFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ output: { audio: { url: 'https://cdn/a.wav' } }, usage: { characters: 2 } }),
});
const r1 = await synthesize('测试', { apiKey: 'k', fetchImpl: okFetch });
eq(r1.ok, true, 'synthesize 成功');
eq(r1.url, 'https://cdn/a.wav', 'synthesize 返回 url');

const r2 = await synthesize('测试', { apiKey: '' });
eq(r2.ok, false, 'synthesize 无 key 失败');
ok(r2.error.includes('未配置 key'), '无 key 错误可读');

const r3 = await synthesize('   ', { apiKey: 'k' });
eq(r3.ok, false, 'synthesize 空文本失败');

const r4 = await synthesize('x'.repeat(700), { apiKey: 'k' });
eq(r4.ok, false, 'synthesize 超长直接拒（不发请求）');
ok(r4.error.includes('过长'), '超长错误可读');

const badFetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized' });
const r5 = await synthesize('测试', { apiKey: 'k', fetchImpl: badFetch });
eq(r5.ok, false, 'synthesize HTTP 401 失败');
ok(r5.error.includes('鉴权失败'), '401 错误可读');

const throwFetch = async () => { throw new Error('ECONNRESET'); };
const r6 = await synthesize('测试', { apiKey: 'k', fetchImpl: throwFetch });
eq(r6.ok, false, 'synthesize 网络异常不 throw');
ok(r6.error.includes('ECONNRESET'), '网络异常信息保留');

const timeoutFetch = async () => { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
const r7 = await synthesize('测试', { apiKey: 'k', fetchImpl: timeoutFetch });
ok(r7.ok === false && r7.error.includes('超时'), '超时单独提示');

const notJson = async () => ({ ok: true, status: 200, text: async () => '<html>oops</html>' });
const r8 = await synthesize('测试', { apiKey: 'k', fetchImpl: notJson });
ok(r8.ok === false && r8.error.includes('不是 JSON'), '非 JSON 响应可读');

// ── downloadTtsAudio（mock fetch）────────────────────────────────────────
const riff = Buffer.concat([
  Buffer.from('RIFF', 'ascii'),
  Buffer.from([0x24, 0x00, 0x00, 0x00]),
  Buffer.from('WAVE', 'ascii'),
  Buffer.alloc(36, 0),
]);
const dlOk = await downloadTtsAudio('https://cdn/a.wav', {
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => riff }),
});
eq(dlOk.ok, true, '下载 wav 成功');
eq(dlOk.bytes, riff.length, '字节数正确');

const dlNotWav = await downloadTtsAudio('https://cdn/a.wav', {
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('<Error><Code>AccessDenied</Code></Error>') }),
});
ok(dlNotWav.ok === false && dlNotWav.error.includes('不是 wav'), '非 wav 被拦（OSS 错误 XML 不会当音频存）');

const dlEmpty = await downloadTtsAudio('https://cdn/a.wav', {
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.alloc(0) }),
});
ok(dlEmpty.ok === false && dlEmpty.error.includes('为空'), '空内容被拦');

const dlBig = await downloadTtsAudio('https://cdn/a.wav', {
  maxBytes: 4,
  fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => riff }),
});
ok(dlBig.ok === false && dlBig.error.includes('过大'), '超限被拦');

const dlHttp = await downloadTtsAudio('https://cdn/a.wav', {
  fetchImpl: async () => ({ ok: false, status: 404 }),
});
ok(dlHttp.ok === false && dlHttp.error.includes('404'), '下载 404 可读');

// ── readEnvValue ───────────────────────────────────────────────────────
eq(readEnvValue('A=1\nB=2', 'B'), '2', 'readEnvValue 基本');
eq(readEnvValue('export A="hello world"', 'A'), 'hello world', 'readEnvValue 去引号 + export');
eq(readEnvValue("A='x'", 'A'), 'x', 'readEnvValue 单引号');
eq(readEnvValue('A=1', 'Z'), '', 'readEnvValue 缺键返回空');
eq(readEnvValue('# A=1\nB=2', 'B'), '2', 'readEnvValue 跳过注释行');
eq(readEnvValue('DASHSCOPE_API_KEY=sk-x', 'DASHSCOPE_API_KEY'), 'sk-x', 'readEnvValue 真实键名');

// ── 汇总 ───────────────────────────────────────────────────────────────
console.log(`\n${pass} 项通过，${fails.length} 项失败`);
if (fails.length) {
  console.error('失败项：\n' + fails.map((f) => ` - ${f}`).join('\n'));
  process.exit(1);
}
