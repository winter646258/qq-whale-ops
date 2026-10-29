/**
 * 看一个 B 站视频 —— bili-watch.js
 *
 * 把「刷到一条视频」变成「真的看见画面」：
 *   详情（拿 cid）→ playurl 选档 → 直读 URL 抽帧（失败才整片下载）
 *
 * 为什么直读：ffmpeg 能直接吃 http URL 并发 Range 请求，配 `-t 45` 只拉前 45 秒。
 * 实测 2033 秒的片子看前 45 秒 —— ffprobe 354ms + 抽帧 1110ms；要是先整片下载，
 * 503kbps × 2033s ≈ 128MB，光下载就几十秒。所以下载只是兜底路径。
 *
 * 为什么不直接把它塞给模型：
 *   deepseek 不吃视频，dots-studio 只吃图，服务器 1736MB 内存也扛不住原片。
 *   所以唯一的看画面方式就是抽帧拼图（report-44 的结论，本机实测确认）。
 *
 * 实测数据（2026-10-29，这台 2 核 1736MB 机器）：
 *   8 分 57 秒 / 640x360 / 17.5MB → 下载 707ms + 抽帧 16.4s → 29 帧 / 2 张图（144KB + 108KB）
 *   拼图里枪械、地图、爆炸都看得清，字也能读。
 *
 * 这个模块只管「拿到图」，不判断该不该看、也不送给哪个模型 —— 那些是调用方的事。
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { normalizeVideoForModel } from './video-frames.js';
import { pickVideoStream, describeStream, DIRECT_UA } from './bili-direct.js';
import { fmtDuration, fmtCount } from './site-bili.js';

/** 直读 CDN 必须带的头，少一个就 403。 */
const STREAM_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent': DIRECT_UA
};

export const WATCH_DEFAULTS = {
  /** 只抽前 N 秒。超长视频（2 小时 43 分那种）看开头就够判断「这是啥」了。 */
  maxSeconds: 600,
  /** 下载上限。低于这个值以上直接放弃，别为一个视频吃掉 500MB 可用内存。 */
  maxBytes: 64 * 1024 * 1024,
  /** 转发给 video-frames 的抽帧参数（不传就用它自己的默认） */
  maxFrames: undefined,
  framesPerTile: undefined
};

/**
 * 直连拿视频详情。`/x/web-interface/view` 在直连下是通的（走桥反而 412），
 * 而且只有它给 cid —— playurl 没 cid 就没法取流。
 */
export async function fetchVideoDetail(direct, bvid) {
  const id = String(bvid ?? '').trim();
  if (!/^BV[0-9A-Za-z]{10}$/.test(id)) throw new Error(`不是合法的 BV 号：${id}`);
  const res = await direct.request({
    url: `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(id)}`
  });
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    throw new Error(`视频详情返回的不是 JSON（HTTP ${res.status}）：${String(res.body).slice(0, 160)}`);
  }
  if (json?.code !== 0) {
    throw new Error(`视频详情报错 ${json?.code}：${json?.message ?? '未知'}`);
  }
  const d = json.data ?? {};
  return {
    bvid: id,
    aid: Number(d.aid ?? 0),
    cid: Number(d.cid ?? 0),
    title: String(d.title ?? '').replace(/\s+/g, ' ').trim(),
    author: String(d.owner?.name ?? ''),
    mid: Number(d.owner?.mid ?? 0),
    desc: String(d.desc ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
    durationSec: Number(d.duration ?? 0),
    view: Number(d.stat?.view ?? 0),
    like: Number(d.stat?.like ?? 0),
    danmaku: Number(d.stat?.danmaku ?? 0),
    pubdate: Number(d.pubdate ?? 0),
    pic: String(d.pic ?? ''),
    tname: String(d.tname ?? '')
  };
}

/**
 * 看一条视频。永不 throw —— 失败一律 `{ok:false, error}`，和 video-frames 风格一致。
 *
 * @param {object} opts
 * @param {object} opts.direct createBiliDirect() 的返回值
 * @param {string} opts.bvid
 * @param {number} [opts.maxSeconds]
 * @param {number} [opts.maxBytes]
 * @param {number} [opts.maxFrames]
 * @param {number} [opts.framesPerTile]
 * @param {Function} [opts.log]
 */
export async function watchBiliVideo(opts = {}) {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const direct = opts.direct;
  const maxSeconds = Number(opts.maxSeconds) || WATCH_DEFAULTS.maxSeconds;
  const maxBytes = Number(opts.maxBytes) || WATCH_DEFAULTS.maxBytes;

  if (!direct || typeof direct.request !== 'function') {
    return { ok: false, error: '没有直连出口（direct 没传）' };
  }
  const bvid = String(opts.bvid ?? '').trim();
  if (!bvid) return { ok: false, error: '没给 bvid' };

  let tmpFile = '';
  try {
    // 1) 详情
    const meta = await fetchVideoDetail(direct, bvid);
    if (!meta.cid) return { ok: false, error: `拿不到 cid（${bvid}），没法取播放流`, video: meta };
    if (!meta.durationSec) return { ok: false, error: '视频时长是 0，可能还没转码好', video: meta };
    log(`[bili-watch] ${bvid} 《${meta.title.slice(0, 30)}》 ${meta.durationSec}s cid=${meta.cid}`);

    // 2) 播放地址 → 挑一档
    const pu = await direct.playurl(bvid, meta.cid);
    const stream = pickVideoStream(pu?.dash, { maxBandwidth: opts.maxBandwidth });
    if (!stream) {
      return { ok: false, error: '没有可用的视频流（可能需要登录才能看，比如番剧/付费内容）', video: meta };
    }
    log(`[bili-watch] 选中 ${describeStream(stream)}`);

    // 3) 抽帧：默认直读 URL，ffmpeg 自己发 Range 请求、配 -t 只拉前 N 秒。
    //    直读失败（CDN 不给 Range、moov 在尾部的变体、网络抖动）才退回整片下载。
    const cutOpts = { maxSeconds };
    if (opts.maxFrames) cutOpts.maxFrames = Number(opts.maxFrames);
    if (opts.framesPerTile) cutOpts.framesPerTile = Number(opts.framesPerTile);

    let cut = null;
    let mode = 'stream';
    let buf = null;
    if (opts.stream !== false) {
      const r = await normalizeVideoForModel(stream.url, {
        ...cutOpts,
        remote: true,
        headers: STREAM_HEADERS
      });
      if (r.ok) {
        cut = r;
        log(`[bili-watch] 直读抽帧 ${cut.frameCount} 帧 / ${cut.tiles.length} 张 / ${Date.now() - t0}ms`);
      } else {
        log(`[bili-watch] 直读失败（${r.error}），退回整片下载`);
      }
    }

    // 4) 兜底：整片下载到临时文件再抽
    if (!cut) {
      mode = 'download';
      buf = await direct.download(stream.url, { maxBytes });
      log(`[bili-watch] 下载 ${(buf.length / 1048576).toFixed(1)}MB / ${Date.now() - t0}ms`);
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bili-watch-'));
      tmpFile = path.join(dir, `${crypto.randomUUID()}.mp4`);
      await fs.writeFile(tmpFile, buf);
      cut = await normalizeVideoForModel(tmpFile, cutOpts);
      if (!cut.ok) {
        return { ok: false, error: `抽帧失败：${cut.error}`, video: meta, stream };
      }
      log(`[bili-watch] 抽帧 ${cut.frameCount} 帧 / ${cut.tiles.length} 张 / ${Date.now() - t0}ms`);
    }

    // 6) 清理
    try {
      await fs.rm(dir, { recursive: true, force: true });
      tmpFile = '';
    } catch {
      // 清不掉也无所谓，/tmp 有系统回收
    }

    const coveredTo = cut.tiles.length ? cut.tiles[cut.tiles.length - 1].toSec : 0;
    const covered = cut.tiles.length
      ? `${Math.round(cut.tiles[0].fromSec)}–${Math.round(coveredTo)} 秒`
      : '';
    // 直读时 ffprobe 报的是全片时长（-t 只作用于抽帧），所以按「实际覆盖到哪」判断。
    const truncated = coveredTo > 0 && coveredTo < meta.durationSec - 2;

    const summaryText = [
      `「${meta.title}」`,
      `up：${meta.author} · ${fmtCount(meta.view)}播放 · ${fmtDuration(meta.durationSec)}`,
      meta.desc ? `简介：${meta.desc.slice(0, 160)}` : '',
      `画面 ${cut.tiles.length} 张 / ${cut.frameCount} 帧${covered ? `，覆盖 ${covered}` : ''}${truncated ? `（只看了前 ${Math.round(coveredTo)} 秒）` : ''}`
    ].filter(Boolean).join('\n');

    return {
      ok: true,
      video: meta,
      stream: {
        width: stream.width,
        height: stream.height,
        codec: stream.codec,
        bandwidth: stream.bandwidth
      },
      mode,
      bytes: buf ? buf.length : null,
      videoInfo: cut.info,
      frameCount: cut.frameCount,
      tiles: cut.tiles,
      elapsedMs: Date.now() - t0,
      summaryText
    };
  } catch (error) {
    if (tmpFile) {
      try {
        await fs.rm(path.dirname(tmpFile), { recursive: true, force: true });
      } catch {
        // 忽略
      }
    }
    return { ok: false, error: `看视频失败：${error?.message ?? error}`, elapsedMs: Date.now() - t0 };
  }
}
