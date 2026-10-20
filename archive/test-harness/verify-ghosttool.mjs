// 幽灵工具修复验证。
//   node verify-ghosttool.mjs ./bridge.rehearsal.js ./mcp.rehearsal.js
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const bPath = process.argv[2] || './bridge.rehearsal.js';
const mPath = process.argv[3] || './mcp.rehearsal.js';
const b = fs.readFileSync(bPath, 'utf8').replace(/\r\n/g, '\n');
const m = fs.readFileSync(mPath, 'utf8').replace(/\r\n/g, '\n');

section('核心：MCP 层真的有 qq_memory_update 了');
ok('注册了 qq_memory_update', /server\.tool\(\s*\n?\s*'qq_memory_update'/.test(m));
ok('注册在 server.connect 之前',
  m.indexOf("'qq_memory_update'") < m.indexOf('server.connect(new StdioServerTransport())'));
ok('转发到已验证存在的后端路由', m.includes('/api/socialV2/memory-update'));
ok('参数与提示词一致：category', /category:\s*z\.enum\(\['activeTopic', 'pendingThought', 'memberImpression'\]\)/.test(m));
ok('参数与提示词一致：target', /target:\s*z\.string\(\)\.optional\(\)/.test(m));
ok('参数与提示词一致：newContent', /newContent:\s*z\.string\(\)\.optional\(\)/.test(m));
ok('也支持 activeTopic/pendingThought 的 oldContent', /oldContent:\s*z\.string\(\)\.optional\(\)/.test(m));
ok('带 x-agent-token（不是免鉴权调用）', /'x-agent-token': token/.test(m.slice(m.indexOf("'qq_memory_update'"))));

section('提示词里点名的工具，现在都存在了');
{
  // 从提示词里抓所有 qq_xxx 工具名，逐个查 MCP 层是否注册
  const i = b.indexOf('【印象维护】');
  const line = i >= 0 ? b.slice(i, b.indexOf('\n', i)) : '';
  const named = [...new Set(line.match(/qq_[a-z_]+/g) || [])];
  console.log('  提示词点名的工具：', named.join(', '));
  for (const t of named) {
    ok(`「${t}」确实注册了`, new RegExp(`server\\.tool\\(\\s*\\n?\\s*'${t}'`).test(m));
  }
}

section('工具开关与清单');
ok('开关登记 qq_memory_update → memoryUpdate', /qq_memory_update:\s*'memoryUpdate'/.test(m));
ok('bridge 工具开关清单含 memoryUpdate', /'memory', 'memoryUpdate'/.test(b));
ok('bridge 默认值含 memoryUpdate', /memoryUpdate:\s*true/.test(b));
ok('toolMap 含 memoryUpdate（qq_get_prompt 能列出来）', /memoryUpdate:\s*'qq_memory_update'/.test(b));
ok('update 路由有独立开关校验', /v2ToolEnabled\('memoryUpdate'\)/.test(b));

section('衍生问题：traits 单标签限长');
ok('update 路径给单标签加 slice(0, 40)', /\.slice\(0, 40\)/.test(b));
ok('append 路径也是 40 字口径', /const shortText = text\.slice\(0, 40\)/.test(b));
ok('不再用旧的 50 字口径', !/traits\.push\(text\.slice\(0, 50\)\)/.test(b));
{
  // 实测那条 144 字小作文，按新逻辑应该被截到 40
  const long = '私聊的这位爱叫人大肥鱼，自己说"随便你取"，还说我像养女儿一样，天天喊我大肥鱼大肥鱼，我都要听吐了，他还觉得很好玩，真是的，这人怎么这样啊，我都不想说他了真的';
  const split = (newContent) => newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).map((s) => s.slice(0, 40)).slice(0, 20);
  const out = split(long);
  ok('144 字长句被切成多条并各自截断', out.every((t) => t.length <= 40), JSON.stringify(out.map((t) => t.length)));
  const short = split('话多，爱怼人，爱发怪图');
  ok('正常的短标签不受影响', short.join('|') === '话多|爱怼人|爱发怪图', short.join('|'));
}

section('「能改」就意味着「能消除提醒」');
{
  // 判定逻辑复刻
  const stale = (refreshAt, count, now, days = 7) => count > 0
    && (refreshAt === 0 || now - refreshAt > days * 86400000);
  const now = Date.now();
  ok('refreshAt=0 且印象>0 ⇒ 该提醒（现状）', stale(0, 6, now) === true);
  // 走一次 update 之后，后端会 st.lastImpressionRefreshAt = Date.now()
  ok('改完之后 refreshAt=now ⇒ 不再提醒', stale(now, 6, now) === false);
  ok('7 天后又会提醒', stale(now - 8 * 86400000, 6, now) === true);
  // 关键：这条路径现在真的可达（工具存在 + 路由存在 + 会重置计时）
  ok('后端 update 分支会重置计时', /st\.lastImpressionRefreshAt = Date\.now\(\);/.test(b));
  const routeIdx = b.indexOf("url.pathname === '/api/socialV2/memory-update'");
  const resetIdx = b.indexOf('st.lastImpressionRefreshAt = Date.now();', routeIdx);
  // 距离实测约 5.3k 字符（这个路由很长：含 activeTopic/pendingThought/memberImpression
  // 三个分支的参数校验与改写逻辑）。窗口给足，但边界仍要落在「下一个路由开始之前」。
  const nextRoute = b.indexOf("url.pathname === '/api/socialV2/memory'", routeIdx + 10);
  ok('重置发生在 update 路由内（不是别处）',
    routeIdx > 0 && resetIdx > routeIdx && (nextRoute < 0 || resetIdx < nextRoute),
    `route=${routeIdx} reset=${resetIdx} next=${nextRoute}`);
  ok('重置之前确实在写 memberImpressions（不是空中重置）',
    /st\.memberImpressions\[newTarget\] = im;[\s\S]{0,200}st\.lastImpressionRefreshAt = Date\.now\(\);/.test(b));
}

section('没引入回归');
ok('bridge MARKER 数量正常', (b.match(/MARKER: ghosttool/g) || []).length >= 4, `${(b.match(/MARKER: ghosttool/g) || []).length} 处`);
ok('没删掉原有的记忆工具', ['qq_memory_append', 'qq_memory_query', 'qq_memory_remove', 'qq_memory_clear']
  .every((t) => m.includes(`'${t}'`)));
ok('后端原有 update 路由还在', b.includes("url.pathname === '/api/socialV2/memory-update'"));
ok('没有把 refreshAt 默认值改回 Date.now()',
  !/lastImpressionRefreshAt:\s*Number\(val\.lastImpressionRefreshAt\) > 0 \? Number\(val\.lastImpressionRefreshAt\) : Date\.now\(\)/.test(b));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
