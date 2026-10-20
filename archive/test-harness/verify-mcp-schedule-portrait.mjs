// MCP 侧接线检查：qq_schedule / qq_portrait 两个工具真的注册了、参数齐全、
// 开关登记对了、并且没有把敏感/越权参数暴露出去。
// 用法：node verify-mcp-schedule-portrait.mjs ./mcp.rehearsal.js
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const target = process.argv[2] || './mcp.rehearsal.js';
const src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

section('工具注册');
ok('有 schedule-portrait MARKER', src.includes('MARKER: schedule-portrait'));
ok("注册了 qq_schedule", /server\.tool\(\s*\n?\s*'qq_schedule'/.test(src));
ok("注册了 qq_portrait", /server\.tool\(\s*\n?\s*'qq_portrait'/.test(src));
// 注册必须发生在 connect 之前，否则工具永远不会被广播
ok('注册在 server.connect 之前',
  src.indexOf("'qq_schedule'") < src.indexOf('server.connect(new StdioServerTransport())'));
ok('注册在 server.connect 之前（画像）',
  src.indexOf("'qq_portrait'") < src.indexOf('server.connect(new StdioServerTransport())'));

section('工具开关登记（漏登记＝关不掉还照样占 token）');
ok('qq_schedule → schedule', /qq_schedule:\s*'schedule'/.test(src));
ok('qq_portrait → portrait', /qq_portrait:\s*'portrait'/.test(src));

section('日程工具的参数面');
{
  const block = src.slice(src.indexOf("'qq_schedule'"), src.indexOf("'qq_portrait'"));
  ok('参数 key', /key:\s*z\.string\(\)/.test(block));
  ok('参数 token', /token:\s*z\.string\(\)/.test(block));
  ok('action 是枚举', /action:\s*z\.enum\(\[/.test(block));
  ok('action 含 add/query/update/remove', /'add'/.test(block) && /'query'/.test(block) && /'update'/.test(block) && /'remove'/.test(block));
  ok('action 含 review', /'review'/.test(block));
  ok('period 限定三档', /period:\s*z\.enum\(\['上午',\s*'下午',\s*'晚上'\]\)/.test(block));
  ok('有 id（update/remove 用）', /id:\s*z\.string\(\)\.optional\(\)/.test(block));
  ok('有 strength', /strength:\s*z\.number\(\)/.test(block));
  ok('有 scope', /scope:\s*z\.string\(\)/.test(block));
  ok('描述里讲了「改 text 会自动把旧说法留底」', /改 text 会自动把旧说法留底|改 text＝/.test(block));
  ok('描述里给了日期写法示例', /这周三/.test(block));
  ok('描述里明确不要精确时间', /别给精确时间|只要这三个时段/.test(block));
  // query 走 GET，写操作走 POST
  ok('查走 GET', /action === 'query'/.test(block) && /agentApi\('\/api\/socialV2\/schedule\?'/.test(block));
  ok('写走 POST', /method:\s*'POST'/.test(block) && /api\/socialV2\/schedule/.test(block));
}

section('画像工具的参数面');
{
  const block = src.slice(src.indexOf("'qq_portrait'"), src.indexOf('MARKER: schedule-portrait'));
  ok('参数 subject', /subject:\s*z\.string\(\)\.optional\(\)/.test(block));
  ok('facet 是 doing/view/bond', /facet:\s*z\.enum\(\['doing',\s*'view',\s*'bond'\]\)/.test(block));
  ok('action 含 add/query/update/remove', /'add'/.test(block) && /'query'/.test(block) && /'update'/.test(block) && /'remove'/.test(block));
  ok('action 含 subjects', /'subjects'/.test(block));
  ok('有 weight', /weight:\s*z\.number\(\)/.test(block));
  ok('描述里讲了「跨会话共享」', /跨会话共享/.test(block));
  ok('描述里讲了不是打标签/待办', /不是待办清单，也不是给系统打标签/.test(block));
  ok('描述里三个面都解释了', /doing=他平时在做什么/.test(block) && /view=你怎么看他/.test(block) && /bond=你们处得怎么样/.test(block));
  ok('查走 GET', /action === 'query' \|\| action === 'subjects'/.test(block));
  ok('写走 POST', /method:\s*'POST'/.test(block));
}

section('安全面：不暴露不该暴露的');
ok('没有暴露 reveal 动作给模型', !/z\.enum\(\[[^\]]*'reveal'/.test(src));
ok('schedule 工具描述不提 originalText 可读', !/qq_schedule[\s\S]{0,900}originalText/.test(src));
ok('画像工具描述不提 originalText 可读', !/qq_portrait[\s\S]{0,1200}originalText/.test(src));
// 实际写法是 `'x-agent-token': token`（引号在中间），正则要容许它。
const tokenHeaders = (src.match(/'x-agent-token':\s*token/g) || []).length;
ok('所有调用都带 x-agent-token', tokenHeaders >= 4, `实际 ${tokenHeaders} 处`);
ok('没有把 token 拼进 URL（只走 header）', !/socialV2\/(schedule|portrait)\?[^'"]*token=/.test(src));

section('注释里写清了规格三原则的落点');
ok('写明不写自动升级规则', /不写「观察 N 次升级」/.test(src));
ok('写明判断权留给角色', /判断权全部留给她/.test(src));

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
