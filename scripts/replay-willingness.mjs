// 用**真实群聊时间轴**回放一遍意愿门：不是造数据，是拿 state/social-v2.json 里
// 三个群今天实际的消息时间，喂给 evaluateWillingness，看她会想开口几次。
//
// 目的：sim 用的是「平均 25 秒一条」的合成节奏，这里换成今天真发生过的时间间隔，
// 看档位在真实节奏下是否还站得住。
//
// 跑法：node scripts/replay-willingness.mjs
import fs from 'node:fs';
import path from 'node:path';
import { evaluateWillingness, consumeWillingness, describeWillingness } from '../src/willingness.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const S = JSON.parse(fs.readFileSync(path.join(ROOT, 'state/social-v2.json'), 'utf8'));

let liveCfg = {};
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  liveCfg = { ...(cfg?.socialV2?.wake?.willingness ?? {}), ...(cfg?.socialV2?.willingness ?? {}) };
} catch { /* 默认 */ }
const base = { ...liveCfg, rhythm: 'available' };

const stateOf = (key) => S.conversations?.[key] ?? {};

for (const key of Object.keys(S.conversations ?? {})) {
  if (!key.startsWith('group:')) continue;
  const msgs = (stateOf(key).recentMessages ?? [])
    .map((m) => ({
      t: Number(m.time) || 0,
      self: Boolean(m.isSelf || m.self || m.userId === 2157801858),
      plain: String(m.plain ?? m.text ?? '')
    }))
    .filter((m) => m.t > 0)
    .sort((a, b) => a.t - b.t);
  if (msgs.length < 5) continue;

  let st = { score: 0, updatedAt: 0, skipCount: 0 };
  const opens = [];
  let selfCount = 0;
  let othersCount = 0;

  for (let i = 0; i < msgs.length; i += 1) {
    const m = msgs[i];
    if (m.self) {
      selfCount += 1;
      // 她说过话 → 扣分 + 进抖动期
      st = { ...consumeWillingness(st, base, m.t), updatedAt: m.t };
      continue;
    }
    othersCount += 1;
    const prev = msgs[i - 1]?.t ?? m.t;
    const d = evaluateWillingness(st, base, {
      now: m.t,
      messageCount: 1,
      content: m.plain,
      quotedBot: false,
      reason: '',          // 只看「没人叫她、她能不能自己开口」
      rhythm: 'available'
    });
    st = d.state;
    if (d.shouldCall) {
      opens.push({ at: m.t, text: m.plain.slice(0, 18), d });
      // 真开口了就要走 consume：扣 replyCost + 进抖动期。
      // 不扣的话分数会一路涨到天花板，之后每条都「说」——那是脚本的错，不是模型的错。
      st = { ...consumeWillingness(st, base, m.t), updatedAt: m.t };
    }
  }

  const spanMin = othersCount ? ((msgs[msgs.length - 1].t - msgs[0].t) / 60000) : 0
  const gap = (arr) => {
    const h = arr.map((o) => new Date(o.at).toTimeString().slice(0, 5));
    return h.length ? h.join(' ') : '（无）';
  };
  console.log(`\n${key}  别人 ${othersCount} 条 / 她 ${selfCount} 条  跨度 ${spanMin.toFixed(0)} 分钟`);
  console.log(`  纯路过时她会想插话 ${opens.length} 次${opens.length ? `：${gap(opens)}` : ''}`);
  if (opens.length) {
    for (const o of opens.slice(0, 6)) console.log(`    ${new Date(o.at).toTimeString().slice(0, 5)}  ${describeWillingness(o.d)}   语境「${o.text}」`);
  }
}
