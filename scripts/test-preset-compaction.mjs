#!/usr/bin/env node
// 静态守卫：压缩策略按 provider+model 钉死 + 提示词里有输出长度上限。
// 为什么值得一条用例：这两个值写错不会报错，只会在某天账单体翻倍时才被发现。
import assert from 'node:assert/strict';
import fs from 'node:fs';

const PRESETS = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      '/opt/qq-bridge/dsh/agent-presets/qq-chat-v2/agent.cordis.yml',
      '/opt/qq-bridge/dsh/agent-presets/qq-chat/agent.cordis.yml',
    ];

const LEN_RULE = '一条别太长：两行、六十字以内';

let pass = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  pass += 1;
  console.log('  ✓', msg);
};

// 从 YAML 文本里粗略取出 compaction-basic 的 config 段（顶层键 + modelPolicies 列表）
function readCompactionConfig(text) {
  const i = text.indexOf('- id: compaction-basic');
  assert.ok(i >= 0, 'compaction-basic 存在');
  const cfgAt = text.indexOf('      config:', i);
  assert.ok(cfgAt >= 0, 'compaction-basic 有 config');
  const tail = text.slice(cfgAt).split('\n');
  const top = {};
  const policies = [];
  let cur = null;
  let curIndent = -1;
  for (const line of tail.slice(1)) {
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    if (indent <= 6) break; // 出了 config 段
    const t = line.trim();
    if (t.startsWith('- provider:')) {
      curIndent = indent;
      cur = { provider: t.slice('- provider:'.length).trim() };
      policies.push(cur);
      continue;
    }
    if (cur && indent === curIndent + 2 && t.includes(':')) {
      const k = t.split(':')[0].trim();
      const v = t.slice(t.indexOf(':') + 1).trim();
      cur[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
      continue;
    }
    if (indent === 8) {
      cur = null;
      if (t.includes(':')) {
        const k = t.split(':')[0].trim();
        if (!k.startsWith('#')) top[k] = Number(t.slice(t.indexOf(':') + 1).trim());
      }
    }
  }
  return { top, policies };
}

for (const path of PRESETS) {
  console.log('·', path);
  const text = fs.readFileSync(path, 'utf8');
  const { top, policies } = readCompactionConfig(text);

  ok(Number.isFinite(top.thresholdRatio) && top.thresholdRatio > 0 && top.thresholdRatio <= 0.35,
    `顶层 thresholdRatio=${top.thresholdRatio} 落在 (0, 0.35]`);
  ok(Number.isFinite(top.retainRatio) && top.retainRatio < top.thresholdRatio,
    `顶层 retainRatio=${top.retainRatio} < thresholdRatio`);
  ok(Number.isFinite(top.headroomTokens) && top.headroomTokens >= 1000,
    `headroomTokens=${top.headroomTokens} ≥ 1000`);

  ok(policies.length === 4, `modelPolicies 有 4 条（实到 ${policies.length}）`);
  const key = (p) => `${p.provider}/${p.model}`;
  const wanted = [
    'our-free-model/deepseek/deepseek-v4.1-flash',
    'loomy/DeepSeek-V4.1-Flash',
    'trae/deepseek-v4.1-flash',
    'raccoon/sn-deepseek-v4-1-flash',
  ];
  for (const w of wanted) {
    const p = policies.find((x) => key(x) === w);
    ok(Boolean(p), `包含路由 ${w}`);
    ok(p && Number.isFinite(p.thresholdRatio) && p.retainRatio < p.thresholdRatio,
      `${w} 的 retainRatio(${p?.retainRatio}) < thresholdRatio(${p?.thresholdRatio})`);
  }
  const main = policies.find((p) => p.provider === 'our-free-model');
  ok(main && main.thresholdRatio === 0.12, 'our-free-model 钉在 0.12（1M 窗口 = 12 万才压）');

  const hits = text.split(LEN_RULE).length - 1;
  if (text.includes('【群聊不是客服队列】')) {
    ok(hits === 1, `二代仿真提示词里有且只有一条长度上限（${hits}）`);
  } else {
    ok(hits === 0, `旧版提示词不塞长度上限（${hits}）`);
  }
}

console.log(`\n全部通过：${pass} 项`);
