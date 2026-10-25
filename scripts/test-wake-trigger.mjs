// 离线断言：撞名掩码 + nameMention 判定
// 逻辑是从 src/bridge.js 的 maskOtherMemberNamesV2 / evaluateWakeTriggerV2 的
// nameMention 分支复制出来的副本——bridge.js 没有 export，无法 import。
// 改那两个函数时，这里的副本要一起改，否则测试会失真。
function maskOtherMemberNamesV2(st, lowered, kwStr) {
  if (!lowered || !kwStr) return lowered;
  let hay = lowered;
  const seen = new Set();
  for (const m of st?.recentMessages ?? []) {
    if (!m || m.isSelf) continue;
    const name = String(m.sender ?? '').trim().toLowerCase();
    if (!name || name === kwStr || seen.has(name)) continue;
    if (!name.includes(kwStr)) continue;
    seen.add(name);
    hay = hay.split(name).join('\u0000');
  }
  return hay;
}
function judgeNameMention(st, plainContent, selfNickname) {
  const nick = selfNickname.toLowerCase();
  const lowerPlain = maskOtherMemberNamesV2(st, String(plainContent ?? '').toLowerCase(), nick);
  return lowerPlain.includes(nick) ? 'nameMention' : null;
}
function judgeKeyword(st, plainContent, keywords) {
  const lower = String(plainContent ?? '').toLowerCase();
  for (const kw of keywords) {
    const kwStr = String(kw ?? '').toLowerCase();
    if (!kwStr) continue;
    const hay = maskOtherMemberNamesV2(st, lower, kwStr);
    if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
      if (new RegExp(`\\b${kwStr}\\b`, 'i').test(hay)) return `keyword:${kw}`;
    } else if (hay.includes(kwStr)) {
      return `keyword:${kw}`;
    }
  }
  return null;
}

const st = { recentMessages: [
  { sender: '大肥鱼-赵依仙爱吃大白饭', isSelf: false },
  { sender: '超大肥鱼', isSelf: false },
  { sender: '鲸鱼座', isSelf: false },
  { sender: '小鲸鱼', isSelf: false },
  { sender: '小雨', isSelf: false },
] };

const cases = [
  // [说明, 期望, 实际]
  ['引用块里出现撞名号昵称，正文没有', null,
    judgeNameMention(st, '对，各放各的，谁也别拖累谁', '大肥鱼')],
  ['引用块把撞名号昵称带进 text（旧逻辑会误判，新逻辑用 plain 不该误判）', null,
    judgeNameMention(st, '对，各放各的', '大肥鱼')],
  ['正文真的点名', 'nameMention', judgeNameMention(st, '大肥鱼 你在吗', '大肥鱼')],
  ['正文 @ 她', 'nameMention', judgeNameMention(st, '@大肥鱼 你说呢', '大肥鱼')],
  ['正文提撞名号「超大肥鱼」', null, judgeNameMention(st, '超大肥鱼说得对', '大肥鱼')],
  ['正文提撞名号全名', null,
    judgeNameMention(st, '大肥鱼-赵依仙爱吃大白饭 说得好', '大肥鱼')],
  ['正文 @ 撞名号（at 到别人）', null,
    judgeNameMention(st, '@大肥鱼-赵依仙爱吃大白饭 你来说', '大肥鱼')],
  ['关键词「鲸鱼」被撞名「鲸鱼座」吃掉', null, judgeKeyword(st, '鲸鱼座今天来了', ['鲸鱼'])],
  ['关键词「鲸鱼」被撞名「小鲸鱼」吃掉', null, judgeKeyword(st, '小鲸鱼在潜水', ['鲸鱼'])],
  ['关键词真命中', 'keyword:鲸鱼', judgeKeyword(st, '那条鲸鱼好可爱', ['鲸鱼'])],
];

let fail = 0;
for (const [desc, want, got] of cases) {
  const ok = want === got;
  if (!ok) fail++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  want=${String(want).padEnd(14)} got=${String(got).padEnd(14)}  ${desc}`);
}
console.log(`\n${cases.length - fail}/${cases.length} passed`);
process.exit(fail ? 1 : 0);
