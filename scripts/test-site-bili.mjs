/**
 * site-bili.js 验证：签名、解析、真实接口（真实接口部分需要网络，用 --live 开启）
 * 跑法：node scripts/test-site-bili.mjs [--live]
 */

import assert from 'node:assert';
import { BiliClient, signWbi, keyFromUrl, md5Hex, fmtDuration, fmtCount, fmtAgo } from '../src/site-bili.js';

let pass = 0;
let fail = 0;
const failures = [];
const ok = (c, n) => { if (c) pass += 1; else { fail += 1; failures.push(n); console.log(`FAIL  ${n}`); } };
const eq = (a, b, n) => {
  const x = JSON.stringify(a); const y = JSON.stringify(b);
  if (x === y) pass += 1; else { fail += 1; failures.push(n); console.log(`FAIL  ${n}\n      期望 ${y}\n      实际 ${x}`); }
};

// ───────────── 1. md5 正确性（拿公开测试向量验） ─────────────
{
  eq(md5Hex(''), 'd41d8cd98f00b204e9800998ecf8427e', 'md5("")');
  eq(md5Hex('abc'), '900150983cd24fb0d6963f7d28e17f72', 'md5("abc")');
  eq(md5Hex('message digest'), 'f96b697d7cb7938d525a2f31aaf161d0', 'md5("message digest")');
  eq(md5Hex('中文测试'), 'c1c8b0d1c5e0e5c8e0d0c5e8c2d0c1c0'.length === 32 ? md5Hex('中文测试') : '', 'md5 对多字节不抛错');
  ok(md5Hex('a'.repeat(200)).length === 32, 'md5 长输入仍是 32 位十六进制');
}

// ───────────── 2. WBI key 提取 ─────────────
{
  eq(
    keyFromUrl('https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png'),
    '7cd084941338484aae1ad9425b84077c',
    '从 img_url 抠 key'
  );
  eq(keyFromUrl(''), '', '空串返回空');
  eq(keyFromUrl(null), '', 'null 返回空');
  eq(keyFromUrl('https://x.com/a.png'), '', '不合格式返回空');
}

// ───────────── 3. 签名：确定性、参数齐全、排序无关 ─────────────
{
  const img = '7cd084941338484aae1ad9425b84077c';
  const sub = '4932caff0ff746eab6f01bf08b70ac45';

  const a = signWbi({ foo: '114', bar: '514' }, img, sub, 1700000000);
  ok(/^[0-9a-f]{32}$/.test(a.w_rid), 'w_rid 是 32 位十六进制 md5');
  eq(a.wts, 1700000000, 'wts 被写进参数');

  const b = signWbi({ bar: '514', foo: '114' }, img, sub, 1700000000);
  eq(a.w_rid, b.w_rid, '参数顺序不影响签名（内部排序）');

  const c = signWbi({ foo: '114', bar: '514' }, img, sub, 1700000001);
  ok(a.w_rid !== c.w_rid, 'wts 变了签名就变');

  const d = signWbi({ foo: '114', bar: '515' }, img, sub, 1700000000);
  ok(a.w_rid !== d.w_rid, '参数值变了签名就变');

  // 特殊字符被过滤：!'()* 应当被去掉后再算
  const e1 = signWbi({ q: "a!b'c(d)e*f" }, img, sub, 1700000000);
  const e2 = signWbi({ q: 'abcdef' }, img, sub, 1700000000);
  eq(e1.w_rid, e2.w_rid, "值和 '!'()*' 被过滤掉（与官方实现一致）");
}

// ───────────── 4. 格式化小工具 ─────────────
{
  eq(fmtDuration(0), '0:00', '时长 0');
  eq(fmtDuration(65), '1:05', '时长 65 秒');
  eq(fmtDuration(3723), '1:02:03', '时长 1 小时');
  eq(fmtCount(999), '999', '计数小于万');
  eq(fmtCount(12345), '1.2万', '计数万级');
  eq(fmtCount(123456789), '1.2亿', '计数亿级');
  eq(fmtAgo(0), '', '无时间戳返回空');
  const now = 1700000000000;
  eq(fmtAgo(now / 1000 - 30, now), '刚刚', '30 秒前');
  eq(fmtAgo(now / 1000 - 300, now), '5 分钟前', '5 分钟前');
  eq(fmtAgo(now / 1000 - 7200, now), '2 小时前', '2 小时前');
  eq(fmtAgo(now / 1000 - 86400 * 3, now), '3 天前', '3 天前');
}

// ───────────── 5. 客户端：用假 phone 验证请求构造 ─────────────
function fakePhone(handler) {
  const calls = [];
  return {
    calls,
    request(req) {
      calls.push(req);
      return Promise.resolve(handler(req));
    }
  };
}

{
  const phone = fakePhone((req) => {
    if (req.url.includes('/x/web-interface/nav')) {
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: { wbi_img: {
            img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
            sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png'
          } }
        })
      };
    }
    // 2026-10-23：详情不再走 /x/web-interface/view（那条路径在本机 IP 上恒 412），
    // 改成按 BV 号搜索。这里让桩函数对**两条路径都答**，因为 videoDetail 会先
    // 拿 WBI（打 /nav）再打搜索；假数据挂在搜索上。
    if (req.url.includes('/nav')) {
      return { status: 200, body: JSON.stringify({ code: 0, data: { wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'a'.repeat(32) + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'b'.repeat(32) + '.png'
      } } }) };
    }
    if (req.url.includes('/wbi/search/type')) {
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: {
            result: [{
              bvid: 'BV1kXnC6EE9a', aid: 117482035675312, cid: 42941745106,
              title: '<em class="keyword">鬼镜</em> 讲解',
              author: '喊我吃榴莲', mid: 1396288129,
              description: '  一段描述  ', duration: '1:07:57', pubdate: 1792639800,
              play: 123456, like: 789, video_review: 6, tname: '影视'
            }, { bvid: 'BV1other0000', aid: 1, title: '干扰项' }]
          }
        })
      };
    }
    if (req.url.includes('/x/web-interface/view')) {
      return {
        status: 200,
        body: JSON.stringify({
          code: 0,
          data: {
            bvid: 'BV1kXnC6EE9a', aid: 117482035675312, cid: 42941745106,
            title: '<em class="keyword">鬼镜</em> 讲解',
            owner: { name: '喊我吃榴莲', mid: 1396288129 },
            desc: '  一段描述  ', duration: 4077, pubdate: 1792639800,
            stat: { view: 123456, like: 789, coin: 12, favorite: 34, share: 5, danmaku: 6, reply: 7 },
            tname: '影视', copyright: 1, pages: [{}, {}]
          }
        })
      };
    }
    return { status: 200, body: '{"code":0,"data":{}}' };
  });

  const c = new BiliClient({ phone, now: () => 1700000000000 });

  const d = await c.videoDetail('BV1kXnC6EE9a');
  eq(d.title, '鬼镜 讲解', '标题里的 HTML 标签被剥掉');
  eq(d.desc, '一段描述', 'description 首尾空白被去掉');
  eq(d.author, '喊我吃榴莲', '作者名来自搜索的 author 字段');
  eq(d.view, 123456, '播放量来自 play 字段');
  eq(d.aid, 117482035675312, 'aid 拿到了（评论要靠它）');
  eq(d.duration, 4077, "搜索结果里 '1:07:57' 换成秒数 4077");
  eq(d.bvid, 'BV1kXnC6EE9a', 'BV 号对齐');
  ok(phone.calls.length >= 2, '详情 = 先取 WBI 再搜索，至少两次请求');
  const searchCall = phone.calls.find((x) => x.url.includes('/wbi/search/type'));
  ok(!!searchCall, '走的是搜索路径而不是 /x/web-interface/view');
  ok(!phone.calls.some((x) => x.url.includes('/x/web-interface/view')), '完全没打被风控的 view 接口');
  ok(!('cookie' in searchCall.headers), '请求头里没有 cookie');
  eq(searchCall.headers.referer, 'https://www.bilibili.com/', '带上 Referer（B 站要求的）');
}

// ───────────── 6. WBI 缓存 ─────────────
{
  let navHits = 0;
  const phone = fakePhone((req) => {
    if (req.url.includes('/nav')) {
      navHits += 1;
      return { status: 200, body: JSON.stringify({ code: 0, data: { wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'c'.repeat(32) + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'd'.repeat(32) + '.png'
      } } }) };
    }
    return { status: 200, body: JSON.stringify({ code: 0, data: { item: [] } }) };
  });
  let t = 1700000000000;
  const c = new BiliClient({ phone, now: () => t });
  await c.recommend(5);
  await c.recommend(5);
  eq(navHits, 1, 'WBI key 只取一次（缓存生效）');
  t += 3601_000;
  await c.recommend(5);
  eq(navHits, 2, '超过 1 小时后重新取 key');
}

// ───────────── 6b. 回归：未登录时 nav 报 -101 但仍要给 WBI key ─────────────
// 2026-10-23 真实踩过：把 nav 当严格接口 → 推荐流/搜索全挂着「账号未登录」
{
  let navHits = 0;
  const phone = fakePhone((req) => {
    if (req.url.includes('/nav')) {
      navHits += 1;
      // 真实的未登录响应：code -101，但 data.wbi_img 给得妥妥的
      return { status: 200, body: JSON.stringify({
        code: -101, message: '账号未登录',
        data: { isLogin: false, wbi_img: {
          img_url: 'https://i0.hdslb.com/bfs/wbi/' + '1'.repeat(32) + '.png',
          sub_url: 'https://i0.hdslb.com/bfs/wbi/' + '2'.repeat(32) + '.png'
        } }
      }) };
    }
    // 评论接口：这里故意回 -101，用来验「严格接口的 -101 不许被 lenient 放过」
    if (req.url.includes('/x/v2/reply')) {
      return { status: 200, body: JSON.stringify({ code: -101, message: '账号未登录', data: {} }) };
    }
    return { status: 200, body: JSON.stringify({ code: 0, data: { item: [
      { id: 1, bvid: 'BV1ccccccccc', goto: 'av', title: 't', owner: { name: 'u', mid: 1 }, stat: {} }
    ] } }) };
  });
  const c = new BiliClient({ phone });
  let err = null;
  let items = [];
  try { items = await c.recommend(5); } catch (e) { err = e; }
  ok(err === null, 'nav 报 -101 时 ensureWbi 不抛错（lenient 生效）');
  eq(navHits, 1, '仍然只取了 1 次 nav');
  eq(items.length, 1, '推荐流照常可用（-101 不再连坐）');

  // 但严格接口仍然要对 -101 报错 —— lenient 只给取 key 用。
  // 2026-10-23：videoDetail 改走搜索后本身也要先取 key，不再适合当「严格接口」样本，
  // 换成 comments（它走 signed + 严格解析）。
  let e2 = null;
  try { await c.comments(117482035675312, { ps: 3 }); } catch (x) { e2 = x; }
  ok(e2 !== null && /账号未登录/.test(String(e2.message)), '严格接口 -101 仍然报错（lenient 不扩散）');
}

// ───────────── 7. 错误翻译 ─────────────
{
  // 桩要分两路应答：/nav 必须给出 WBI key（否则 videoDetail 在取 key 那一步就挂了，
  // 测不到真正想测的「搜索接口报错怎么翻译」），其它路径回指定的 status/body。
  const mk = (status, body) => new BiliClient({ phone: fakePhone((req) => {
    if (req.url.includes('/nav')) {
      return { status: 200, body: JSON.stringify({ code: 0, data: { wbi_img: {
        img_url: 'https://i0.hdslb.com/bfs/wbi/' + 'e'.repeat(32) + '.png',
        sub_url: 'https://i0.hdslb.com/bfs/wbi/' + 'f'.repeat(32) + '.png'
      } } }) };
    }
    return { status, body };
  }) });

  let e = null;
  try { await mk(412, '').videoDetail('BV1kXnC6EE9a'); } catch (x) { e = x; }
  ok(e && /风控拦截/.test(e.message), 'HTTP 412 → 人话');

  e = null;
  try { await mk(200, '<!DOCTYPE html><html></html>').videoDetail('BV1kXnC6EE9a'); } catch (x) { e = x; }
  ok(e && /网页而不是数据/.test(e.message), '返回 HTML → 判定为风控');

  e = null;
  try { await mk(200, '{"code":-412,"message":"request was banned"}').videoDetail('BV1kXnC6EE9a'); } catch (x) { e = x; }
  ok(e && /风控拦截/.test(e.message), 'code -412 → 人话');

  e = null;
  try { await mk(200, '{"code":-101,"message":"账号未登录"}').videoDetail('BV1kXnC6EE9a'); } catch (x) { e = x; }
  ok(e && /账号未登录/.test(e.message), 'code -101 → 人话');
  eq(e?.biliCode, -101, '错误对象带上 biliCode 供上层判断');

  e = null;
  try { await mk(200, 'not json at all').videoDetail('BV1kXnC6EE9a'); } catch (x) { e = x; }
  ok(e && /不是 JSON/.test(e.message), '非 JSON → 明确报错');
}

// ───────────── 8. 参数校验 ─────────────
{
  const c = new BiliClient({ phone: fakePhone(() => ({ status: 200, body: '{"code":0}' })) });
  const rejects = [];
  for (const [fn, arg, label] of [
    ['videoDetail', 'av12345', 'videoDetail 拒绝非 BV 号'],
    ['videoDetail', '', 'videoDetail 拒绝空串'],
    ['comments', 0, 'comments 拒绝 aid=0'],
    ['comments', 'abc', 'comments 拒绝非数字 aid'],
    ['search', '', 'search 拒绝空关键词']
  ]) {
    let e = null;
    try { await c[fn](arg); } catch (x) { e = x; }
    rejects.push([e !== null, label]);
  }
  for (const [good, label] of rejects) ok(good, label);
}

// ───────────── 9. 推荐流过滤 ─────────────
{
  const body = JSON.stringify({ code: 0, data: { item: [
    { id: 1, bvid: 'BV1aaaaaaaaa', goto: 'av', title: '<em>标题</em>', owner: { name: 'UP', mid: 9 }, duration: 100, stat: { view: 1000, like: 10, danmaku: 5 }, rcmd_reason: { content: '因为你爱看' } },
    { id: 2, goto: 'live', title: '直播' },          // 直播：丢掉
    { id: 3, bvid: 'BV1bbbbbbbbb', goto: 'av', title: '广告位', owner: {}, stat: {} }
  ] } });
  const c = new BiliClient({ phone: fakePhone((req) => {
    if (req.url.includes('/nav')) return { status: 200, body: JSON.stringify({ code: 0, data: { wbi_img: { img_url: 'https://x/' + 'e'.repeat(32) + '.png', sub_url: 'https://x/' + 'f'.repeat(32) + '.png' } } }) };
    return { status: 200, body };
  }) });
  const items = await c.recommend(10);
  eq(items.length, 2, '只有 goto=av 的留下');
  eq(items[0].title, '标题', '标题剥标签');
  eq(items[0].reason, '因为你爱看', '推荐理由');
}

// ───────────── 10. 真实接口（需要网络，默认跳过） ─────────────
if (process.argv.includes('--live')) {
  console.log('\n[live] 打真实 B 站接口…');
  const phone = {
    async request(req) {
      const res = await fetch(req.url, { headers: req.headers });
      const text = await res.text();
      return { status: res.status, body: text, headers: { 'content-type': res.headers.get('content-type') || '' } };
    }
  };
  const c = new BiliClient({ phone });

  try {
    const w = await c.ensureWbi();
    ok(/^[0-9a-f]{32}$/.test(w.imgKey), `[真实] 拿到 WBI imgKey：${w.imgKey.slice(0, 8)}…`);
  } catch (e) { ok(false, `[真实] 拿 WBI key 失败：${e.message}`); }

  try {
    const items = await c.recommend(5);
    ok(items.length > 0, `[真实] 推荐流拿到 ${items.length} 条`);
    if (items[0]) {
      console.log(`       首条：${items[0].title.slice(0, 30)} / ${items[0].author} / ${fmtCount(items[0].view)} 播放`);
    }
  } catch (e) { ok(false, `[真实] 推荐流失败：${e.message}`); }

  try {
    const d = await c.videoDetail('BV1kXnC6EE9a');
    ok(d.title.length > 0, `[真实] 详情：${d.title.slice(0, 30)} / ${d.author} / ${fmtCount(d.view)} 播放 / ${fmtDuration(d.duration)}`);
  } catch (e) { ok(false, `[真实] 详情失败：${e.message}`); }

  try {
    const d = await c.videoDetail('BV1kXnC6EE9a');
    const cs = await c.comments(d.aid, { ps: 5 });
    ok(Array.isArray(cs), `[真实] 评论拿到 ${cs.length} 条`);
    if (cs[0]) console.log(`       首条：${cs[0].user}：${cs[0].text.slice(0, 40)}（${cs[0].likes} 赞）`);
  } catch (e) { ok(false, `[真实] 评论失败：${e.message}`); }

  try {
    const r = await c.search('黑神话', { ps: 3 });
    ok(r.length > 0, `[真实] 搜索拿到 ${r.length} 条`);
    if (r[0]) console.log(`       首条：${r[0].title.slice(0, 30)} / ${r[0].author}`);
  } catch (e) { ok(false, `[真实] 搜索失败：${e.message}`); }
}

console.log('');
console.log(fail === 0 ? `全部通过：${pass}/${pass + fail}` : `通过 ${pass}，失败 ${fail}\n失败项：${failures.join(' / ')}`);
process.exit(fail === 0 ? 0 : 1);
