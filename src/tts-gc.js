// TTS 临时音频清理。
//
// 背景：`ttsSpeakV2` 每合成一句话就往 `audio/tts/` 写一个 wav，从来没有删除逻辑。
// 实测一天几句、一年几十 MB —— 服务器 available 只剩 400~500MB，这种只增不减的
// 目录属于慢性病，早治比晚治好。
//
// 两条铁律，都不能破：
//   1. **语音库（audio/ 根目录下的文件）绝对不动。** 那是她/管理员主动存的资产，
//      跟 TTS 缓存性质完全不同。所以这里只扫 `audio/tts/`，不递归、不看上级。
//   2. **正在用的那个文件不能删。** 合成完到发送成功之间有几十毫秒到几秒的窗口，
//      定时器刚好插进去就会「wav 被删了、发送失败」。所以按 mtime 留出宽限
//      (`minAgeMs`，默认 10 分钟)，比任何真实发送耗时都长得多。
//
// 整个模块是纯函数 + 一个薄薄的 fs 壳，方便单测直接喂假数据。

export const TTS_GC_DEFAULTS = {
  enabled: true,
  keepDays: 7,        // 超过 7 天的删
  keepMax: 200,       // 最多留 200 个（防一天狂发把磁盘吃光）
  keepRecent: 10,     // 无论多老，最近 10 个永远留（调试/复现有据可查）
  minAgeMs: 10 * 60 * 1000, // 10 分钟内的一律不碰（可能正在发送）
  intervalMs: 6 * 3600 * 1000, // 每 6 小时扫一次
};

/** 文件名里的 `tts-<ms>-<hex>.wav` 取时间戳；取不到返回 0（当成未知，走 mtime）。 */
export function tsFromTtsName(name) {
  const m = /^tts-(\d{10,16})-[0-9a-f]+\.wav$/i.exec(String(name ?? ''));
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * 算出要删哪些文件。**纯函数**，不碰磁盘。
 *
 * @param {Array<{name:string, mtimeMs:number, size:number}>} files
 * @param {{now?:number, keepDays?:number, keepMax?:number, keepRecent?:number, minAgeMs?:number}} [opts]
 * @returns {{ remove: Array<{name:string, size:number, reason:string}>, keepCount:number, removeBytes:number }}
 */
export function planTtsGc(files, opts = {}) {
  const now = Number(opts.now) || Date.now();
  const keepDays = Number.isFinite(Number(opts.keepDays)) ? Number(opts.keepDays) : TTS_GC_DEFAULTS.keepDays;
  const keepMax = Number.isFinite(Number(opts.keepMax)) ? Number(opts.keepMax) : TTS_GC_DEFAULTS.keepMax;
  const keepRecent = Number.isFinite(Number(opts.keepRecent)) ? Number(opts.keepRecent) : TTS_GC_DEFAULTS.keepRecent;
  const minAgeMs = Number.isFinite(Number(opts.minAgeMs)) ? Number(opts.minAgeMs) : TTS_GC_DEFAULTS.minAgeMs;

  const list = (Array.isArray(files) ? files : [])
    .filter((f) => f && typeof f.name === 'string' && f.name)
    .map((f) => {
      const mtime = Number(f.mtimeMs) || 0;
      const stamped = tsFromTtsName(f.name);
      return { name: f.name, size: Number(f.size) || 0, at: stamped || mtime };
    })
    // 新的在前
    .sort((a, b) => b.at - a.at || (a.name < b.name ? 1 : -1));

  const remove = [];
  const cutoff = keepDays > 0 ? now - keepDays * 24 * 3600 * 1000 : 0;
  let removeBytes = 0;

  for (let i = 0; i < list.length; i += 1) {
    const f = list[i];
    // 最近 keepRecent 个永远不删
    if (i < keepRecent) continue;
    // 太新的不删（可能正在发送）
    if (minAgeMs > 0 && f.at > now - minAgeMs) continue;
    let reason = '';
    if (keepMax > 0 && i >= keepMax) reason = `数量超限（第 ${i + 1} 个 > ${keepMax}）`;
    else if (cutoff > 0 && f.at > 0 && f.at < cutoff) reason = `超过 ${keepDays} 天`;
    if (!reason) continue;
    remove.push({ name: f.name, size: f.size, reason });
    removeBytes += f.size;
  }
  return { remove, keepCount: list.length - remove.length, removeBytes };
}

/** 只认纯文件名的路径校验：防 `..`、斜杠、反斜杠混进来把目录外的文件删掉。 */
export function isSafeTtsFileName(name) {
  const s = String(name ?? '');
  if (!s || s.length > 128) return false;
  if (s.includes('/') || s.includes('\\') || s.includes('\0')) return false;
  if (s === '.' || s === '..' || s.startsWith('.')) return false;
  return /^tts-[0-9a-z-]+\.wav$/i.test(s);
}

/**
 * 真正扫目录 + 删文件。返回统计。永不抛（定时器里调用，抛了会把整轮搞崩）。
 *
 * @param {string} dir 绝对路径，正常是 `<voice.dir>/tts`
 * @param {object} [opts] 同 planTtsGc，另加 { log, dryRun }
 */
export function gcTtsDir(dir, opts = {}) {
  const log = typeof opts.log === 'function' ? opts.log : () => {};
  const out = { ok: false, scanned: 0, removed: 0, bytes: 0, error: null, kept: 0 };
  try {
    // 动态 require 会让这个文件在 ESM/CJS 两边都能用；bridge 是 ESM，直接 import 也行，
    // 但它已经在 bridge 里 import 了 fs，这里为了单测不依赖外部状态用 fs 模块本体。
    // eslint-disable-next-line
    const fs = opts.fs || null;
    if (!fs) return { ...out, error: 'gcTtsDir 需要传入 fs（便于单测注入）' };
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (error) {
      if (error?.code === 'ENOENT') return { ...out, ok: true, error: null };
      return { ...out, error: error?.message ?? String(error) };
    }
    const files = [];
    for (const name of names) {
      if (!isSafeTtsFileName(name)) continue;
      let st = null;
      try {
        st = fs.statSync(`${dir}/${name}`);
      } catch { continue; }
      if (!st || !st.isFile()) continue;
      files.push({ name, mtimeMs: st.mtimeMs, size: st.size });
    }
    out.scanned = files.length;
    const plan = planTtsGc(files, opts);
    out.kept = plan.keepCount;
    if (opts.dryRun === true) {
      return { ...out, ok: true, dryRun: true, plan };
    }
    for (const item of plan.remove) {
      try {
        fs.unlinkSync(`${dir}/${item.name}`);
        out.removed += 1;
        out.bytes += item.size;
      } catch (error) {
        log(`[tts-gc] 删除失败 ${item.name}：${error?.message ?? error}`);
      }
    }
    out.ok = true;
    return out;
  } catch (error) {
    return { ...out, error: error?.message ?? String(error) };
  }
}
