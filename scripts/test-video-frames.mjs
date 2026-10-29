// video-frames.js 的单测。纯逻辑先断言，再（有 ffmpeg 时）真跑一个小视频。
//
// 跑法：node scripts/test-video-frames.mjs
// 本机没有 ffmpeg 在 PATH 上时，先设 FFMPEG_PATH / FFPROBE_PATH。

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  VIDEO_DEFAULTS,
  normalizeVideoForModel,
  parseProbeJson,
  planVideoTiles,
  probeVideo,
  timeLabel
} from '../src/video-frames.js';

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

console.log('[1] parseProbeJson');
check('横屏正常样本', () => {
  const r = parseProbeJson(JSON.stringify({
    streams: [
      { codec_type: 'video', width: 1920, height: 1080, duration: '125.4' },
      { codec_type: 'audio' }
    ],
    format: { duration: '125.5' }
  }));
  assert.equal(r.durationSec, 125.4);
  assert.equal(r.width, 1920);
  assert.equal(r.portrait, false);
  assert.equal(r.hasAudio, true);
});
check('竖屏判定', () => {
  const r = parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', width: 720, height: 1280, duration: '9' }] }));
  assert.equal(r.portrait, true);
});
check('duration 只在 format 上（流里没有）', () => {
  const r = parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 480 }], format: { duration: '77' } }));
  assert.equal(r.durationSec, 77);
});
check('坏 JSON → null', () => { assert.equal(parseProbeJson('not json'), null); });
check('没有 duration → null', () => {
  assert.equal(parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', width: 1, height: 1 }] })), null);
});
check('没有宽高 → null', () => {
  assert.equal(parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', duration: '10' }] })), null);
});
check('duration 是 0 / 负数 → null', () => {
  assert.equal(parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', width: 1, height: 1, duration: '0' }] })), null);
  assert.equal(parseProbeJson(JSON.stringify({ streams: [{ codec_type: 'video', width: 1, height: 1, duration: '-3' }] })), null);
});

console.log('[2] planVideoTiles');
check('横屏用 320 格宽', () => {
  const p = planVideoTiles({ durationSec: 60, width: 1920, height: 1080 });
  assert.equal(p.tileWidth, 320);
  assert.equal(p.capped, false);
  assert.equal(p.effectiveSec, 60);
});
check('竖屏用 240 格宽', () => {
  const p = planVideoTiles({ durationSec: 60, width: 720, height: 1280 });
  assert.equal(p.tileWidth, 240);
});
check('超 10 分钟截断', () => {
  const p = planVideoTiles({ durationSec: 3600, width: 1920, height: 1080 });
  assert.equal(p.capped, true);
  assert.equal(p.effectiveSec, VIDEO_DEFAULTS.maxSeconds);
  assert.equal(p.durationSec, 3600);
});
check('刚好 10 分钟不算截断', () => {
  const p = planVideoTiles({ durationSec: 600, width: 1920, height: 1080 });
  assert.equal(p.capped, false);
});
check('上限可被覆盖', () => {
  const p = planVideoTiles({ durationSec: 100, width: 16, height: 9 }, { maxFrames: 8, framesPerTile: 4, tileCols: 2 });
  assert.equal(p.maxFrames, 8);
  assert.equal(p.framesPerTile, 4);
  assert.equal(p.cols, 2);
});
check('durationSec 缺失不炸', () => {
  const p = planVideoTiles({ width: 100, height: 100 });
  assert.equal(p.effectiveSec, 0);
});

console.log('[3] timeLabel');
check('分秒', () => assert.equal(timeLabel(187), '3:07'));
check('小时', () => assert.equal(timeLabel(3750), '1:02:30'));
check('零', () => assert.equal(timeLabel(0), '0:00'));
check('负数/NaN 当 0', () => {
  assert.equal(timeLabel(-5), '0:00');
  assert.equal(timeLabel(undefined), '0:00');
});

// ---- 以下要真 ffmpeg；没有就跳过，不假装通过 ----
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore' }).status === 0;

if (!hasFfmpeg) {
  console.log('[4] 真视频（跳过：找不到 ffmpeg）');
} else {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqvidtest-'));
  const sample = path.join(tmp, 'sample.mp4');
  const gen = spawnSync(ffmpeg, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=10:size=640x360:rate=10',
    '-pix_fmt', 'yuv420p', sample
  ], { stdio: 'ignore' });
  if (gen.status !== 0) {
    console.log('[4] 真视频（跳过：造样本失败）');
  } else {
    await checkAsync('probeVideo 读到 10 秒', async () => {
      const r = await probeVideo(sample);
      assert.equal(r.ok, true, r.error);
      assert.ok(Math.abs(r.info.durationSec - 10) < 1.5, `duration=${r.info.durationSec}`);
      assert.equal(r.info.width, 640);
      assert.equal(r.info.portrait, false);
    });
    await checkAsync('抽帧拼图产出非空 JPEG', async () => {
      const r = await normalizeVideoForModel(sample);
      assert.equal(r.ok, true, r.error);
      assert.ok(r.tiles.length >= 1, '至少一张');
      assert.ok(r.frameCount >= 1, '至少一帧');
      for (const t of r.tiles) {
        assert.equal(t.mimeType, 'image/jpeg');
        assert.ok(t.buffer.length > 500, `图太小 ${t.buffer.length}`);
        // JPEG 魔数
        assert.equal(t.buffer[0], 0xff);
        assert.equal(t.buffer[1], 0xd8);
        assert.ok(t.label.includes('视频画面'));
        assert.match(t.rangeText, /^\d+:\d{2}–\d+:\d{2}$/);
      }
    });
    await checkAsync('纯静态视频也有帧（首帧必取）', async () => {
      const still = path.join(tmp, 'still.mp4');
      const g = spawnSync(ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=navy:s=320x240:d=3',
        '-pix_fmt', 'yuv420p', still
      ], { stdio: 'ignore' });
      if (g.status !== 0) return;
      const r = await normalizeVideoForModel(still);
      assert.equal(r.ok, true, r.error);
      assert.ok(r.frameCount >= 1, '静态视频必须至少 1 帧');
    });
    await checkAsync('不存在的文件 → 干净失败', async () => {
      const r = await normalizeVideoForModel(path.join(tmp, 'nope.mp4'));
      assert.equal(r.ok, false);
      assert.ok(r.error);
    });
    await checkAsync('临时目录被清掉', async () => {
      const before = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('qqvid-')).length;
      await normalizeVideoForModel(sample);
      const after = (await fsp.readdir(os.tmpdir())).filter((n) => n.startsWith('qqvid-')).length;
      assert.equal(after, before, '工作目录没清理干净');
    });
  }
  try { await fsp.rm(tmp, { recursive: true, force: true }); } catch {}
  void fs;
}

console.log(`\n通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
