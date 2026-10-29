// 端到端：真网刷一轮，看 browseRound 与注入文本长什么样。
import { createBiliDirect } from '../src/bili-direct.js';
import { BiliClient } from '../src/site-bili.js';
import { watchBiliVideo } from '../src/bili-watch.js';
import { browseRound, browsePromptLine } from '../src/bili-browse.js';

const log = (m) => console.log(m);
const direct = createBiliDirect({ stateFile: '/opt/qq-bridge/state/bili-cookie.json', log });
const client = new BiliClient({ direct, log });

const t0 = Date.now();
const r = await browseRound({
  client,
  // 强制看一个，别让它随机跳过
  watch: (args) => watchBiliVideo({ direct, ...args, log }),
  log,
  rand: () => 0.05,
  cfg: { maxItems: 3 }
});

console.log(`\n=== 结果（${Date.now() - t0}ms）ok=${r.ok} ===`);
if (!r.ok) {
  console.log(`FAIL ${r.error}`);
  process.exit(1);
}
for (const it of r.items) {
  console.log(`· 「${it.title}」${it.author} ${it.duration}s ${it.view}播放`);
  console.log(`  desc: ${it.desc || '(空)'}`);
  console.log(`  热评: ${it.comments.map((c) => `${c.user}:${c.text}`).join(' | ') || '(没拿到)'}`);
}
console.log(`\nwatched: ${JSON.stringify(r.watched)}`);

console.log('\n=== 注入文本 ===');
console.log(browsePromptLine(r, Date.now()));

console.log('\n=== 注入文本长度（字符） ===');
console.log(browsePromptLine(r, Date.now()).length);
