// 隔离验证：直接调用**真实的 buildWakePromptV2**，确认日程/画像真的进了唤醒提示词。
//
// 用法（内部会 spawn 一个只导出函数的桥接副本，不启动服务）：
//   BRIDGE_TEST_EXPORT=1 node verify-wake-inject.mjs /tmp/isolated/src/bridge.js
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const bridgePath = process.argv[2] || '/tmp/isolated/src/bridge.js';
const dir = path.dirname(path.resolve(bridgePath));

let pass = 0;
let fail = 0;
const ok = (l, c, e = '') => {
  if (c) { pass += 1; console.log(`  ✔ ${l}`); } else { fail += 1; console.log(`  ✖ ${l}${e ? ' — ' + e : ''}`); }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// 子进程：把 bridge 副本载入，取到真实函数后立刻停（脚本里已保证不启动服务）。
const driver = `
const mod = await import(${JSON.stringify(path.resolve(bridgePath))});
// 等 main() 把钩子挂上（main 是异步的，但钩子在开头同步挂）
for (let i = 0; i < 100; i++) {
  if (globalThis.__bridgeTestReady) break;
  await new Promise((r) => setTimeout(r, 50));
}
const t = globalThis.__bridgeTest;
if (!t) { console.log(JSON.stringify({ error: 'no hook' })); process.exit(0); }
const key = 'group:906710082';
const out = {
  hasScheduleFn: typeof t.formatScheduleForPrompt === 'function',
  hasPortraitFn: typeof t.formatPortraitForPrompt === 'function'
};
try {
  const st = t.getSocialV2State(key);
  const prompt = t.buildWakePromptV2(key, 'question');
  out.promptLen = prompt.length;
  out.hasSchedule = prompt.includes('【他的日程】');
  out.hasPortrait = prompt.includes('【你对他们这些人的长期认识】');
  out.hasScheduleReview = prompt.includes('【日程结算】');
  // 抓出日程那一段
  const i = prompt.indexOf('【他的日程】');
  out.scheduleBlock = i >= 0 ? prompt.slice(i, prompt.indexOf('\\n\\n', i) + 1) : null;
  const p = prompt.indexOf('【你对他们这些人的长期认识】');
  out.portraitBlock = p >= 0 ? prompt.slice(p, prompt.indexOf('\\n\\n', p) + 1) : null;
  out.orderScheduleBeforePortrait = (i >= 0 && p >= 0) ? i < p : null;
  out.memoryBeforeSchedule = prompt.indexOf('【对群友的印象】') < i || i < 0;
} catch (e) {
  out.error = String(e && e.message || e);
}
console.log(JSON.stringify(out));
process.exit(0);
`;

const file = path.join(dir, '.verify-wake-driver.mjs');
fs.writeFileSync(file, driver, 'utf8');

const child = spawn(process.execPath, [file], {
  env: { ...process.env, BRIDGE_TEST_EXPORT: '1', BRIDGE_NO_MAIN: '1' },
  cwd: dir,
  stdio: ['ignore', 'pipe', 'pipe']
});

let stdout = '';
let stderr = '';
child.stdout.on('data', (d) => { stdout += d.toString(); });
child.stderr.on('data', (d) => { stderr += d.toString(); });

const timer = setTimeout(() => { try { child.kill(); } catch {} }, 30000);

child.on('close', () => {
  clearTimeout(timer);
  try { fs.unlinkSync(file); } catch {}
  let out = null;
  try { out = JSON.parse(stdout.trim().split('\n').pop()); } catch {}

  section('真实 buildWakePromptV2 的产物');
  if (!out) {
    ok('子进程有输出', false, `stdout=${JSON.stringify(stdout.slice(0, 300))} stderr=${JSON.stringify(stderr.slice(0, 500))}`);
  } else if (out.error) {
    ok('函数可调用', false, out.error);
  } else {
    ok('拿到了真实函数', out.hasScheduleFn && out.hasPortraitFn);
    ok('生成了唤醒提示词', typeof out.promptLen === 'number' && out.promptLen > 1000, `len=${out.promptLen}`);
    ok('唤醒提示词里有【他的日程】', out.hasSchedule === true);
    ok('唤醒提示词里有【长期认识】', out.hasPortrait === true);
    ok('日程在画像之前（短期→长期）', out.orderScheduleBeforePortrait === true);
    if (out.scheduleBlock) {
      console.log('---- 唤醒里的日程段 ----');
      console.log(out.scheduleBlock);
      console.log('------------------------');
    }
    if (out.portraitBlock) {
      console.log('---- 唤醒里的画像段 ----');
      console.log(out.portraitBlock);
      console.log('------------------------');
    }
  }
  console.log(`\n════ 通过 ${pass} / 失败 ${fail} ════`);
  process.exit(fail ? 1 : 0);
});
