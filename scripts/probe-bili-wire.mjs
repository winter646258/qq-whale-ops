// 接线验证：模块层的 recommend + watch 能不能真跑起来（不经过 bridge 的 HTTP 层）。
import { createBiliDirect } from '../src/bili-direct.js';
import { BiliClient, describeBiliResult } from '../src/site-bili.js';
import { watchBiliVideo } from '../src/bili-watch.js';

const log = (m) => console.log(m);
const direct = createBiliDirect({
  stateFile: '/opt/qq-bridge/state/bili-cookie.json',
  log
});
const client = new BiliClient({ direct, log });

console.log('=== egress 类型 ===');
console.log(client.egress()?.kind);

console.log('\n=== recommend(5) ===');
const list = await client.recommend(5);
console.log(describeBiliResult('recommend', list));

console.log('\n=== videoDetail（直连走 view，要拿到 cid） ===');
const first = list[0];
const detail = await client.videoDetail(first.bvid);
console.log(`cid=${detail.cid} aid=${detail.aid} 时长=${detail.duration} 分P=${detail.pageCount}`);
console.log(describeBiliResult('video', detail));

// 挑一条短的看，省时间
const short = list.filter((v) => v.duration > 20 && v.duration <= 240)[0] ?? first;
console.log(`\n=== watchBiliVideo(${short.bvid}, ${short.duration}s) ===`);
const t0 = Date.now();
const r = await watchBiliVideo({ direct, bvid: short.bvid, maxSeconds: 180, maxFrames: 12, log });
if (!r.ok) {
  console.log(`FAIL: ${r.error}`);
  process.exit(1);
}
console.log(r.summaryText);
console.log(`\n耗时 ${Date.now() - t0}ms / 下载 ${(r.bytes / 1048576).toFixed(1)}MB / ${r.tiles.length} 张图`);
for (const t of r.tiles) {
  console.log(`  ${t.label} ${t.rangeText} ${t.buffer.length} 字节 ${t.frames} 帧`);
  const p = `/tmp/bili-probe/wire-${t.index}.jpg`;
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync('/tmp/bili-probe', { recursive: true });
  writeFileSync(p, t.buffer);
  console.log(`    → ${p}`);
}
console.log('\nOK 接线验证通过');
