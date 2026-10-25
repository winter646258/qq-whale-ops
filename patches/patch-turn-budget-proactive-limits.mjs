#!/usr/bin/env node
// 一次性补丁：回合硬预算（P0-1）+ 主动冒泡硬上限（P0-2）
//
// 背景（2026-10-24 实测）
//   1) turn 15 跑了 52 分 19 秒、129 次工具调用、51 条发送才收尾。三层防护全被
//      「活跃型失控」穿透：preSleepWaitSatisfied 在活跃群恒 false（她永不自认能睡）、
//      noActionLimit 被 actionTaken=true 绕过（她一直在发消息）、没有任何回合
//      时长/步数上限；限流 8/分钟、150/小时远拦不住。
//   2) proactive 只有 idleThreshold + probability 再乘四个折扣系数，缺 minInterval /
//      maxPerHour / quietHours ⇒ 深夜照样排档期，刚冒过泡也不会停。
//
// 本补丁只加约束，不改判断逻辑
//   A. turn-budget：每回合记 steps/sends/时长，触到任一上限就掐掉本回合
//      （复用已有的 api.stopSessionWork，它内部就是 session/cancel + 清队列），
//      并把「上一轮被硬停」记进 state/wake-config-grace.json，下一轮唤醒时
//      注入提示词 —— 否则她不知道是自己说完的还是被掐的，会接着同一话题无限续。
//   B. proactive-limits：minIntervalMs / maxPerHour / quietHours（默认 23:00-08:00，
//      支持跨午夜）+ capProbability，硬闸放在四个乘法折扣之后，0 就是 0。
//
// 幂等：每个插入点独立 MARKER，重跑全部跳过。
// 用法：node patches/patch-turn-budget-proactive-limits.mjs [--dry-run]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = '/opt/qq-bridge';
const BRIDGE = path.join(ROOT, 'src/bridge.js');
const dryRun = process.argv.includes('--dry-run');

let src = fs.readFileSync(BRIDGE, 'utf8');
const before = src.length;
const applied = [];
const skipped = [];

function once(name, needle, insert, where = 'before') {
  if (src.includes(`// MARKER: ${name}\n`)) { skipped.push(name); return; }
  const idx = src.indexOf(needle);
  if (idx < 0) throw new Error(`锚点未找到（${name}）：${needle.slice(0, 70)}`);
  if (src.indexOf(needle, idx + 1) >= 0) throw new Error(`锚点不唯一（${name}）：${needle.slice(0, 70)}`);
  const at = where === 'before' ? idx : idx + needle.length;
  src = src.slice(0, at) + insert + src.slice(at);
  applied.push(name);
}

// 替换型：把 needle 整段换成 replacement。用于「在原有行里插入新段」的场景——
// 用 once(..., 'before') 会把原文一起留下，变成两行同名声明。
function swap(name, needle, replacement) {
  if (src.includes(`// MARKER: ${name}\n`)) { skipped.push(name); return; }
  const idx = src.indexOf(needle);
  if (idx < 0) throw new Error(`锚点未找到（${name}）：${needle.slice(0, 70)}`);
  if (src.indexOf(needle, idx + 1) >= 0) throw new Error(`锚点不唯一（${name}）：${needle.slice(0, 70)}`);
  src = src.slice(0, idx) + replacement + src.slice(idx + needle.length);
  applied.push(name);
}

// ───────────── A1. 容器 + 辅助函数（锚点：v2TurnStartAt 声明）─────────────
once(
  'turn-budget',
  '  const v2TurnStartAt = new Map(); // sessionId -> timestamp：reserved2 turn 开始时间，用于判断是否“无行动”\n',
  `  // MARKER: turn-budget
  // 回合硬预算。与内容彻底无关的兜底闸门：她已经证明「判断没错但停不下来」
  // （turn 15 在群里配合玩梗，52 分钟 129 次工具调用），所以不能再靠提示词自律。
  const turnBudgetLedger = new Map(); // sessionId -> { startedAt, steps, sends, cancelled, reason }
  const TURN_BUDGET_GRACE_FILE = path.join(STATE_DIR, 'wake-config-grace.json');
  function turnBudgetCfg() {
    const b = cfg.socialV2?.turnBudget ?? {};
    const pick = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : d);
    // 正常回合 2–10 分钟 / 10–15 次工具 / 2–4 条发送，这里留 3–4 倍余量
    return { maxSteps: pick(b.maxSteps, 40), maxMs: pick(b.maxMs, 600000), maxSends: pick(b.maxSends, 8) };
  }
  function turnBudgetFor(sessionId) {
    let entry = turnBudgetLedger.get(sessionId);
    if (!entry) {
      entry = { startedAt: Date.now(), steps: 0, sends: 0, cancelled: false, reason: '' };
      turnBudgetLedger.set(sessionId, entry);
    }
    return entry;
  }
  function readGraceNotes() {
    try {
      const parsed = JSON.parse(fs.readFileSync(TURN_BUDGET_GRACE_FILE, 'utf8'));
      return parsed && typeof parsed === 'object' && parsed.notes && typeof parsed.notes === 'object' ? parsed.notes : {};
    } catch { return {}; }
  }
  function writeGraceNote(key, note) {
    try {
      const notes = readGraceNotes();
      if (note) notes[key] = note; else delete notes[key];
      const trimmed = Object.fromEntries(Object.entries(notes).slice(-50));
      const tmp = \`\${TURN_BUDGET_GRACE_FILE}.tmp\`;
      fs.writeFileSync(tmp, JSON.stringify({ notes: trimmed }, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, TURN_BUDGET_GRACE_FILE);
    } catch (error) {
      log('[turn-budget] 写 grace 失败：', error?.message ?? error);
    }
  }
  function noteTurnBudgetStep(key, sessionId) {
    if (!key || !sessionId) return;
    const b = turnBudgetCfg();
    const entry = turnBudgetFor(sessionId);
    entry.steps += 1;
    if (entry.cancelled) return;
    if (entry.steps > b.maxSteps) { void cancelTurnForBudget(key, sessionId, entry, \`步数 \${entry.steps} > \${b.maxSteps}\`); return; }
    if (Date.now() - entry.startedAt > b.maxMs) { void cancelTurnForBudget(key, sessionId, entry, \`时长超 \${Math.round(b.maxMs / 60000)} 分钟\`); }
  }
  function noteTurnBudgetSend(key, sessionId) {
    if (!key || !sessionId) return;
    const b = turnBudgetCfg();
    const entry = turnBudgetFor(sessionId);
    entry.sends += 1;
    if (entry.cancelled) return;
    if (entry.sends > b.maxSends) { void cancelTurnForBudget(key, sessionId, entry, \`发送 \${entry.sends} 条 > \${b.maxSends}\`); }
  }
  // 掐回合。不抛错：调用方是 tool/result 处理流，抛了会连带吞掉正常逻辑。
  async function cancelTurnForBudget(key, sessionId, entry, why) {
    if (entry.cancelled) return;
    entry.cancelled = true;
    entry.reason = why;
    const elapsedMs = Date.now() - entry.startedAt;
    log(\`[turn-budget] 超上限（\${why}）：\${key} 已跑 \${Math.round(elapsedMs / 1000)}s / \${entry.steps} 步 / \${entry.sends} 条，掐掉本回合\`);
    appendActivity(\`\${key} [turn-budget] 超上限（\${why}），已中止回合\`);
    // stopSessionWork = 清队列 + session/cancel + archiveSession，是桥接现成且唯一的
    // 「让 DSH 停下这个会话」入口（见 stopRetiredSessionWork 的注释）。别自己拼 cancel。
    try {
      await api.stopSessionWork(sessionId);
    } catch (error) {
      log('[turn-budget] 中止回合失败（DSH 侧可能仍在内跑）：', error?.message ?? error);
    }
    writeGraceNote(key, {
      at: Date.now(), reason: why,
      elapsedSec: Math.round(elapsedMs / 1000), steps: entry.steps, sends: entry.sends
    });
  }
`,
  'before'
);

// ───────────── A2. turn/start 重置账本 ─────────────
once(
  'turn-budget-start',
  '              v2TurnStartAt.set(frame.sessionId, Date.now());\n',
  '              turnBudgetLedger.set(frame.sessionId, { startedAt: Date.now(), steps: 0, sends: 0, cancelled: false, reason: \'\' }); // MARKER: turn-budget-start\n',
  'after'
);

// ───────────── A3. 每个 tool/result 计一步（锚点：collector.push 之前）─────────────
// 替换型：once('before') 会把 anchor 原文留在后面，插入段里已含原文 ⇒ 重复声明 collector。
swap(
  'turn-budget-step',
  `            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
`,
  `            // MARKER: turn-budget-step —— 只有 tool/result 才计步。
            // 一次「工具调用 + 工具结果」算一步，所以这里计一次就够；
            // 放在 collector.push 之前是为了让超限的这一帧也能正常走完收集。
            if (frame.event.type === 'tool/result') noteTurnBudgetStep(key, frame.sessionId);
            const collector = collectors.get(frame.sessionId) ?? createTurnCollector();
            collectors.set(frame.sessionId, collector);
            const ended = collector.push(frame.event);
`
);

// ───────────── A4. turn/end 清账 + 记日志（替换型）─────────────
swap(
  'turn-budget-end',
  `              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
`,
  `              { // MARKER: turn-budget-end
                const budget = turnBudgetLedger.get(frame.sessionId);
                if (budget) {
                  const elapsedSec = Math.round((Date.now() - budget.startedAt) / 1000);
                  // 正常收尾就撤掉 grace：否则下一轮她会一直以为上一轮被掐了。
                  if (!budget.cancelled) writeGraceNote(key, null);
                  if (elapsedSec >= 300 || budget.steps >= 30 || budget.cancelled) {
                    log(\`[turn-budget] \${key} 回合 \${elapsedSec}s / \${budget.steps} 步 / \${budget.sends} 条\${budget.cancelled ? \`（已中止：\${budget.reason}）\` : ''}\`);
                  }
                  turnBudgetLedger.delete(frame.sessionId);
                }
              }
              collectors.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
`
);

// ───────────── A5. 发送成功计一条 ─────────────
once(
  'turn-budget-send',
  '            log(`[reserved2] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);\n',
  '            if (sentMessages.length > 0) noteTurnBudgetSend(key, state.sessions[key]); // MARKER: turn-budget-send\n',
  'after'
);
once(
  'turn-budget-send-sticker',
  '            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);\n',
  '            noteTurnBudgetSend(key, state.sessions[key]); // MARKER: turn-budget-send-sticker\n',
  'after'
);

// ───────────── A6. 被掐过的回合，下一轮告诉她 ─────────────
// 用一个 swap 同时完成两件事：把 graceLine 拼进 base，再在它前面插入计算段。
// 分两步用 once('before') 会得到两行 `const base = ...`（只插不替换）。
swap(
  'turn-budget-grace-base',
  'const base = roleLine + tokenLine + antiAiLine + proactiveLine + stickerLine',
  'const base = roleLine + tokenLine + graceLine + antiAiLine + proactiveLine + stickerLine'
);
once(
  'turn-budget-grace-inject',
  '    const base = roleLine + tokenLine + graceLine + antiAiLine + proactiveLine + stickerLine',
  `    // MARKER: turn-budget-grace-inject
    // 上一轮如果是被硬停的，这一轮必须先告诉她 —— 否则她以为是自己说完的，
    // 会接着同一个话题继续发，把「被打断」变成「主动续话」。
    let graceLine = '';
    try {
      const note = readGraceNotes()[key];
      if (note && note.at) {
        graceLine = \`【上一轮被打断】上一轮你不是自己说完的：跑了 \${note.elapsedSec} 秒、\${note.steps} 次工具、发了 \${note.sends} 条，被系统掐掉了（\${note.reason}）。这一轮只做一件事：看一眼现在群里在说什么，回一条就够了，然后收尾。不要接着上一轮的话尾继续补，也不要解释为什么断开。\\n\\n\`;
        writeGraceNote(key, null);
      }
    } catch (error) {
      log('[turn-budget] grace 注入跳过：', error?.message ?? error);
    }
`,
  'before'
);

// ───────────── B1. proactive 上限辅助（锚点：scheduleProactiveCheckV2 定义前）─────────────
once(
  'proactive-limits',
  `  function scheduleProactiveCheckV2(key, opts = {}) {
`,
  `  // MARKER: proactive-limits
  // 原来只有 idleThresholdMs + probability 再乘四个折扣（回话后 ×0.5、夜里 ×0.3、
  // 一小时内发过 5 条 ×0.3）。乘法永远到不了 0，所以深夜照样排档期、刚说完也不停。
  // 参照 ATLES 的 proactive 配置补三个硬闸：
  //   1) 距上次 AI 发言 < minIntervalMs → 0（不是 ×0.5）
  //   2) 近一小时已冒泡 ≥ maxPerHour 次 → 0
  //   3) quietHours（默认 23:00-08:00，支持跨午夜）→ 0（不是 ×0.3）
  function proactiveLimitsCfg() {
    const p = cfg.socialV2?.proactive ?? {};
    const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    return {
      minIntervalMs: num(p.minIntervalMs, 45 * 60 * 1000),
      maxPerHour: Math.max(1, Math.floor(num(p.maxPerHour, 2))),
      quietHours: p.quietHours === null ? null : (p.quietHours ?? { start: 23, end: 8 }),
      capProbability: Math.min(1, Math.max(0, num(p.capProbability, 0.5)))
    };
  }
  function inQuietHours(hours, date = new Date()) {
    if (!hours) return false;
    const start = Number(hours.start);
    const end = Number(hours.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start === end) return false;
    const h = date.getHours();
    return start < end ? (h >= start && h < end) : (h >= start || h < end); // 支持 23→8 跨午夜
  }
  // 返 0 = 这一轮不许冒泡；返 >0 = 允许的概率上限
  function proactiveHardCapV2(key, st) {
    const limits = proactiveLimitsCfg();
    if (inQuietHours(limits.quietHours)) return 0;
    const now = Date.now();
    if (st.lastAiReplyAt && now - Number(st.lastAiReplyAt) < limits.minIntervalMs) return 0;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiLastHour = recent.filter((m) => m && m.isSelf && now - Number(m.time || 0) < 60 * 60 * 1000).length;
    if (aiLastHour >= limits.maxPerHour) return 0;
    return limits.capProbability;
  }
  function scheduleProactiveCheckV2(key, opts = {}) {
`,
  'before'
);

// ───────────── B2. 硬闸接进判定（替换型：把原来的 if 整行换掉）─────────────
swap(
  'proactive-limits-apply',
  '      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {\n',
  `      // MARKER: proactive-limits-apply —— 硬闸放在四个乘法折扣之后，
      // 0 就是 0，不会被任何公式抬回来。
      const hardCap = proactiveHardCapV2(key, st);
      if (hardCap <= 0) {
        log(\`[reserved2] proactive 跳过 \${key}（安静时段/刚说过/本小时已到上限）\`);
      } else {
        prob = Math.min(prob, hardCap);
      }
      if (hardCap > 0 && idle >= idleThreshold && Math.random() < prob && !isConversationBusyV2(key, st)) {
`
);

// ───────────── C. defaultConfig 补默认值 ────
once(
  'turn-budget-config',
  `      proactive: {
        enabled: true,
`,
  `      // MARKER: turn-budget-config —— 回合硬预算默认值（见 turn-budget 段注释）
      turnBudget: {
        maxSteps: 40,        // 单回合工具调用次数上限
        maxMs: 600000,       // 单回合时长上限（10 分钟）
        maxSends: 8          // 单回合发送条数上限
      },
`,
  'before'
);
// `proactive.limits` 的默认值：只在 `probability: 0.3` 这一行后面追加（swap，单行锚点）。
// 历史教训：曾经把锚点写成「probability: 0.3 + 结束大括号 + feedback: {」再整段带回，
// 结果末尾多拼了一次 `feedback: {`，花括号净 +1，成了 `SyntaxError: Unexpected reserved word`
// （因为 main() 的闭合括号被顶掉，后面的 `await` 落到了函数外）。
// 现在只匹配单行，绝不跨行。
swap(
  'proactive-limits-config',
  `        probability: 0.3
`,
  `        probability: 0.3,
        // MARKER: proactive-limits-config —— 三个硬闸，null 表示关闭该项
        minIntervalMs: 45 * 60 * 1000,                        // 距上次自己发言不足这个间隔就不冒
        maxPerHour: 2,                                        // 每小时最多主动冒泡次数
        quietHours: { start: 23, end: 8 },                    // 安静时段直接不冒（支持跨午夜）
        capProbability: 0.5                                   // 概率上限（再乘折扣也只降不升）
`
);

// ───────────── 写盘 ─────────────
if (dryRun) {
  console.log('[dry-run] 将打上：', applied.length ? applied.join(', ') : '（无）');
  console.log('[dry-run] 已存在跳过：', skipped.length ? skipped.join(', ') : '（无）');
  console.log('[dry-run] 新长度：', src.length, '（原', before, '）');
  process.exit(0);
}
if (applied.length === 0) { console.log('全部已存在，无需修改：', skipped.join(', ')); process.exit(0); }

const stamp = (() => {
  const d = new Date(); const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}${z(d.getSeconds())}`;
})();
const bak = `${BRIDGE}.bak-turnbudget-${stamp}`;
fs.copyFileSync(BRIDGE, bak);
const tmp = path.join(ROOT, 'src/.bridge-turnbudget.tmp.js');
fs.writeFileSync(tmp, src);
console.log('临时文件：', tmp, src.length, '字节（原', before, '）');
console.log('备份：', bak);
console.log('打上：', applied.join(', '));
console.log('跳过：', skipped.length ? skipped.join(', ') : '（无）');
console.log('下一步：node --check ' + tmp + ' 通过后 mv 覆盖');
