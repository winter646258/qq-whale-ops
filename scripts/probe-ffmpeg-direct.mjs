// 验证：ffmpeg / ffprobe 能不能直接吃 B 站 CDN 的 URL，跳过「先整片下载」。
// 用法：node scripts/probe-ffmpeg-direct.mjs [bvid] [秒数]
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createBiliDirect } from '../src/bili-direct.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    execFile(bin, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, ms: Date.now() - t0, stdout: stdout || '', stderr: (stderr || '').slice(-900) });
    });
  });
}

const bvid = process.argv[2] || 'BV1CxxE6tEiq';
const secs = Number(process.argv[3] || 45);

const direct = createBiliDirect({ stateFile: '/opt/qq-bridge/state/bili-cookie.json', log: () => {} });

const d = await direct.request({ url: `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}` });
const info = JSON.parse(d.body);
if (info.code !== 0) {
  console.log('view FAIL', info.code, info.message);
  process.exit(1);
}
console.log('标题:', info.data.title);
console.log('时长:', info.data.duration, '秒  cid:', info.data.cid);

const pu = await direct.playurl(bvid, info.data.cid, { qn: 32 });
const list = pu?.dash?.video || [];
const avc = list.filter((x) => String(x.codecs).includes('avc1')).sort((a, b) => b.bandwidth - a.bandwidth);
const pick = avc[0] || list[0];
if (!pick) {
  console.log('没有视频流');
  process.exit(1);
}
const url = pick.baseUrl || pick.base_url;
console.log(`流: ${pick.width}x${pick.height} ${pick.codecs} ${(pick.bandwidth / 1024).toFixed(0)}kbps`);
console.log('URL 前缀:', url.slice(0, 90) + '…');

const headers = `Referer: https://www.bilibili.com/\r\nUser-Agent: ${UA}\r\n`;
const dir = '/tmp/ffdirect';
await fs.rm(dir, { recursive: true, force: true });
await fs.mkdir(dir, { recursive: true });

// A) ffprobe 直读元数据
const p = await run(
  'ffprobe',
  ['-v', 'error', '-show_entries', 'format=duration:stream=width,height,codec_name', '-of', 'json', '-headers', headers, '-i', url],
  30000
);
console.log('\n=== A) ffprobe 直读 ===', p.ok ? 'OK' : 'FAIL', p.ms + 'ms');
console.log((p.stdout || p.stderr || '').replace(/\s+/g, ' ').slice(0, 300));

// B) ffmpeg 直读抽帧（-t 放在 -i 前面 = 输入只读这么多就断开）
const t0 = Date.now();
const f = await run(
  'ffmpeg',
  [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-y',
    '-headers', headers,
    '-t', String(secs),
    '-i', url,
    '-vf', "select='eq(n\\,0)+gt(scene\\,0.35)',scale=320:-2",
    '-vsync', 'vfr',
    '-frames:v', '16',
    `${dir}/f%03d.jpg`
  ],
  120000
);
const files = (await fs.readdir(dir)).filter((n) => /^f\d+\.jpg$/.test(n)).sort();
let total = 0;
for (const n of files) total += (await fs.stat(`${dir}/${n}`)).size;
console.log('\n=== B) ffmpeg 直读抽帧 ===', f.ok ? 'OK' : 'FAIL', Date.now() - t0 + 'ms');
console.log('帧数:', files.length, '字节:', total);
if (!f.ok) console.log('stderr:', f.stderr);
