// 代码层自动记忆：从「用户消息」里按固定规则抽一句值得跨会话记住的话。
//
// 为什么写在代码里：提示词那套（qq_memory 系列）三个月里她一次都没主动用过，
// 私聊里教的称呼/偏好/约定，群里完全看不到。靠提示词软约束等于没有。
//
// 原则：宁缺毋滥。
//   - 只抽 称呼 / 要求 / 约定 / 偏好 四类，每回合最多一条；
//   - 命中系统注入段（【唤醒】【表情包策略】……）整条跳过，绝不从提示词里学；
//   - 带「以后再说 / 下次吧 / 算了」这类松弛词的丢弃。

const SYSTEM_MARKERS = [
  '【唤醒】', '【表情包策略', '【可用表情包】', '【当前角色】', '【断句】', '【收尾】',
  '【记忆', '【你怎么看', '【反AI味】', '【本次消息快照】', '【会话令牌】', '【沉睡前', '【首回复节奏】',
  '【积极性】', '【图片】', '【画画】', '【参与', '【唤醒配置', '【近况', '【情绪', '【日程', '【画像'
];

const RULES = [
  { kind: '称呼', importance: 8, re: /(?:以后|从今往后|从现在起|就)?(?:叫我|称呼我|喊我)([^\s，。,.!?！？、]{1,12})/u },
  { kind: '要求', importance: 7, re: /(?:记住|别忘了|记一下|不要忘|要记得|你记着)([^。！？\n]{2,40})/u },
  { kind: '约定', importance: 7, re: /(?:以后|下次|今后|每天早上|每天晚上|每周|每天|每次)([^。！？\n]{2,40})/u },
  { kind: '偏好', importance: 6, re: /(我(?:最)?(?:喜欢|讨厌|不喜欢|爱吃|不爱吃|受不了|习惯))([^。！？\n]{2,30})/u }
];

const NOISE = ['以后再说', '下次吧', '算了', '随口', '开玩笑', '不用记', '随便说', '以后别忘了我', '下次一定'];

export function looksLikeSystemPrompt(text) {
  const s = String(text ?? '');
  return SYSTEM_MARKERS.some((m) => s.includes(m));
}

/**
 * 抽候选记忆，按 importance 降序返回。
 * @param {string} userText
 * @param {{max?: number, who?: string}} opts
 * @returns {Array<{kind: string, text: string, importance: number}>}
 */
export function extractMemories(userText, { max = 1, who = '主人' } = {}) {
  const raw = String(userText ?? '').replace(/\s+/g, ' ').trim();
  if (!raw || raw.length > 2000) return [];
  if (looksLikeSystemPrompt(raw)) return [];
  const found = [];
  for (const rule of RULES) {
    const m = raw.match(rule.re);
    if (!m) continue;
    const phrase = String(m[1] ?? '').trim();
    if (phrase.length < 2) continue;
    if (NOISE.some((n) => phrase.includes(n) || raw.includes(n))) continue;
    const said = String(m[0]).trim().slice(0, 70);
    if (said.length < 3) continue;
    found.push({ kind: rule.kind, text: `${who}说过：${said}`, importance: rule.importance });
  }
  const seen = new Set();
  return found
    .filter((it) => (seen.has(it.text) ? false : (seen.add(it.text), true)))
    .sort((a, b) => b.importance - a.importance)
    .slice(0, Math.max(1, Number(max) || 1));
}

const PRIVATE_RE = /密码|手机号|身份证|住址|地址|银行卡|工资|真名|身份证号/;

/** 隐私内容不进所有群，只放 owner_private。 */
export function scopeForText(text) {
  return PRIVATE_RE.test(String(text ?? '')) ? 'owner_private' : 'shared';
}