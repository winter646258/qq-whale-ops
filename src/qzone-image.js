// 说说配图的路径问题：SnowLuma 跑在容器里，看不到宿主机的 /opt/qq-bridge/state/images。
// 它自己的 send_qzone_msg 明明写着「支持 file:// http:// base64://」，所以最省事的办法是
// 桥接这边把本地文件读成 base64 递过去 —— 和发 QQ 消息走 base64 是同一个思路，
// 不用重建容器、不用挂卷、也不用 docker cp。
import fs from 'node:fs';
import path from 'node:path';

export const QZONE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const QZONE_IMAGE_MAX_COUNT = 9;

// 已经是「对面能直接吃」的形式，原样传下去
const PASSTHROUGH = /^(base64:\/\/|data:|https?:\/\/)/i;

/**
 * 把调用方给的图片路径整理成 send_qzone_msg 能接受的形式。
 * @param {string[]} images
 * @param {object} opts imageDir=允许的根目录（state/images），maxBytes/maxCount 上限，其余为测试注入点
 * @returns {string[]} 每项要么是 base64://…，要么是原样的 http(s)/data/base64
 */
export function prepareQzoneImages(images, {
  imageDir = '',
  stateDir = '',
  maxBytes = QZONE_IMAGE_MAX_BYTES,
  maxCount = QZONE_IMAGE_MAX_COUNT,
  readFile = fs.readFileSync,
  exists = fs.existsSync,
  stat = fs.statSync,
  isAbsolute = path.isAbsolute,
  resolve = path.resolve,
  sep = path.sep,
  basename = path.basename,
} = {}) {
  const list = Array.isArray(images)
    ? images.map((v) => String(v ?? '').trim()).filter(Boolean).slice(0, maxCount)
    : [];
  if (!list.length) return [];

  const root = String(imageDir ?? '').replace(/[\\/]+$/, '') + sep;
  const out = [];
  for (const raw of list) {
    if (PASSTHROUGH.test(raw)) {
      out.push(raw);
      continue;
    }
    let rel = raw.startsWith('file://') ? raw.slice('file://'.length) : raw;
    // 她常按提示词写 "state/images/xxx.png" 这种「相对仓库根」的路径，把那截前缀去掉再看相对名
    const fromState = rel.replace(/^\.?[\\/]*(state[\\/]+images[\\/]+)/i, '');
    const candidates = isAbsolute(rel)
      ? [rel]
      : [
          resolve(imageDir || '.', fromState),
          resolve(imageDir || '.', rel),
          ...(stateDir ? [resolve(stateDir, rel)] : []),
        ];
    const abs = candidates.find((p) => exists(p));
    if (!abs) throw new Error(`配图不存在：${basename(rel)}`);
    // 只认 state/images 里面的文件：别让这个口子变成任意文件的外发通道
    if (root !== sep && !abs.startsWith(root)) {
      throw new Error(`配图只能用 state/images 下的文件：${raw}`);
    }
    const size = Number(stat(abs).size) || 0;
    if (size > maxBytes) {
      throw new Error(`配图太大（${(size / 1048576).toFixed(1)}MB），上限 ${Math.round(maxBytes / 1048576)}MB`);
    }
    out.push('base64://' + Buffer.from(readFile(abs)).toString('base64'));
  }
  return out;
}
