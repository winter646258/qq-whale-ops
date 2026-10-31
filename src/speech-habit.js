/**
 * 说话习惯的即时纠偏。
 *
 * 为什么要有这个文件：角色卡只能写「别老提某某」，模型照样会连着三轮都提。
 * 真正管用的是「它刚才已经说过了」这个事实 —— 那是当下信息，不是设定。
 * 所以这里只做一件事：看她自己最近几条发言，命中了就递一句「这次换个说法」。
 *
 * 纯函数，不读文件、不看时钟，便于单测。
 */

export const HABIT_DEFAULTS = {
  // 看最近几条她自己说的话。6 条大约覆盖 2~3 个回合，再往前就跟当下无关了。
  lookback: 6,
  // 引用原话的长度。太长会喧宾夺主，太短认不出是哪一句。
  quoteChars: 16,
};

/**
 * 饭族词。
 * 刻意不写裸的「饭」——「饭点」「饭店」是别人的话题，不该触发。
 * 「碗」只在搭配里才算（一碗/这碗/端碗/碗里/碗底），避免「碗柜」「碗筷」误伤。
 */
const RICE_RE = /白饭|干饭|饭团|饭盆|泡面|馒头|一碗|这碗|那碗|半碗|碗里|碗底|端碗|扒饭/;

/** 从一条会话消息里取正文。plain 是去掉 @ 与表情占位后的干净文本。 */
function textOf(message) {
  if (!message || typeof message !== 'object') return '';
  const raw = message.plain != null ? message.plain : message.text;
  return String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
}

/**
 * 截一段带命中的原话。
 * 不能从第一个字开始截——她的话常常前面铺垫一大句，截出来是「一只蓝鲸游过深夜…」，
 * 模型看到会一脸问号「我什么时候说过」。要从命中词前后各取一点。
 */
function quoteAround(body, chars) {
  const hit = RICE_RE.exec(body);
  if (!hit) return body.slice(0, chars);
  const start = Math.max(0, hit.index - Math.floor(chars / 3));
  const end = Math.min(body.length, start + chars);
  const head = start > 0 ? '…' : '';
  const tail = end < body.length ? '…' : '';
  return `${head}${body.slice(start, end)}${tail}`;
}

/**
 * 她自己最近几条发言里提过饭/碗/馒头，就返回一句提醒；没提过返回空串。
 *
 * 返回空串是常态（绝大多数回合都不该出现这句），所以调用方直接拼进提示词即可，
 * 不需要额外判断 —— 空串拼上去什么都不多花。
 *
 * @param {Array} messages 会话的 recentMessages（含 isSelf 标记）
 * @param {object} [opts]
 * @returns {string}
 */
export function riceEchoLine(messages, opts = {}) {
  try {
    const lookback = Math.max(1, Number(opts.lookback) || HABIT_DEFAULTS.lookback);
    const quoteChars = Math.max(4, Number(opts.quoteChars) || HABIT_DEFAULTS.quoteChars);
    const list = Array.isArray(messages) ? messages : [];

    const mine = [];
    for (const message of list) {
      if (!message || !message.isSelf) continue;
      const body = textOf(message);
      if (body) mine.push(body);
    }

    const hits = mine.slice(-lookback).filter((body) => RICE_RE.test(body));
    if (!hits.length) return '';

    const quote = quoteAround(hits[hits.length - 1], quoteChars);
    const how = hits.length >= 2
      ? `最近 ${hits.length} 条里你提了 ${hits.length} 次`
      : '你上一条已经提过一次';

    // 「这是设定，不是每句话的比喻」这句不能删：她不是不知道白饭是什么，
    // 是把它当成了万能自嘲素材。要说清的是用法边界，不是这个词的意思。
    return `【别再说白饭】${how}（「${quote}」）。这一轮换别的说，别再提饭、碗、馒头这些吃的——这是设定，不是每句话的比喻。\n\n`;
  } catch {
    return '';
  }
}
