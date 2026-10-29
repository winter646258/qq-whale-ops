// 视频抽帧拼图：把「群友发的一个视频」变成「几张有时序的拼图」。
//
// 为什么不是把视频原样发出去：
//   a) 她的主模型（deepseek 系）不接视频；只有视觉模型能看图，而视觉模型只吃 image。
//   b) 这台机器 1736MB 内存、2 vCPU，一个 50MB 的视频 base64 之后 67MB，
//      再叠一层模型输入，直接把内存打穿。
//   c) 实测（report-44）：原生视频按「采样 1fps、258 token/帧 + 音频 32 token/秒」
//      计费，3 分钟以上一律顶到 180 秒截断线 ≈ 52.4k token，而后面几分钟的内容
//      根本没被看见；抽帧拼图同一条视频 ≈ 0.6k–7.3k token，事件覆盖率反而更高
//      （原生 68%、抽帧 91%）。
//
// 所以这里的产物是「N 张拼图 + 每张的序号」，交给现成的图片管线
// （normalizeImageForModel → 视觉模型代看）去读，不新增任何模型通道。
//
// 已知盲区（写在这里，免得以后有人以为这是全能）：
//   - 听不到声音。这台机器上 ASR 不现实（2 核实测 175 秒视频要 147 秒），
//     所以纯音乐类视频、靠台词推进的内容会缺一半。要补只能走云端转写。
//   - 丢帧间动作。快剪/打斗只能拿到事件骨架，拿不到连贯动作。
//   - 首帧必取 + 场景变化抽帧：静态口播会只有 1 帧，那也够了（画面本来就没信息）。

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const VIDEO_DEFAULTS = Object.freeze({
  // 只处理前 10 分钟：2 核机器上再长就纯属浪费 CPU，而且长视频后半段
  // 抽帧密度会被上限摊薄到「每 30 秒一帧」，再长也没意义。
  maxSeconds: 600,
  // 抽帧总上限。48 帧 × 4 列 = 3 张 16 格拼图，是「还能看清单帧」的上限；
  // 再多每格就小到认不出人了。
  maxFrames: 48,
  // 每张拼图的格数上限（4×4）。
  framesPerTile: 16,
  tileCols: 4,
  // 每格宽度。横屏 320（4 列 = 1280，正好对齐视觉模型的长边上限）；
  // 竖屏改用 240，否则 4 列 × 569 高会拼出一张 1280×1707 的长条。
  tileWidthLandscape: 320,
  tileWidthPortrait: 240,
  // 场景变化阈值，与 report-44 的实验参数一致。
  sceneThreshold: 0.35,
  // 抽帧是「解码整段视频」，比 GIF 那种几十帧的重得多，超时要给足。
  probeTimeoutMs: 20000,
  extractTimeoutMs: 150000,
  tileTimeoutMs: 40000
});

/** ffprobe 的 JSON 输出 → 我们关心的几个数。坏输入返回 null，不猜。 */
export function parseProbeJson(text) {
  let doc;
  try {
    doc = JSON.parse(String(text ?? ''));
  } catch {
    return null;
  }
  const stream = Array.isArray(doc?.streams) ? doc.streams.find((s) => s && s.codec_type !== 'audio') ?? doc.streams[0] : null;
  const durationRaw = stream?.duration ?? doc?.format?.duration;
  const durationSec = Number(durationRaw);
  if (!Number.isFinite(durationSec) || durationSec <= 0) return null;
  const width = Number(stream?.width) || 0;
  const height = Number(stream?.height) || 0;
  if (!width || !height) return null;
  return {
    durationSec,
    width,
    height,
    portrait: height > width,
    hasAudio: Array.isArray(doc?.streams) ? doc.streams.some((s) => s && s.codec_type === 'audio') : false
  };
}

/**
 * 规划怎么抽、怎么拼。纯函数，好测。
 * 真正的帧数要等 ffmpeg 跑完才知道（场景检测是内容驱动的），
 * 所以这里只决定「上限、格子宽度、列数、截断到多长」。
 */
export function planVideoTiles(info, limits = {}) {
  const cfg = { ...VIDEO_DEFAULTS, ...limits };
  const durationSec = Number(info?.durationSec) || 0;
  // portrait 可能在 info 上是现成的（probeVideo 会算），也可能调用方只给了宽高
  // —— 两种都得认，否则竖屏视频会被当成横屏，拼出一张又宽又矮的废图。
  const portrait = info?.portrait != null
    ? Boolean(info.portrait)
    : (Number(info?.height) > Number(info?.width));
  const capped = durationSec > cfg.maxSeconds;
  const effectiveSec = capped ? cfg.maxSeconds : durationSec;
  return {
    durationSec,
    effectiveSec,
    capped,
    portrait,
    maxFrames: cfg.maxFrames,
    framesPerTile: cfg.framesPerTile,
    cols: cfg.tileCols,
    tileWidth: portrait ? cfg.tileWidthPortrait : cfg.tileWidthLandscape,
    sceneThreshold: cfg.sceneThreshold,
    maxSeconds: cfg.maxSeconds
  };
}

/** 秒 → `3:07` / `1:02:30`。只用于给人看的时间范围标注。 */
export function timeLabel(sec) {
  const total = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 从 config / env 里找可执行文件；找到就返回路径，找不到返回 null（不抛）。 */
export function resolveTool(explicit, name) {
  const fromCfg = String(explicit ?? '').trim();
  if (fromCfg) return fromCfg;
  const envKey = name === 'ffprobe' ? 'FFPROBE_PATH' : 'FFMPEG_PATH';
  const fromEnv = String(process.env[envKey] ?? '').trim();
  if (fromEnv) return fromEnv;
  // 交给 PATH 解析：spawn('ffmpeg') 在多数发行版上就是对的，
  // 这里返回名字本身，让 spawn 去查 PATH。
  return name;
}

function run(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    const chunks = [];
    let settled = false;
    const settle = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let timer;
    try {
      // stdio: stdout 收（ffprobe 要 JSON），stderr 收一点用于报错，stdin 关掉。
      child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      settle({ ok: false, error: `无法启动 ${path.basename(cmd)}：${error?.message ?? error}` });
      return;
    }
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      settle({ ok: false, error: `${path.basename(cmd)} 超时（${Math.round(timeoutMs / 1000)}s）` });
    }, Math.max(1000, Number(timeoutMs) || 30000));
    timer.unref?.();
    child.stdout?.on('data', (b) => chunks.push(b));
    child.stderr?.on('data', (b) => {
      // 只留最后一小段，避免长视频把 stderr 收满内存。
      chunks.push(b.length > 1 ? b.subarray(0, 1) : b);
    });
    child.on('error', (error) => {
      settle({ ok: false, error: `找不到 ${path.basename(cmd)}（${error?.code ?? error?.message ?? error}）` });
    });
    child.on('close', (code) => {
      const text = Buffer.concat(chunks).toString('utf8');
      settle(code === 0 ? { ok: true, text } : { ok: false, error: `${path.basename(cmd)} 退出码 ${code}`, text });
    });
  });
}

/** 读视频的基本信息。读不出来就返回 {ok:false}，让调用方决定怎么说。 */
export async function probeVideo(file, opts = {}) {
  const ffprobe = resolveTool(opts.ffprobePath, 'ffprobe');
  const args = [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    String(file)
  ];
  const r = await run(ffprobe, args, { timeoutMs: opts.probeTimeoutMs ?? VIDEO_DEFAULTS.probeTimeoutMs });
  if (!r.ok) return { ok: false, error: r.error };
  const info = parseProbeJson(r.text);
  if (!info) return { ok: false, error: '读不出视频流（可能不是视频、或只有音轨）' };
  return { ok: true, info };
}

async function listFrameFiles(dir) {
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => /^f\d+\.jpg$/i.test(n))
    .sort((a, b) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')));
}

/**
 * 抽帧 + 拼图。产物是若干张 JPEG 的 Buffer。
 * 全程落盘，峰值内存只有「一帧几十 KB」和「一张拼图几百 KB」。
 */
export async function extractTiles(file, plan, opts = {}) {
  const ffmpeg = resolveTool(opts.ffmpegPath, 'ffmpeg');
  const workdir = await fsp.mkdtemp(path.join(opts.tmpDir || os.tmpdir(), 'qqvid-'));
  try {
    const frameDir = path.join(workdir, 'f');
    await fsp.mkdir(frameDir, { recursive: true });
    // 首帧必取（eq(n,0)）：纯静态视频（讲座、监控）场景检测一帧都不会有，
    // 不补这一条就会抽出 0 帧，最后什么也返回不了。
    const vf = [
      `select='eq(n\\,0)+gt(scene\\,${Number(plan.sceneThreshold) || 0.35})'`,
      `scale=${Number(plan.tileWidth) || 320}:-2`
    ].join(',');
    const extractArgs = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
      '-t', String(Math.max(1, Math.ceil(plan.effectiveSec))),
      '-i', String(file),
      '-vf', vf,
      '-vsync', 'vfr',
      '-frames:v', String(plan.maxFrames),
      '-q:v', '4',
      path.join(frameDir, 'f%03d.jpg')
    ];
    const ex = await run(ffmpeg, extractArgs, { timeoutMs: opts.extractTimeoutMs ?? VIDEO_DEFAULTS.extractTimeoutMs });
    if (!ex.ok) return { ok: false, error: `抽帧失败：${ex.error}` };

    let frames = await listFrameFiles(frameDir);
    let activeDir = frameDir;

    // 保底：场景检测只认「镜头切换」，长镜头、慢推镜、缓慢变化的画面会被漏掉
    // —— 实测一个 40 秒、每 10 秒换一次大面积着色的合成视频也只抽到 2 帧。
    // 帧数太少时改用均匀抽帧重跑一遍：这时要的是「时间轴上均匀取样」，
    // 不是「变化点」。只在真的不够时才跑，长视频不会白白多解码一遍。
    const minSceneFrames = Math.max(2, Number(opts.minSceneFrames) || 6);
    if (frames.length < minSceneFrames && plan.effectiveSec >= 20) {
      const evenDir = path.join(workdir, 'f2');
      await fsp.mkdir(evenDir, { recursive: true });
      const fps = Math.min(1, minSceneFrames / Math.max(1, plan.effectiveSec));
      const evenArgs = [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-t', String(Math.max(1, Math.ceil(plan.effectiveSec))),
        '-i', String(file),
        '-vf', `fps=${fps.toFixed(6)},scale=${Number(plan.tileWidth) || 320}:-2`,
        '-frames:v', String(minSceneFrames),
        '-q:v', '4',
        path.join(evenDir, 'f%03d.jpg')
      ];
      const ev = await run(ffmpeg, evenArgs, { timeoutMs: opts.extractTimeoutMs ?? VIDEO_DEFAULTS.extractTimeoutMs });
      if (ev.ok) {
        const again = await listFrameFiles(evenDir);
        if (again.length > frames.length) {
          frames = again;
          activeDir = evenDir;
        }
      }
    }
    if (!frames.length) return { ok: false, error: '抽帧结果为空' };

    const perTile = Math.max(1, Number(plan.framesPerTile) || 16);
    const cols = Math.max(1, Number(plan.cols) || 4);
    const tiles = [];
    const total = Math.ceil(frames.length / perTile);
    for (let i = 0; i < frames.length; i += perTile) {
      const batch = frames.slice(i, i + perTile);
      // 列数跟着这一批的实际帧数收：只有 2 帧却拼 4 列，会得到一张
      // 1300×188 的长条，右半边全黑——白白多占像素，单帧还更小。
      // 再优先找能整除帧数的列数：6 帧拼 4 列会空 2 格，改 3 列正好填满。
      const baseCols = Math.min(cols, Math.max(1, batch.length));
      let batchCols = baseCols;
      for (let c = baseCols; c >= 2; c -= 1) {
        if (batch.length % c === 0) { batchCols = c; break; }
      }
      const rows = Math.max(1, Math.ceil(batch.length / batchCols));
      const out = path.join(workdir, `tile${tiles.length + 1}.jpg`);
      const tileArgs = [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
        '-start_number', String(i + 1),
        '-i', path.join(activeDir, 'f%03d.jpg'),
        '-vf', `tile=${batchCols}x${rows}:padding=4:margin=4`,
        '-frames:v', '1',
        '-q:v', '4',
        out
      ];
      const tr = await run(ffmpeg, tileArgs, { timeoutMs: opts.tileTimeoutMs ?? VIDEO_DEFAULTS.tileTimeoutMs });
      if (!tr.ok) continue;
      let buffer;
      try {
        buffer = await fsp.readFile(out);
      } catch {
        continue;
      }
      if (!buffer?.length) continue;
      // 时间范围按「这批帧在全程里的相对位置」估：不是精确时间戳，
      // 但对「这段视频第 2 张大概是什么时候」够用了，而且不会假装精确。
      const from = (i / Math.max(1, frames.length)) * plan.effectiveSec;
      const to = ((i + batch.length) / Math.max(1, frames.length)) * plan.effectiveSec;
      tiles.push({
        buffer,
        index: tiles.length + 1,
        total,
        frames: batch.length,
        fromSec: from,
        toSec: to
      });
    }
    if (!tiles.length) return { ok: false, error: '拼图失败' };
    // total 是事后才知道的，回填一遍
    for (const t of tiles) t.total = tiles.length;
    return { ok: true, tiles, frameCount: frames.length };
  } finally {
    try {
      await fsp.rm(workdir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 主入口：视频文件 → { tiles: [{ buffer, label }] }。
 * 调用方拿到 buffer 之后走现成的图片管线（toModelMedia / transcribeMediaImages）。
 */
export async function normalizeVideoForModel(file, opts = {}) {
  const st = { ok: false };
  try {
    const s = await fsp.stat(file);
    if (!s.isFile()) return { ...st, error: '不是文件' };
    if (!s.size) return { ...st, error: '空文件' };
  } catch (error) {
    return { ...st, error: `读不到视频文件：${error?.message ?? error}` };
  }
  const probe = await probeVideo(file, opts);
  if (!probe.ok) return { ...st, error: probe.error };
  const plan = planVideoTiles(probe.info, opts.limits);
  const cut = await extractTiles(file, plan, opts);
  if (!cut.ok) return { ...st, error: cut.error, info: probe.info, plan };
  return {
    ok: true,
    info: probe.info,
    plan,
    frameCount: cut.frameCount,
    tiles: cut.tiles.map((t) => ({
      buffer: t.buffer,
      mimeType: 'image/jpeg',
      index: t.index,
      total: t.total,
      frames: t.frames,
      fromSec: t.fromSec,
      toSec: t.toSec,
      label: t.total > 1 ? `视频画面 ${t.index}/${t.total}` : '视频画面',
      rangeText: `${timeLabel(t.fromSec)}–${timeLabel(t.toSec)}`
    }))
  };
}
