// 生图的流式读取 + 分段探测。
//
// 为什么要有这个文件：非流式的时候，请求发出去之后、整张图画完之前，这条连接上
// **一个字节都没有**。中间层（凌风AI 中转 / Cloudflare）在 35~40 秒这个档口把空闲
// 连接掐掉，undici 读到一半抛 `terminated`（2026-10-28 18:19，38 秒，画完前一刻）。
//
// 实测（/tmp/probe-image-stream.mjs）：这条中转**支持** `stream: true`，回的是
// `text/event-stream`，事件长这样：
//   data: {"object":"image.generation.chunk","progress_text":"","data":[]}
//   data: {"object":"image.generation.result","data":[{"b64_json":"…","url":"…"}]}
// 所以改成流式之后，上游会周期性吐心跳，连接不再长时间静默；我们顺带还能知道
// 「已经画到哪一步了」。
//
// 本文件只做两件事，都能单测：
//   parseSseImage(text) —— 从已经收到的文本里把图/进度挑出来（纯函数，可重扫）
//   readImageStream(body, opts) —— 读 ReadableStream 直到拿到图，中途卡住就报 stall
//
// 刻意不做的：不做「断点续画」——生成接口没有这个语义，卡住只能重来。

export const IMAGE_STREAM_DEFAULTS = {
  maxBytes: 12 * 1024 * 1024,   // b64 一张 1024x1024 的图约 1.7MB 文本，12MB 足够且能挡住跑飞；0=不限
  stallLogMs: 15000,            // 静默多久打一条「还在等」（只记日志，不打断）
  // 为什么默认**不**因为静默而中止：实测这条中转是「攒完再吐」——响应头 22 秒才到，
  // 之后 1 秒内 179 块全到，`progress_text` 是空的。也就是说「没字节」= 「还没画完」，
  // 而不是「连接坏了」。真按 60 秒中止，会把 70 秒才画完的图白白掐掉。所以静默只记账，
  // 中止交给外层预算（image.timeoutMs）和断连重试；要强制中止就显式配 stallAbortMs。
  stallAbortMs: 0,
};

/**
 * 把 opts 里的数值选项归一：undefined → 默认；显式 0 → 关掉这项。
 */
function pickMs(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function pickImageFromObject(obj) {
  if (!obj || typeof obj !== 'object') return null;
  // 1) 中转自己的形状：{object:'image.generation.result', data:[{b64_json,url}]}
  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (item && typeof item === 'object' && (item.b64_json || item.url)) {
        return { b64: typeof item.b64_json === 'string' ? item.b64_json : '', url: typeof item.url === 'string' ? item.url : '' };
      }
    }
  }
  // 2) OpenAI 原生流式事件：{type:'image_generation.completed'|'image_generation.partial_image', b64_json}
  if (typeof obj.b64_json === 'string' && obj.b64_json) return { b64: obj.b64_json, url: '' };
  if (typeof obj.url === 'string' && obj.url && !obj.object) return { b64: '', url: obj.url };
  return null;
}

function pickProgressText(obj) {
  if (!obj || typeof obj !== 'object') return '';
  if (typeof obj.progress_text === 'string' && obj.progress_text.trim()) return obj.progress_text.trim();
  if (typeof obj.progress === 'string' && obj.progress.trim()) return obj.progress.trim();
  // 有些中转把进度塞在 data 里
  if (Array.isArray(obj.data)) {
    for (const item of obj.data) {
      if (item && typeof item === 'object' && typeof item.progress_text === 'string' && item.progress_text.trim()) {
        return item.progress_text.trim();
      }
    }
  }
  return '';
}

/**
 * 从累积文本里挑出图与进度。可以反复调用（每收一块扫一遍），因为流很小。
 * @returns {{b64: string, url: string, progress: string[], lines: number}}
 */
export function parseSseImage(text) {
  const out = { b64: '', url: '', progress: [], lines: 0 };
  const raw = String(text ?? '');
  if (!raw) return out;

  // 整段就是一个 JSON（非流式的老形状，或者中转把流攒完一次吐出）
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const whole = JSON.parse(trimmed);
      const hit = pickImageFromObject(whole);
      if (hit) return { ...out, b64: hit.b64, url: hit.url, lines: 1 };
    } catch {
      // 不是完整 JSON，按行扫
    }
  }

  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith(':') || s.startsWith('event:') || s.startsWith('id:')) continue;
    let payloadText = s;
    if (s.startsWith('data:')) payloadText = s.slice(5).trim();
    if (!payloadText || payloadText === '[DONE]') continue;
    if (!payloadText.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(payloadText);
    } catch {
      continue; // 半块 JSON：等下一块重扫
    }
    out.lines += 1;
    const progress = pickProgressText(obj);
    if (progress && !out.progress.includes(progress)) out.progress.push(progress);
    if (!out.b64 && !out.url) {
      const hit = pickImageFromObject(obj);
      if (hit) {
        out.b64 = hit.b64;
        out.url = hit.url;
      }
    }
  }
  return out;
}

function stallError(ms) {
  const error = new Error(`上游 ${Math.round(ms / 1000)} 秒没有吐任何字节`);
  error.name = 'ImageStreamStall';
  error.code = 'STALLED';
  return error;
}

/**
 * 读流直到拿到图。
 * @param {ReadableStream} body
 * @param {object} opts
 *   maxBytes / stallLogMs / stallAbortMs / abort() / onProgress(text, ms) / onStall(ms) / now()
 */
export async function readImageStream(body, opts = {}) {
  // 三个数值选项都走 pickMs：undefined 用默认，显式 0 表示关掉（尤其 stallAbortMs=0 = 只记日志不中止）。
  const maxBytes = pickMs(opts.maxBytes, IMAGE_STREAM_DEFAULTS.maxBytes);
  const stallLogMs = pickMs(opts.stallLogMs, IMAGE_STREAM_DEFAULTS.stallLogMs);
  const stallAbortMs = pickMs(opts.stallAbortMs, IMAGE_STREAM_DEFAULTS.stallAbortMs);
  const now = typeof opts.now === 'function' ? opts.now : () => Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const onStall = typeof opts.onStall === 'function' ? opts.onStall : () => {};
  const abort = typeof opts.abort === 'function' ? opts.abort : () => {};

  if (!body || typeof body.getReader !== 'function') throw new Error('上游没有返回可读的流（可能被中间层改成了非流式）');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const startedAt = now();
  let text = '';
  let bytes = 0;
  let chunks = 0;
  let lastProgress = '';

  const cancelQuietly = async () => {
    try { await reader.cancel(); } catch { /* 已经断了就算了 */ }
  };

  try {
    while (true) {
      let step;
      try {
        step = await readWithStall(reader, stallLogMs, stallAbortMs, onStall, now);
      } catch (error) {
        await cancelQuietly();
        if (error?.name === 'ImageStreamStall') {
          abort();
          throw error;
        }
        throw error;
      }
      if (step.done) break;
      chunks += 1;
      bytes += step.value?.byteLength ?? 0;
      if (maxBytes > 0 && bytes > maxBytes) {
        await cancelQuietly();
        const error = new Error(`上游的流太大（超过 ${Math.round(maxBytes / 1048576)}MB）`);
        error.code = 'TOO_LARGE';
        throw error;
      }
      text += decoder.decode(step.value, { stream: true });
      const found = parseSseImage(text);
      if (found.progress.length) {
        const latest = found.progress[found.progress.length - 1];
        if (latest !== lastProgress) {
          lastProgress = latest;
          onProgress(latest, now() - startedAt);
        }
      }
      if (found.b64 || found.url) {
        await cancelQuietly();
        return { b64: found.b64, url: found.url, bytes, chunks, elapsedMs: now() - startedAt, progress: found.progress };
      }
    }
    text += decoder.decode();
    const found = parseSseImage(text);
    if (found.b64 || found.url) {
      return { b64: found.b64, url: found.url, bytes, chunks, elapsedMs: now() - startedAt, progress: found.progress };
    }
    const error = new Error(`上游的流里没有图（收到 ${bytes} 字节 / ${chunks} 块）`);
    error.code = 'NO_IMAGE';
    throw error;
  } finally {
    try { reader.releaseLock(); } catch { /* 无所谓 */ }
  }
}

// 单次 read 的「分段探测」：静默 stallLogMs 打一条日志（只打一次），静默 stallAbortMs 抛 stall。
function readWithStall(reader, stallLogMs, stallAbortMs, onStall) {
  return new Promise((resolve, reject) => {
    const logTimer = stallLogMs > 0
      ? setTimeout(() => {
        try { onStall(stallLogMs); } catch { /* 日志失败不影响流程 */ }
      }, stallLogMs)
      : null;
    logTimer?.unref?.();
    const abortTimer = stallAbortMs > 0
      ? setTimeout(() => reject(stallError(stallAbortMs)), stallAbortMs)
      : null;
    abortTimer?.unref?.();
    const clear = () => {
      if (logTimer) clearTimeout(logTimer);
      if (abortTimer) clearTimeout(abortTimer);
    };
    reader.read().then(
      (step) => { clear(); resolve(step); },
      (error) => { clear(); reject(error); },
    );
  });
}
