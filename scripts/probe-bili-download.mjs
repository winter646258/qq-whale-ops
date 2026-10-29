// 实验第二步：B 站视频流能不能下载、能不能喂给 video-frames 抽帧拼图？
//
// 上一轮已经证明：buvid3 + WBI 能在服务器直连拿到推荐流、详情、playurl。
// 这一轮验证最后一环 —— playurl 给的 upos CDN 地址带 Referer 能不能下到字节，
// 下到的字节能不能直接交给 src/video-frames.js 抽出拼图。
//
// 如果这一环通了，「自己刷视频」的能力闭环就齐了：
//   推荐流 → 挑一条 → 详情 → playurl → 下载 → 抽帧拼图 → 模型看

import { signWbi, keyFromUrl } from '../src/site-bili.js';
import { normalizeVideoForModel, VIDEO_DEFAULTS } from '../src/video-frames.js';
import { writeFileSync, mkdirSync, statSync } from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JSON_HEADERS = {
  'user-agent': UA,
  'accept': 'application/json, text/plain, */*',
  'referer': 'https://www.bilibili.com/',
  'origin': 'https://www.bilibili.com'
};

const spi = await (await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: JSON_HEADERS })).json();
const COOKIE = `buvid3=${spi.data.b_3}; buvid4=${spi.data.b_4}`;
const nav = await (await fetch('https://api.bilibili.com/x/web-interface/nav', { headers: { ...JSON_HEADERS, cookie: COOKIE } })).json();
const imgKey = keyFromUrl(nav?.data?.wbi_img?.img_url);
const subKey = keyFromUrl(nav?.data?.wbi_img?.sub_url);

const feed = await (await fetch(
  `https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${new URLSearchParams(signWbi({ ps: 10, fresh_type: 3, feed_version: 'V8' }, imgKey, subKey))}`,
  { headers: { ...JSON_HEADERS, cookie: COOKIE } }
)).json();

// 挑一条短一点的，别为了实验下几十 MB
const picks = (feed?.data?.item ?? []).filter((it) => it?.bvid && Number(it?.duration) > 0);
const target = picks.find((it) => Number(it.duration) <= 300) ?? picks[0];
console.log(`选中：${target.bvid} ${target.duration}s 《${String(target.title).slice(0, 40)}》`);

const view = await (await fetch(
  `https://api.bilibili.com/x/web-interface/view?bvid=${target.bvid}`,
  { headers: { ...JSON_HEADERS, cookie: COOKIE } }
)).json();
const cid = view?.data?.cid;
console.log(`cid=${cid} aid=${view?.data?.aid}`);

// 关键：fnval=16 要 DASH；qn 给低一点，480p 够抽帧用
const pu = await (await fetch(
  `https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(signWbi({ bvid: target.bvid, cid, qn: 32, fnval: 16, fourk: 0 }, imgKey, subKey))}`,
  { headers: { ...JSON_HEADERS, cookie: COOKIE } }
)).json();

const dash = pu?.data?.dash;
if (!dash?.video?.length) {
  console.log(`没有 dash 数据：${JSON.stringify(pu).slice(0, 300)}`);
  process.exit(1);
}
// 挑最小的一档，实验只要验证「下得下来」
const vids = [...dash.video].sort((a, b) => (a.bandwidth ?? 0) - (b.bandwidth ?? 0));
const v = vids[0];
const url = v.baseUrl ?? v.base_url;
console.log(`选最低档：${v.width}x${v.height} bw=${v.bandwidth} codecs=${v.codecs}`);
console.log(`地址主机：${new URL(url).host}`);

// ---- 下载：带 Referer，这是 upos 的硬要求 ----
const t0 = Date.now();
const r = await fetch(url, {
  headers: {
    'user-agent': UA,
    'referer': 'https://www.bilibili.com/',
    'origin': 'https://www.bilibili.com',
    'accept': '*/*',
    'accept-language': 'zh-CN,zh;q=0.9',
    'range': 'bytes=0-'
  }
});
console.log(`下载 HTTP ${r.status} ${r.headers.get('content-type')} range=${r.headers.get('content-range') ?? '(无)'}`);
if (r.status !== 200 && r.status !== 206) {
  console.log(`下载被拒：${(await r.text()).slice(0, 200)}`);
  process.exit(1);
}
const buf = Buffer.from(await r.arrayBuffer());
console.log(`拿到 ${buf.length} 字节，耗时 ${Date.now() - t0}ms`);
if (buf.length < 20000) {
  console.log(`太小了，不像视频：${buf.subarray(0, 200).toString('utf8').slice(0, 200)}`);
  process.exit(1);
}
// ftyp 检查
const head = buf.subarray(0, 32).toString('latin1');
console.log(`文件头（ASCII）：${head.replace(/[^\x20-\x7e]/g, '.')}`);

const dir = '/tmp/bili-probe';
mkdirSync(dir, { recursive: true });
const file = `${dir}/${target.bvid}.m4s`;
writeFileSync(file, buf);
console.log(`落盘 ${file} ${statSync(file).size} 字节`);

// ---- 抽帧：直接喂给已经上线的 video-frames.js ----
console.log('\n--- 交给 video-frames 抽帧 ---');
console.log(`默认参数：${JSON.stringify(VIDEO_DEFAULTS)}`);
const t1 = Date.now();
const out = await normalizeVideoForModel(file, { maxFrames: 24, framesPerTile: 12 });
console.log(`抽帧耗时 ${Date.now() - t1}ms`);
if (!out.ok) {
  console.log(`抽帧失败：${out.error}`);
  process.exit(1);
}
console.log(`info: ${JSON.stringify(out.info)}`);
console.log(`plan: ${JSON.stringify(out.plan)}`);
console.log(`frameCount=${out.frameCount}  tiles=${out.tiles.length}`);
for (const t of out.tiles) {
  const p = `${dir}/${target.bvid}-tile${t.index}.jpg`;
  writeFileSync(p, t.buffer);
  console.log(`  ${t.label}  ${t.rangeText}  ${t.buffer.length} 字节  ${t.frames} 帧  640x360 → ${p}`);
}
console.log('\nOK 全链路通');
