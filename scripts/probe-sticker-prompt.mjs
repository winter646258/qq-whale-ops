// 验证「学了看得见」：用真实库 + 真实 config 跑 buildStickerContext。
// 注意提示词里只有 desc/localNote，没有 id —— 所以按 desc 匹配，不是按 id。
import fs from 'node:fs';
import { buildStickerContext } from '../src/sticker-lib.js';

const ROOT = '/opt/qq-bridge';
const lib = JSON.parse(fs.readFileSync(`${ROOT}/state/stickers.json`, 'utf8'));
const cfg = JSON.parse(fs.readFileSync(`${ROOT}/config.json`, 'utf8'));
const sc = cfg.socialV2?.sticker ?? {};
const allowIds = Array.isArray(sc.allowIds) ? sc.allowIds : [];
const max = Number(sc.promptMaxStickers) || 8;

console.log(`库 ${lib.length} 条；白名单 ${allowIds.length} 张；promptMaxStickers ${max}`);
const text = buildStickerContext(lib, max, { allowIds });
console.log(`提示词 ${text.length} 字 / ${text.split('\n').length} 行`);

for (const md5 of ['0ABD8184126F', 'D0D9D02C2316']) {
  const e = lib.find((x) => String(x.id).includes(md5));
  if (!e) { console.log(`${md5}: 不在库里`); continue; }
  const desc = String(e.desc || '').trim();
  const hit = desc && text.includes(desc);
  console.log(`${md5}: desc=「${desc}」→ ${hit ? '进提示词 ✓' : '未进提示词 ✗'}`);
}

const shown = lib.filter((e) => {
  const d = String(e.desc || '').trim();
  return d && text.includes(d);
}).length;
console.log(`库里实际露脸的：${shown} / ${lib.length}`);
const fresh = lib.filter((e) => {
  const d = new Date(e.createdAt);
  if (Number.isNaN(d.getTime())) return false;
  return new Date(d.getTime() + 8 * 3600e3).toISOString().slice(0, 10) === new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
});
console.log(`今天入库的：${fresh.length} 条`);
