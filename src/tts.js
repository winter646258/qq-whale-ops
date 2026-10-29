// ── TTS：把一句话变成一条语音 ────────────────────────────────────────────────
//
// 语音发送通道一直是通的（sendVoiceV2 / 限流 / 音量 / 落地校验 / 转写回读），
// 缺的只有「文字 → 音频文件」这一步。这个文件补的就是它。
//
// 为什么用 DashScope 的 qwen3-tts-flash：
//   · 服务器没有 GPU，本地 TTS 不现实；
//   · 它 HTTP 直调、不需要 SDK、返回一个 24h 有效的 wav 直链，适合我们这种
//     「现合成、现发、发完不留」的用法；
//   · 7 个预置音色（Cherry/Serena/…）都是通用合成音，**不复刻任何真人**。
//
// 三条设计约束（都是被现有代码逼出来的）：
//   1. **文本上限 600 字符**是接口硬限制，超了直接 400。所以要能安全切段。
//   2. 合成结果**必须落到语音库内**：`resolveVoicePathForV2` 有 `voicePathInsideLibrary`
//      这道闸，库外绝对路径一律拒（AI 通道的 allowAbsolutePath 已失效）。所以调用方
//      要把文件写进 `voice.dir/tts/`，不是 /tmp。
//   3. 这个模块**不 throw**：一律 `{ok:false, error}`。调用方是聊天路径，炸了会带崩
//      整轮回复，而「没发出语音」是可以用文字兜住的小事。

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

/** 音色名归一：大小写不敏感，认不出的回落到默认（不报错，语音不该因为音色名炸掉）。 */
export function pickVoice(name, fallback = TTS_DEFAULTS.voice) {
  const raw = String(name ?? '').trim();
  if (!raw) return fallback;
  const hit = TTS_VOICES.find((v) => v.toLowerCase() === raw.toLowerCase());
  return hit ?? fallback;
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

/**
 * 合成一段文本，拿到 wav 直链。
 * @returns {{ok:true,url,characters,expiresAt,requestId}|{ok:false,error}}
 */
export async function synthesize(text, opts = {}) {
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
