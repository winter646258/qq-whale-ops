// 学习会话（视觉 / 黑话 / 结算共用）的「这一轮算不算数」判定。
//
// 抽出来单独放，是因为它是三处调用方共同的失败源头：turn 明明 completed，
// 但一个字都没输出 —— 模型把正文吞了、或者上游提前收尾。旧代码一律当彻底失败，
// 于是视觉识别、黑话研究、结算三件事一起漏，日志里只留一句
// 「学习会话 turn 未正常完成：completed」，看不出该重试还是该放弃。
//
// 现在的口径：
//   completed + 有正文            → resolve
//   completed + 空正文 + 未重试过 → retry（原地补一句，再等一轮）
//   completed + 空正文 + 重试过了 → reject（写清是空回复，不是 error）
//   其它（error / aborted / …）   → reject，原样带上 kind
export const LEARNER_RETRY_NUDGE = '上一次你一个字都没输出。请直接按要求输出内容，不要留空，也不要只回「收到」。';

export function learnerOutcome({ kind = '', text = '', retried = false } = {}) {
  const k = String(kind ?? '').trim();
  const body = String(text ?? '').trim();
  if (k === 'completed' && body) {
    return { action: 'resolve', reason: k, text: body };
  }
  if (k === 'completed') {
    return retried
      ? { action: 'reject', reason: 'completed（空回复，已重试一次）' }
      : { action: 'retry', reason: 'empty-completed' };
  }
  return { action: 'reject', reason: k || 'unknown' };
}