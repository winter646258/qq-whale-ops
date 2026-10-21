// 错误发群修复 —— 行为验证
// 用真实的分支逻辑推演：给定会话 key，函数应该往哪里发。
//   node verify-err-private.mjs ./bridge.rehearsal.js
import fs from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

const target = process.argv[2] || './bridge.rehearsal.js';
const src = fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n');

section('代码结构：群聊路径必须没有 sendToQQ');
{
  // 截取 error 分支
  const start = src.indexOf("} else if (ended.reason.kind === 'error') {");
  const end = src.indexOf("} else if (ended.reason.kind === 'aborted') {");
  ok('找到了 error 分支', start > 0 && end > start, `start=${start} end=${end}`);
  const branch = src.slice(start, end);

  // 群聊分支（else 里那个）不能出现裸的 sendToQQ(key, ...)
  // 唯一允许的 sendToQQ(key,...) 只在「key === ownerKey」那条里。
  // ⚠️ 正则必须要求实参后面紧跟逗号（`sendToQQ(key,`），
  // 否则会误匹配 `key === ownerKey` 这个**条件表达式**（咱第一次就踩了）。
  const sends = [...branch.matchAll(/await sendToQQ\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
  console.log('  分支里的 sendToQQ 目标：', JSON.stringify(sends));

  // 逐个确认：出现 sendToQQ(key 的地方必须处在 `key === ownerKey` 的 if 里
  const keySends = [...branch.matchAll(/await sendToQQ\(\s*key\s*,/g)].length;
  const ownerGuard = /else if \(key === ownerKey\) \{[\s\S]{0,300}await sendToQQ\(key,/.test(branch);
  ok('sendToQQ(key) 只在「key === ownerKey」分支里',
    keySends === 1 && ownerGuard,
    `keySends=${keySends} ownerGuard=${ownerGuard}`);
  ok('没有无条件发给 key 的调用',
    !sends.includes('key') || ownerGuard,
    `实际: ${JSON.stringify(sends)}`);
  ok('管理员私聊那条存在（ownerKey）',
    sends.some((s) => s === 'ownerKey'));
  ok('群聊/他人私聊走的是 ownerKey',
    /await sendToQQ\(ownerKey, `⚠️ agent 处理出错（\$\{key\}）/.test(branch));
  ok('私聊本身是管理员时发给自己',
    /key === ownerKey[\s\S]{0,200}await sendToQQ\(key,/.test(branch));
  ok('未配置 ownerQQ 时不发会话',
    /if \(!ownerKey\) \{[\s\S]{0,200}仅记录日志[\s\S]{0,50}?\}/.test(branch));
  ok('有 try/catch 兜底防递归',
    /try \{[\s\S]{0,600}\} catch \(notifyError\)/.test(branch));
  ok('日志行保留（自动兜底靠它数失败）',
    /log\(`agent 处理出错 \(\$\{key\}\): \$\{safeMsg\}`\)/.test(branch));
  ok('活动记录保留',
    /appendActivity\(`\$\{key\} agent 处理出错/.test(branch));
  ok('脱敏逻辑保留',
    /SENSITIVE_RE\.test\(msg\)/.test(branch));
}

section('行为推演：四种 key 场景分别发到哪');
{
  // 复刻补丁里的决定逻辑
  const decide = (key, ownerQQ) => {
    const sends = [];
    const ownerKey = ownerQQ ? `private:${String(ownerQQ)}` : '';
    if (!ownerKey) {
      return { sends: [], reason: 'no-owner' };
    }
    if (key === ownerKey) {
      sends.push({ to: key, text: `⚠️ agent 处理出错：...` });
      return { sends, reason: 'is-owner' };
    }
    sends.push({ to: ownerKey, text: `⚠️ agent 处理出错（${key}）：...` });
    return { sends, reason: 'forward-to-owner' };
  };

  const OWNER = 1124721191;
  const GROUP = 'group:906710082';
  const OWNER_KEY = `private:${OWNER}`;
  const OTHER = 'private:3414115838';

  // 场景 1：群聊出错
  {
    const r = decide(GROUP, OWNER);
    ok('群聊出错：不发给群', r.sends.every((s) => s.to !== GROUP), JSON.stringify(r.sends));
    ok('群聊出错：转发给管理员私聊', r.sends.length === 1 && r.sends[0].to === OWNER_KEY);
    ok('群聊出错：消息里带上来源 key 便于定位', r.sends[0].text.includes(GROUP));
  }

  // 场景 2：管理员私聊出错
  {
    const r = decide(OWNER_KEY, OWNER);
    ok('管理员私聊出错：发给他本人', r.sends.length === 1 && r.sends[0].to === OWNER_KEY);
    ok('管理员私聊出错：不重复抄送', r.sends.length === 1);
  }

  // 场景 3：他人私聊出错
  {
    const r = decide(OTHER, OWNER);
    ok('他人私聊出错：不发给那个人', r.sends.every((s) => s.to !== OTHER), JSON.stringify(r.sends));
    ok('他人私聊出错：转发给管理员', r.sends[0].to === OWNER_KEY);
  }

  // 场景 4：未配置 ownerQQ
  {
    const r = decide(GROUP, null);
    ok('未配置 ownerQQ：一个字都不发', r.sends.length === 0);
    ok('未配置 ownerQQ：有明确原因', r.reason === 'no-owner');
  }

  // 场景 5：actor 会发错目标吗（穷举）
  {
    const cases = [GROUP, OWNER_KEY, OTHER, 'group:910502749', 'private:2050117833'];
    let allSafe = true;
    for (const k of cases) {
      const r = decide(k, OWNER);
      if (r.sends.some((s) => s.to === GROUP || s.to === 'group:910502749')) allSafe = false;
    }
    ok('穷举：任何会话出错都不会发进群', allSafe);
  }
}

section('不会递归');
{
  const start = src.indexOf("} else if (ended.reason.kind === 'error') {");
  const end = src.indexOf("} else if (ended.reason.kind === 'aborted') {");
  const branch = src.slice(start, end);

  // sendToQQ 自身有 catch，不会抛
  const sendDef = (() => {
    const i = src.indexOf('function sendToQQ(key, msg)');
    return src.slice(i, i + 1400);
  })();
  ok('sendToQQ 内部有 .catch（不会抛错回灌）', /\.catch\(\(error\) => \{/.test(sendDef));
  ok('sendToQQ 失败只记日志', /lastSendFailed\.set\(key, true\);\s*\n\s*log\(/.test(sendDef));
  ok('分支里没有再次调用自身处理错误',
    !/sendToQQ\([^)]*agent 处理出错[^)]*\)\s*\.catch[\s\S]{0,100}sendToQQ/.test(branch));
}

section('脱敏与截断仍然有效');
{
  const start = src.indexOf("} else if (ended.reason.kind === 'error') {");
  const end = src.indexOf("} else if (ended.reason.kind === 'aborted') {");
  const branch = src.slice(start, end);
  ok('内容截断到 500', /msg\.slice\(0, 500\)/.test(branch));
  ok('敏感内容替换为占位', /'（含敏感信息，已隐藏）'/.test(branch));
  ok('活动记录再截断到 200', /safeMsg\.slice\(0, 200\)/.test(branch));
}

console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
process.exit(fail ? 1 : 0);
