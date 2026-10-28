#!/usr/bin/env node
// 说说配图：本地路径 → base64:// 的守卫。
// 为什么值得一条用例：这不是「顺手优化」，是那只 ENOENT 的正解 ——
// SnowLuma 在容器里 stat 宿主机的 state/images，永远 stat 不到。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { prepareQzoneImages, QZONE_IMAGE_MAX_COUNT } from '../src/qzone-image.js';

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass += 1;
  console.log('  ✓', msg);
};
const throws = (fn, re, msg) => {
  assert.throws(fn, re, msg);
  pass += 1;
  console.log('  ✓', msg);
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qz-'));
const imageDir = dir;
const small = path.join(dir, 'img-1.png');
const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
fs.writeFileSync(small, bytes);
fs.writeFileSync(path.join(dir, 'img-2.png'), bytes);
const outside = path.join(os.tmpdir(), 'not-in-image-dir.png');
fs.writeFileSync(outside, bytes);

console.log('· 基本形态');
ok(Array.isArray(prepareQzoneImages([])) && prepareQzoneImages([]).length === 0, '空数组 → 空');
ok(prepareQzoneImages(null).length === 0, 'null → 空');
ok(prepareQzoneImages(['  ', '']).length === 0, '空白项被过滤');

console.log('· 直通形式');
ok(prepareQzoneImages(['base64://AAAA'], { imageDir })[0] === 'base64://AAAA', 'base64:// 原样');
ok(prepareQzoneImages(['https://a/b.png'], { imageDir })[0] === 'https://a/b.png', 'http(s) 原样');
ok(prepareQzoneImages(['data:image/png;base64,AAA'], { imageDir })[0].startsWith('data:'), 'data: 原样');

console.log('· 本地文件 → base64');
{
  const [one] = prepareQzoneImages([small], { imageDir });
  ok(one.startsWith('base64://'), '绝对路径变成 base64://');
  const back = Buffer.from(one.slice('base64://'.length), 'base64');
  ok(back.equals(bytes), '解码回来的字节和原文件一致');
}
{
  const [one] = prepareQzoneImages(['img-2.png'], { imageDir });
  ok(Buffer.from(one.slice('base64://'.length), 'base64').equals(bytes), '相对路径按 imageDir 解析');
}
{
  const [one] = prepareQzoneImages(['file://' + small], { imageDir });
  ok(one.startsWith('base64://'), 'file:// 前缀也会读成 base64');
}
{
  // 她按提示词常写成 "state/images/xxx.png"，那截前缀要去掉再按 imageDir 找
  const [one] = prepareQzoneImages(['state/images/img-2.png'], { imageDir, stateDir: path.dirname(imageDir) });
  ok(Buffer.from(one.slice('base64://'.length), 'base64').equals(bytes), 'state/images/xxx.png 这种写法也认');
}

console.log('· 边界与拒绝');
throws(() => prepareQzoneImages([outside], { imageDir }), /state\/images/, '根目录外的文件被拒绝');
throws(() => prepareQzoneImages([path.join(dir, 'nope.png')], { imageDir }), /配图不存在/, '不存在的文件报清楚');
throws(
  () => prepareQzoneImages([small], { imageDir, maxBytes: 1 }),
  /配图太大/,
  '超过字节上限被拒绝（1 字节上限）'
);
{
  const many = Array.from({ length: 12 }, (_, i) => `img-${i}.png`);
  fs.writeFileSync(path.join(dir, 'img-10.png'), bytes);
  const out = prepareQzoneImages(many.map((n) => (n === 'img-10.png' ? small : path.join(dir, 'img-2.png'))), { imageDir });
  ok(out.length === QZONE_IMAGE_MAX_COUNT, `最多 ${QZONE_IMAGE_MAX_COUNT} 张（实到 ${out.length}）`);
}

fs.rmSync(dir, { recursive: true, force: true });
try { fs.rmSync(outside, { force: true }); } catch {}

console.log(`\n全部通过：${pass} 项`);
