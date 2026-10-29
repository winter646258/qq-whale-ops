// 表情自动学习的端到端验证：拿真实候选走一遍「挑图 → 取字节 → 收藏 → 写备注」。
//
// 只收藏 1 张（--max 可调），因为这一步会真的往 QQ 收藏夹里加表情，
// 验证够用就行，剩下的交给 stickerLearnTick 按配额慢慢来。
//
// 用法：node scripts/probe-sticker-learn.mjs [--dry] [--max 1]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  buildLearnRemark, buildRecentIndex, learnQuota, pickLearnCandidates, recordLearnAttempt
} from '../src/sticker-learn.js';
import { readSightings } from '../src/sticker-sightings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE = path.join(ROOT, 'state');

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const maxIdx = argv.indexOf('--max');
const MAX = maxIdx >= 0 ? Math.max(1, Number(argv[maxIdx + 1]) || 1) : 1;

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const snow = cfg.snowluma || {};
const HTTP_URL = String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = String(snow.accessToken || '');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

async function botPost(action, body) {
  const url = `${HTTP_URL}/${action}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000)
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { status: 'failed', raw: text.slice(0, 200) }; }
}

/** 简化版 fetchOneBotImage：只要「get_image 换新鲜 url 再下载」这一条路。 */
async function fetchImageBytes(media) {
  const info = await botPost('get_image', { file: String(media.file) });
  if (!info || info.status !== 'ok' || info.retcode !== 0) {
    throw new Error(`get_image 失败: ${info?.wording || info?.retcode || JSON.stringify(info).slice(0, 120)}`);
  }
  const data = info.data || {};
  const b64 = typeof data.base64 === 'string' && data.base64 ? data.base64 : '';
  if (b64) return Buffer.from(b64.replace(/^base64:\/\//, ''), 'base64');
  const url = String(data.url || data.file || '');
  if (!/^https?:\/\//.test(url)) throw new Error('get_image 既没给 base64 也没给 url');
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`下载图片 HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const now = Date.now();
const lc = cfg.socialV2?.sticker?.learn ?? {};
const library = readJson(path.join(STATE, 'stickers.json'), []);
const socialV2 = readJson(path.join(STATE, 'social-v2.json'), {});
const record = readJson(path.join(STATE, 'sticker-learn.json'), {}) || {};

const quota = learnQuota(record, lc, now);
console.log('配额：', JSON.stringify(quota));
console.log('今日已学', quota.usedToday, '/ 上限', Number(lc.maxPerDay ?? 5), '；冷却剩余', Math.round(quota.waitMs / 1000), '秒');

const sightings = readSightings(STATE, { minCount: Math.max(1, Number(lc.minCount) || 3) });
const convs = socialV2.conversations || {};
const recentIndex = buildRecentIndex(convs);
console.log(`观测（>=${lc.minCount ?? 3} 次）${sightings.items.length} 条；recentMessages 索引 ${recentIndex.size} 张图`);

const cands = pickLearnCandidates({ sightings: sightings.items, library, recentIndex, record, now, opts: lc });
console.log(`候选 ${cands.length} 个：`);
for (const c of cands) console.log(`  count=${c.count} ${c.hash.slice(0, 12)} ${c.key} msg=${c.messageId} ctx=${c.context.slice(0, 30)}`);

if (!cands.length) {
  console.log('没有候选（可能：都已入库 / 缓存滚掉 / 刚试过 / 配额用完）');
  process.exit(0);
}
if (DRY) { console.log('\n--dry：不实际收藏'); process.exit(0); }

let next = record;
let done = 0;
for (const cand of cands.slice(0, MAX)) {
  const remark = buildLearnRemark(cand, lc);
  console.log(`\n→ 学 ${cand.hash.slice(0, 12)}（备注：${remark}）`);
  try {
    const t0 = Date.now();
    const buf = await fetchImageBytes(cand.media);
    console.log(`  取图 ${buf.length} 字节 / ${Date.now() - t0}ms，magic ${buf.subarray(0, 4).toString('hex')}`);
    if (!buf.length) throw new Error('空图片');
    const addRes = await botPost('add_custom_face', { file: 'base64://' + buf.toString('base64') });
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      throw new Error(`add_custom_face 失败: ${addRes?.wording || addRes?.retcode}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    console.log(`  收藏成功 emojiId=${emojiId}`);
    if (emojiId && remark) {
      const modRes = await botPost('modify_custom_face', { emoji_id: emojiId, desc: remark });
      console.log(`  备注 ${modRes?.status === 'ok' ? '已写入' : '失败: ' + (modRes?.wording || modRes?.retcode)}`);
    }
    next = recordLearnAttempt(next, cand.hash, { ok: true, now: Date.now() });
    done += 1;
  } catch (error) {
    console.log(`  ✗ ${error?.message ?? error}`);
    next = recordLearnAttempt(next, cand.hash, { ok: false, error: String(error?.message ?? error), now: Date.now() });
  }
}
if (done) {
  const target = path.join(STATE, 'sticker-learn.json');
  fs.writeFileSync(`${target}.probe.tmp`, JSON.stringify(next, null, 2));
  fs.renameSync(`${target}.probe.tmp`, target);
  console.log(`\n记账已写入 ${target}`);
}
console.log(`\n实际学会 ${done} 张`);
