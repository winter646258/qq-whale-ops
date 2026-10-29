// 实验：这台服务器能不能直连 B 站 API（不走浏览器桥）？
//
// 背景：site-bili.js 的 raw() 硬性要求 phone.request，桥离线就一句都发不出去。
// 但 modules/bili/index.js 的头注释自己写着「服务器出口 IP 被 B 站拉黑」是**错的**，
// 实测原因是缺 buvid3 与 WBI 签名。WBI 已经实现了，那唯一的缺口就是 buvid3。
//
// 这个脚本按最小可用姿势打一遍：拿 buvid3 → nav 取 WBI key → 签名 → 推荐流。
// 全部用 node 自带 fetch，不经任何桥。

import { signWbi, keyFromUrl } from '../src/site-bili.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const JSON_HEADERS = {
  'user-agent': UA,
  'accept': 'application/json, text/plain, */*',
  'referer': 'https://www.bilibili.com/',
  'origin': 'https://www.bilibili.com'
};

function short(obj, n = 240) {
  const s = JSON.stringify(obj);
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---- 1) buvid3 ----
console.log('[1] /x/frontend/finger/spi 拿 buvid3');
let b3 = '';
let b4 = '';
try {
  const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', { headers: JSON_HEADERS });
  const j = await r.json();
  b3 = j?.data?.b_3 ?? '';
  b4 = j?.data?.b_4 ?? '';
  console.log(`  HTTP ${r.status} code=${j?.code} b_3=${b3 ? b3.slice(0, 12) + '…' : '(空)'} b_4=${b4 ? '有' : '(空)'}`);
} catch (error) {
  console.log(`  FAIL ${error?.message ?? error}`);
  process.exit(1);
}
if (!b3) {
  console.log('  拿不到 buvid3，后面没意义了');
  process.exit(1);
}
const COOKIE = `buvid3=${b3}; buvid4=${b4}`;

// ---- 2) nav 取 WBI key ----
console.log('[2] /x/web-interface/nav 取 WBI key');
let imgKey = '';
let subKey = '';
try {
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: { ...JSON_HEADERS, cookie: COOKIE }
  });
  const j = await r.json();
  imgKey = keyFromUrl(j?.data?.wbi_img?.img_url);
  subKey = keyFromUrl(j?.data?.wbi_img?.sub_url);
  console.log(`  HTTP ${r.status} code=${j?.code}（-101 = 未登录，但 key 照样给）`);
  console.log(`  imgKey=${imgKey} subKey=${subKey}`);
} catch (error) {
  console.log(`  FAIL ${error?.message ?? error}`);
  process.exit(1);
}
if (!imgKey || !subKey) {
  console.log('  拿不到 WBI key');
  process.exit(1);
}

// ---- 3) 推荐流（这是「主动刷视频」的第一手来源） ----
console.log('[3] /x/web-interface/wbi/index/top/feed/rcmd 推荐流');
const params = signWbi({ ps: 8, fresh_type: 3, feed_version: 'V8' }, imgKey, subKey);
const qs = new URLSearchParams(params).toString();
let items = [];
try {
  const r = await fetch(`https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?${qs}`, {
    headers: { ...JSON_HEADERS, cookie: COOKIE }
  });
  const text = await r.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    console.log(`  FAIL HTTP ${r.status}，返回的不是 JSON：${text.slice(0, 200)}`);
    process.exit(1);
  }
  console.log(`  HTTP ${r.status} code=${j?.code} message=${j?.message ?? ''}`);
  items = j?.data?.item ?? [];
  console.log(`  拿到了 ${items.length} 条`);
} catch (error) {
  console.log(`  FAIL ${error?.message ?? error}`);
  process.exit(1);
}

for (const it of items.slice(0, 10)) {
  const bv = it?.bvid ?? '';
  const title = String(it?.title ?? '').replace(/\s+/g, ' ').slice(0, 50);
  const dur = it?.duration ?? it?.c?.duration ?? 0;
  const up = it?.owner?.name ?? it?.c?.name ?? '';
  const play = it?.stat?.view ?? 0;
  const goto = it?.goto ?? '';
  if (!bv) { console.log(`  [跳过 no-bvid] goto=${goto} 标题=${title || '(空)'}`); continue; }
  console.log(`  ${bv}  ${dur}s  ${up}  ${play}播放  ${title}`);
}
const firstReal = items.find((it) => it?.bvid && Number(it?.duration) > 0) ?? items.find((it) => it?.bvid);
console.log(`  → 第一条可用：${firstReal?.bvid ?? '(无)'}`);

// ---- 4) 视频详情（拿 cid 才能取 playurl） ----
if (firstReal?.bvid) {
  console.log('[4] /x/web-interface/view 详情');
  try {
    const r = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${firstReal.bvid}`, {
      headers: { ...JSON_HEADERS, cookie: COOKIE }
    });
    const j = await r.json();
    const d = j?.data ?? {};
    console.log(`  HTTP ${r.status} code=${j?.code} aid=${d.aid} cid=${d.cid} 时长=${d.duration}s 分P=${d.videos}`);
    console.log(`  标题：${String(d.title ?? '').slice(0, 60)}`);
    console.log(`  简介：${String(d.desc ?? '').replace(/\s+/g, ' ').slice(0, 120)}`);
  } catch (error) {
    console.log(`  FAIL ${error?.message ?? error}`);
  }

  // ---- 5) playurl：这是能不能「看画面」的关键 ----
  console.log('[5] /x/player/wbi/playurl 取视频流地址');
  try {
    const r0 = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${firstReal.bvid}`, {
      headers: { ...JSON_HEADERS, cookie: COOKIE }
    });
    const j0 = await r0.json();
    const cid = j0?.data?.cid ?? 0;
    const p3 = signWbi({ bvid: firstReal.bvid, cid, qn: 32, fnval: 16, fourk: 0 }, imgKey, subKey);
    const r = await fetch(`https://api.bilibili.com/x/player/wbi/playurl?${new URLSearchParams(p3)}`, {
      headers: { ...JSON_HEADERS, cookie: COOKIE }
    });
    const j = await r.json();
    console.log(`  HTTP ${r.status} code=${j?.code} message=${j?.message ?? ''}`);
    const dash = j?.data?.dash;
    if (dash?.video?.length) {
      const v = dash.video[0];
      console.log(`  dash 视频流 ${dash.video.length} 档，首档 ${v.width}x${v.height} codec=${v.codecs} 基础地址=${String(v.baseUrl ?? v.base_url ?? '').slice(0, 80)}…`);
      console.log(`  音频流 ${dash.audio?.length ?? 0} 档`);
    } else if (j?.data?.durl?.length) {
      console.log(`  durl 老格式 ${j.data.durl.length} 段，地址=${String(j.data.durl[0].url).slice(0, 80)}…`);
    } else {
      console.log(`  没有 playurl 数据：${short(j).slice(0, 200)}`);
    }
  } catch (error) {
    console.log(`  FAIL ${error?.message ?? error}`);
  }
}
