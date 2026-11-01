// ── TTS：把一句话变成一条语音 ────────────────────────────────────────────────
//
// 语音发送通道一直是通的（sendVoiceV2 / 限流 / 音量 / 落地校验 / 转写回读），
// 缺的只有「文字 → 音频文件」这一步。这个文件补的就是它。
//
// 两个渠道，形状不同，别混：
//   · dashscope（qwen3-tts-flash）：JSON 进、JSON 出，拿一个 24h 有效的 wav 直链，
//     还要再下载一次。`synthesize()` 走这条。
//   · breeze（breeze-tts-2）：JSON 进、**二进制音频直接出来**，没有 url 这一步。
//     `synthesizeBreeze()` 走这条。它多一个 instructions 字段，能改语气/情绪/语速，
//     这是换过来的主要原因。
//
// 三条设计约束（都是被现有代码逼出来的）：
//   1. **文本上限**（dashscope 600 / breeze 1000）是接口硬限制，超了直接 400。所以要能安全切段。
//   2. 合成结果**必须落到语音库内**：`resolveVoicePathForV2` 有 `voicePathInsideLibrary`
//      这道闸，库外绝对路径一律拒（AI 通道的 allowAbsolutePath 已失效）。所以调用方
//      要把文件写进 `voice.dir/tts/`，不是 /tmp。
//   3. 这个模块**不 throw**：一律 `{ok:false, error}`。调用方是聊天路径，炸了会带崩
//      整轮回复，而「没发出语音」是可以用文字兜住的小事。

export const TTS_PROVIDERS = ['dashscope', 'breeze'];

export const TTS_DEFAULTS = {
  model: 'qwen3-tts-flash',
  voice: 'Cherry',
  languageType: 'Chinese',
  maxChars: 600,
  timeoutMs: 30000,
  downloadTimeoutMs: 30000,
  downloadMaxBytes: 12 * 1024 * 1024,
  endpoint: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
};

// 接口支持的预置音色。全部是合成音，不指向任何真人。
export const TTS_VOICES = ['Cherry', 'Serena', 'Chelsie', 'Sunny', 'Jada', 'Dylan', 'Ethan'];

// ── Breeze Blue ─────────────────────────────────────────────────────────────
//
// 同步模式下直接回 `audio/wav` 二进制，响应头里带 `history-item-id`。
// 中文女声只这几个（`GET /v1/voices` 的 language_code=zh、gender=female），
// 名字和描述原样抄自接口，别自己编。
export const BREEZE_DEFAULTS = {
  endpoint: 'https://api.breeze.blue',
  model: 'breeze-tts-2',
  voice: 'voc_u3nxkd5578wc', // 大肥鱼（机灵版）
  languageCode: 'zh',
  outputFormat: 'wav_24000',
  maxChars: 1000,
  timeoutMs: 60000,
  downloadMaxBytes: 12 * 1024 * 1024,
};

export const BREEZE_VOICES = [
  { id: 'voc_u3nxkd5578wc', name: '大肥鱼（机灵版）', desc: '清亮甜软、反应轻快的普通话少女音' },
  { id: 'voc_8yud7hz7c9q2', name: '大肥鱼（迷糊版）', desc: '清亮柔软、略带奶气的普通话少女音' },
  { id: 'voc_rh6e8hdbraz6', name: '哈基米娘', desc: '清亮灵动的普通话少女猫娘音，字头轻巧利落，短句富有弹性' },
  { id: 'voc_rc894j8q2auu', name: '知绘小姐', desc: '明亮干脆的普通话年轻女声，说话快而清楚' },
  { id: 'voc_b86bfwct4cjn', name: '香农小姐', desc: '清冷疏离的普通话年轻女声，表达清晰，语气克制而有条理' },
];

/** 音色名归一：大小写不敏感，认不出的回落到默认（不报错，语音不该因为音色名炸掉）。 */
export function pickVoice(name, fallback = TTS_DEFAULTS.voice) {
  const raw = String(name ?? '').trim();
  if (!raw) return fallback;
  const hit = TTS_VOICES.find((v) => v.toLowerCase() === raw.toLowerCase());
  return hit ?? fallback;
}

/** Breeze 音色归一：认 id、认中文名、认英文键，认不出回落默认。 */
export function pickBreezeVoice(name, fallback = BREEZE_DEFAULTS.voice) {
  const raw = String(name ?? '').trim();
  if (!raw) return fallback;
  const lower = raw.toLowerCase();
  const hit = BREEZE_VOICES.find((v) => v.id.toLowerCase() === lower || v.name === raw || v.name.toLowerCase() === lower);
  return hit ? hit.id : (lower.startsWith('voc_') ? raw : fallback);
}

/**
 * 把长文本切成每段 ≤ maxChars 的数组。
 *
 * 切点优先级：句末标点（。！？；…\n）> 逗号/顿号 > 硬切。
 * 不切在单词/数字中间——600 字大概是 2~3 分钟语音，本身已经是「一条语音」的上限，
 * 再多段就该考虑用文字说了，所以调用方通常只取第一段。
 */
export function splitSpeechText(text, maxChars = TTS_DEFAULTS.maxChars) {
  const limit = Math.max(20, Number(maxChars) || TTS_DEFAULTS.maxChars);
  const src = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!src) return [];
  if (src.length <= limit) return [src];

  const out = [];
  let rest = src;
  const soft = /[。！？!?；;…\n]/;
  const soft2 = /[，,、：:]/;
  while (rest.length > limit) {
    let cut = -1;
    // 先在窗口内找句末
    for (let i = limit; i > Math.floor(limit * 0.45); i -= 1) {
      if (soft.test(rest[i - 1])) { cut = i; break; }
    }
    if (cut < 0) {
      for (let i = limit; i > Math.floor(limit * 0.6); i -= 1) {
        if (soft2.test(rest[i - 1])) { cut = i; break; }
      }
    }
    if (cut < 0) cut = limit;
    const piece = rest.slice(0, cut).trim();
    if (piece) out.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export function buildTtsBody(text, opts = {}) {
  return {
    model: opts.model || TTS_DEFAULTS.model,
    input: {
      text: String(text ?? ''),
      voice: pickVoice(opts.voice),
      language_type: opts.languageType || TTS_DEFAULTS.languageType,
    },
  };
}

/**
 * Breeze 的请求体。
 *
 * `instructions` 是「怎么念」，不是要念的内容 —— 用和文本同一种语言写。
 * 实测：同一句话，耳语 2.5~4.3s / 大喊 2.0~2.3s / 慢速 3.0~4.7s，
 * 音量 shout 平均 -18.7dB、whisper -24.2dB，所以它是**真生效**，不是被静默忽略。
 * 但同一组参数重复生成也会有几秒的波动（采样随机），单次对比不足以判定。
 *
 * `voice_settings` 只在真有值时出现：`use_speaker_boost` 在 instructions 非空且
 * guidance_scale > 1 时会被忽略，所以干脆不传。
 */
export function buildBreezeBody(text, opts = {}) {
  const body = {
    text: String(text ?? ''),
    model_id: opts.model || BREEZE_DEFAULTS.model,
    language_code: opts.languageCode || BREEZE_DEFAULTS.languageCode,
  };
  const ins = String(opts.instructions ?? '').trim();
  if (ins) body.instructions = ins;
  const vs = {};
  const gs = Number(opts.guidanceScale);
  if (Number.isFinite(gs) && gs >= 1 && gs <= 10) vs.guidance_scale = gs;
  const sp = Number(opts.speed);
  if (Number.isFinite(sp) && sp >= 0.5 && sp <= 2) vs.speed = sp;
  if (Object.keys(vs).length) body.voice_settings = vs;
  return body;
}

/** 解析成功响应：`{output:{audio:{url,expires_at,id}}, usage:{characters}, request_id}` */
export function parseTtsResponse(json) {
  const url = json?.output?.audio?.url;
  if (!url) {
    const msg = json?.message || json?.code || '响应里没有 audio.url';
    return { ok: false, error: `TTS 返回异常：${msg}` };
  }
  return {
    ok: true,
    url: String(url),
    audioId: json?.output?.audio?.id ?? null,
    expiresAt: Number(json?.output?.audio?.expires_at) || null,
    characters: Number(json?.usage?.characters) || 0,
    requestId: json?.request_id ?? null,
  };
}

/** 把 HTTP 失败翻译成人话（401/403 是 key 问题，429 是额度，其他是接口问题）。 */
export function describeTtsHttpError(status, bodyText) {
  const snippet = String(bodyText ?? '').slice(0, 300);
  if (status === 401 || status === 403) return `TTS 鉴权失败（HTTP ${status}）：检查 DASHSCOPE_API_KEY 是否有效或已过期。${snippet}`;
  if (status === 429) return `TTS 触发限流（HTTP 429）：稍后再试。${snippet}`;
  if (status === 400) return `TTS 参数被拒（HTTP 400）：多半是文本超长或音色名不支持。${snippet}`;
  return `TTS 请求失败（HTTP ${status}）：${snippet}`;
}

/** Breeze 的错误体是 `{ok:false, code, detail, error}`，比 DashScope 的更好读。 */
export function describeBreezeError(status, bodyText) {
  const snippet = String(bodyText ?? '').slice(0, 300);
  let detail = '';
  try {
    const j = JSON.parse(String(bodyText ?? ''));
    detail = j?.detail || j?.error || j?.code || '';
  } catch {}
  const tail = detail ? `：${detail}` : `：${snippet}`;
  if (status === 401 || status === 403) return `Breeze 鉴权失败（HTTP ${status}）：检查 BREEZE_API_KEY 是否有效。${snippet}`;
  if (status === 402) return `Breeze 额度不足（HTTP 402）${tail}`;
  if (status === 404) return `Breeze 找不到音色或模型（HTTP 404）${tail}`;
  if (status === 422) return `Breeze 参数校验失败（HTTP 422）${tail}`;
  if (status === 429) return `Breeze 触发限流（HTTP 429）：稍后再试。${snippet}`;
  if (status === 503) return `Breeze 暂不可用（HTTP 503）：稍后再试。${snippet}`;
  return `Breeze 请求失败（HTTP ${status}）${tail}`;
}

/**
 * 合成一段文本，拿到 wav 直链（dashscope）。
 * @returns {{ok:true,url,characters,expiresAt,requestId}|{ok:false,error}}
 */
export async function synthesize(text, opts = {}) {
  // provider 走 opts，缺省还是 dashscope —— 换渠道必须显式说，别偷偷换。
  if (String(opts.provider ?? '').toLowerCase() === 'breeze') return synthesizeBreeze(text, opts);
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'TTS 未配置 key（DASHSCOPE_API_KEY 为空）' };
  const body = buildTtsBody(text, opts);
  const content = String(body.input.text ?? '').trim();
  if (!content) return { ok: false, error: 'TTS 文本为空' };
  const maxChars = Number(opts.maxChars) || TTS_DEFAULTS.maxChars;
  if (content.length > maxChars) {
    return { ok: false, error: `TTS 文本过长（${content.length} > ${maxChars} 字符），请先切段` };
  }
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(opts.endpoint || TTS_DEFAULTS.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || TTS_DEFAULTS.timeoutMs),
    });
    const raw = await res.text();
    if (!res.ok) return { ok: false, error: describeTtsHttpError(res.status, raw) };
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      return { ok: false, error: `TTS 返回的不是 JSON：${raw.slice(0, 200)}` };
    }
    return parseTtsResponse(json);
  } catch (error) {
    const msg = error?.name === 'TimeoutError'
      ? `TTS 合成超时（${Number(opts.timeoutMs) || TTS_DEFAULTS.timeoutMs}ms）`
      : `TTS 合成失败：${error?.message ?? error}`;
    return { ok: false, error: msg };
  }
}

/**
 * Breeze 合成：**直接拿音频字节**，没有 url 也没有第二次下载。
 *
 * 注意这里返回的是 `buffer`，和 dashscope 的 `url` 不是一回事 —— 调用方要分开处理
 * （`bridge.js` 的 `ttsSpeakV2` 就是这么分的）。别把 `syn.url` 当成通用字段。
 */
export async function synthesizeBreeze(text, opts = {}) {
  const apiKey = String(opts.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'Breeze 未配置 key（BREEZE_API_KEY 为空）' };
  const content = String(text ?? '').trim();
  if (!content) return { ok: false, error: 'TTS 文本为空' };
  const maxChars = Number(opts.maxChars) || BREEZE_DEFAULTS.maxChars;
  if (content.length > maxChars) {
    return { ok: false, error: `TTS 文本过长（${content.length} > ${maxChars} 字符），请先切段` };
  }
  const voiceId = pickBreezeVoice(opts.voice);
  const base = String(opts.endpoint || BREEZE_DEFAULTS.endpoint).replace(/\/+$/, '');
  const fmt = String(opts.outputFormat || BREEZE_DEFAULTS.outputFormat);
  const url = `${base}/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(fmt)}`;
  const maxBytes = Number(opts.maxBytes) || BREEZE_DEFAULTS.downloadMaxBytes;
  const doFetch = opts.fetchImpl ?? fetch;
  try {
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(buildBreezeBody(content, opts)),
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || BREEZE_DEFAULTS.timeoutMs),
    });
    if (!res.ok) {
      const raw = await res.text().catch(() => '');
      return { ok: false, error: describeBreezeError(res.status, raw) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: 'Breeze 返回空音频' };
    if (buf.length > maxBytes) return { ok: false, error: `Breeze 音频过大（${buf.length} > ${maxBytes} 字节）` };
    // 同 dashscope 的 downloadTtsAudio：别把错误页当音频存下去。
    const isWav = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
    if (!isWav) {
      const head = buf.toString('utf8', 0, 160).replace(/\s+/g, ' ');
      return { ok: false, error: `Breeze 返回的不是 wav（开头：${head}）` };
    }
    return {
      ok: true,
      buffer: buf,
      bytes: buf.length,
      characters: content.length,
      voiceId,
      historyItemId: res.headers.get('history-item-id') || null,
    };
  } catch (error) {
    const msg = error?.name === 'TimeoutError'
      ? `Breeze 合成超时（${Number(opts.timeoutMs) || BREEZE_DEFAULTS.timeoutMs}ms）`
      : `Breeze 合成失败：${error?.message ?? error}`;
    return { ok: false, error: msg };
  }
}

/** 下载合成出来的 wav。校验 RIFF/WAVE 头，避免把 OSS 的错误 XML 当音频存下去。 */
export async function downloadTtsAudio(url, opts = {}) {
  const doFetch = opts.fetchImpl ?? fetch;
  const maxBytes = Number(opts.maxBytes) || TTS_DEFAULTS.downloadMaxBytes;
  try {
    const res = await doFetch(String(url), {
      method: 'GET',
      signal: AbortSignal.timeout(Number(opts.timeoutMs) || TTS_DEFAULTS.downloadTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `TTS 音频下载失败（HTTP ${res.status}）` };
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return { ok: false, error: 'TTS 音频下载为空' };
    if (buf.length > maxBytes) return { ok: false, error: `TTS 音频过大（${buf.length} > ${maxBytes} 字节）` };
    const isRiff = buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE';
    if (!isRiff) {
      const head = buf.toString('utf8', 0, 120).replace(/\s+/g, ' ');
      return { ok: false, error: `TTS 返回的不是 wav（开头：${head}）` };
    }
    return { ok: true, buffer: buf, bytes: buf.length };
  } catch (error) {
    const msg = error?.name === 'TimeoutError'
      ? `TTS 音频下载超时（${Number(opts.timeoutMs) || TTS_DEFAULTS.downloadTimeoutMs}ms）`
      : `TTS 音频下载失败：${error?.message ?? error}`;
    return { ok: false, error: msg };
  }
}

/** 从 `.env` 风格的文本里取某个键（不引入 dotenv，一行就够）。 */
export function readEnvValue(envText, keyName) {
  const name = String(keyName ?? '').trim();
  if (!name) return '';
  const re = new RegExp(`^\\s*(?:export\\s+)?${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(.*)$`, 'm');
  const m = re.exec(String(envText ?? ''));
  if (!m) return '';
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
  return v.trim();
}
