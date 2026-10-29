// 端到端验证：safeFetchRaw 下载真视频 → 落盘 → 抽帧拼图。
//
// 跑法：node scripts/probe-video-e2e.mjs <https://.../x.mp4> [输出目录]
//
// 只验证「取字节 + 抽帧」这一段；bridge 里的接线要等真实的 QQ 视频段才能验。
// 顺带证明 SSRF 防护对私网地址依然是拦的 —— 那才是 safeFetchRaw 敢复用的底气。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { safeFetchRaw } from '../src/safe-fetch.js';
import { normalizeVideoForModel } from '../src/video-frames.js';

const url = process.argv[2];
const outDir = process.argv[3] || '/tmp/video-e2e';
if (!url) {
  console.error('用法：node scripts/probe-video-e2e.mjs <url> [输出目录]');
  process.exit(2);
}

// ---- 1) 私网地址必须被拒：这是 safeFetchRaw 复用 safe-fetch 的前提 ----
console.log('[1] SSRF 防护自检');
try {
  await safeFetchRaw('http://127.0.0.1:3000/anything.mp4', 1024 * 1024);
  console.log('  FAIL 私网地址竟然放行了');
  process.exit(1);
} catch (error) {
  console.log(`  ok   私网地址被拒：${error?.message ?? error}`);
}

// ---- 2) 公网取字节 ----
console.log('[2] 下载');
const t0 = Date.now();
let fetched;
try {
  fetched = await safeFetchRaw(url, 48 * 1024 * 1024);
} catch (error) {
  console.log(`  FAIL 下载失败：${error?.message ?? error}`);
  process.exit(1);
}
const kb = Math.round(fetched.buffer.length / 1024);
console.log(`  ok   ${kb}KB，HTTP ${fetched.statusCode}，用时 ${Date.now() - t0}ms`);

const head = fetched.buffer.subarray(0, 12).toString('hex');
console.log(`  头 12 字节 ${head}`);

// ---- 3) 抽帧拼图 ----
console.log('[3] 抽帧拼图');
const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'qqvide2e-'));
const file = path.join(tmp, 'v.bin');
await fsp.writeFile(file, fetched.buffer);
const t1 = Date.now();
const out = await normalizeVideoForModel(file);
if (!out.ok) {
  console.log(`  FAIL ${out.error}`);
  await fsp.rm(tmp, { recursive: true, force: true });
  process.exit(1);
}
console.log(`  ok   ${out.frameCount} 帧 → ${out.tiles.length} 张，用时 ${Date.now() - t1}ms`);
console.log(`  探针：${JSON.stringify(out.probe ?? {})}`);
let totalKb = 0;
await fsp.mkdir(outDir, { recursive: true });
for (const t of out.tiles) {
  totalKb += t.buffer.length / 1024;
  const p = path.join(outDir, `tile${t.index}.jpg`);
  await fsp.writeFile(p, t.buffer);
  console.log(`  ${t.label} ${t.rangeText}  ${Math.round(t.buffer.length / 1024)}KB  ${p}`);
}
console.log(`  拼图合计 ${Math.round(totalKb)}KB`);
await fsp.rm(tmp, { recursive: true, force: true });
void fs;
