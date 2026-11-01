// 合并窗口（batch window）策略。
//
// 原来 `scheduleWakeV2` 的合并窗口是「一次性快照」：第一条消息进来就定下 8 秒后发送，
// 窗口内后续消息**只升级唤醒原因，不再延后**。于是她看到的是「8 秒前的半句话」，
// 群里接着说的那半句被下一轮再触发一次 —— 同一件事她回两遍，或者回了个过时的答案。
//
// 这里改成**滑动窗口**：每条新消息把期望时刻往后推到「最后一条 + baseMs」，
// 但整体封顶在「第一条 + maxMs」，防止有人一直刷屏把她永远拖着不开口。
//
// 纯函数，不碰定时器。bridge 里负责 setTimeout，这里只回答「该不该重排、重排到什么时候」。

export const BATCH_DEFAULTS = {
  baseMs: 8000,      // 最后一条之后至少再等这么久，够别人接上话
  maxMs: 30000,      // 从第一条算起最多拖这么久，不能无限延后
  extendOnNewMessage: true,
};

const nonNeg = (v, fallback) => {
  const x = Number(v);
  return Number.isFinite(x) && x >= 0 ? x : fallback;
};

/** 把配置里的裸数字/脏值收成一份可用的策略。`baseMs` 优先取 batchWindowMs（老键名）。 */
export function resolveBatchPolicy(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const baseRaw = Number(r.baseMs ?? r.batchWindowMs);
  const baseMs = Number.isFinite(baseRaw) && baseRaw > 0
    ? Math.max(1000, Math.round(baseRaw))
    : BATCH_DEFAULTS.baseMs;
  const maxRaw = Number(r.maxMs ?? r.maxBatchWindowMs);
  let maxMs = Number.isFinite(maxRaw) && maxRaw > 0 ? Math.round(maxRaw) : BATCH_DEFAULTS.maxMs;
  // 上限比基础窗口还小没有意义，直接抬到 baseMs（否则第一条消息就会被封顶卡住）
  if (maxMs < baseMs) maxMs = baseMs;
  return {
    baseMs,
    maxMs,
    extendOnNewMessage: r.extendOnNewMessage !== false,
  };
}

/**
 * 算这一批应该在什么时候发。
 *
 * 语义：`want = last + baseMs`（想再等一会儿），`cap = first + maxMs`（最多等到这里）。
 *   - 没封顶 → 等到 want
 *   - 封顶了 → 等到 cap
 *   - 算出来的时刻已经过去 → 立刻发（留 1ms 给 setTimeout，避免 0 延迟忙循环）
 *
 * @returns {{deadline:number, delayMs:number, capped:boolean, late:boolean, capAt:number}}
 */
export function planBatchWindow({ firstAt, lastAt, now, policy }) {
  const pol = policy && typeof policy === 'object' ? policy : BATCH_DEFAULTS;
  const baseMs = Number(pol.baseMs) > 0 ? Number(pol.baseMs) : BATCH_DEFAULTS.baseMs;
  const maxMs = Number(pol.maxMs) > 0 ? Number(pol.maxMs) : BATCH_DEFAULTS.maxMs;
  const n = nonNeg(now, Date.now());
  const first = nonNeg(firstAt, n);
  const last = nonNeg(lastAt, n);
  const want = last + baseMs;
  const capAt = first + maxMs;
  const capped = want > capAt;
  const target = Math.min(want, capAt);
  const late = target <= n;
  const deadline = late ? n + 1 : target;
  return { deadline, delayMs: deadline - n, capped, late, capAt };
}

/**
 * 新消息进来时，决定要不要重排定时器。
 *
 * 三条约束：
 *   1. 只往后推，绝不提前（提前会让「刚说完就被打断」）。
 *   2. 已经碰到 `first + maxMs` 上限就不要再推（让现有定时器自然到点）。
 *   3. `extendOnNewMessage=false` 时完全不延长，退回原来的快照行为。
 *
 * @returns {{rearm:boolean, deadline:number, delayMs:number, capped:boolean, reason:string}}
 */
export function decideRearm({ currentDeadline, firstAt, lastAt, now, policy }) {
  const pol = policy && typeof policy === 'object' ? policy : BATCH_DEFAULTS;
  const cur = nonNeg(currentDeadline, 0);
  const n = nonNeg(now, Date.now());
  const baseMs = Number(pol.baseMs) > 0 ? Number(pol.baseMs) : BATCH_DEFAULTS.baseMs;
  const maxMs = Number(pol.maxMs) > 0 ? Number(pol.maxMs) : BATCH_DEFAULTS.maxMs;
  const first = nonNeg(firstAt, n);
  const capAt = first + maxMs;

  if (pol.extendOnNewMessage === false) {
    return { rearm: false, deadline: cur, delayMs: Math.max(0, cur - n), capped: false, reason: '不延长' };
  }
  // 已经到上限（或过了上限）—— 不再重排，让现有定时器到点就发
  if (capAt <= n) {
    return { rearm: false, deadline: cur, delayMs: Math.max(0, cur - n), capped: true, reason: '已到上限，不再延后' };
  }
  const next = planBatchWindow({ firstAt: first, lastAt, now: n, policy: { baseMs, maxMs } });
  // 只往后推
  if (cur > 0 && next.deadline <= cur) {
    return { rearm: false, deadline: cur, delayMs: Math.max(0, cur - n), capped: next.capped, reason: '无变化' };
  }
  return {
    rearm: true,
    deadline: next.deadline,
    delayMs: next.delayMs,
    capped: next.capped,
    reason: next.capped ? '延长（已到上限）' : '延长',
  };
}
