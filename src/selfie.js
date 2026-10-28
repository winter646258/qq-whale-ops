// MARKER: selfie —— 自拍 / 合照：用一张「她自己」的参考图，换场景不换人。
//
// 为什么要有这个模块：
// 纯文字生图每次都是「另一个人」——她的蓝白长发、呆毛、女仆发箍靠文字描述是靠不住的。
// 2026-10-28 的探针证明中转的 `/images/edits` 吃参考图（品红底黄方块原样保住，
// 换场景后人物身份也保住了），所以这里只做两件事：把「她是谁」写成一段固定的身份锁，
// 把「在哪儿、在干什么」交给她自己填。
//
// 合照的默认立场写进注释，免得以后有人以为是漏了：**不给他画正脸**。
// 画错一张脸比缺一张合照糟糕得多 —— 认不出的人出现在「我们的合照」里最伤人。
// 所以合照模式只出现他的肩膀、手臂、背影，或者干脆两个人都不露脸（手牵手、并排坐着看海）。

export const SELFIE_DEFAULTS = {
  enabled: true,
  style: 'photo',        // photo | sketchbook
  size: '1024x1024',
  maxPerDay: 3,
  sceneChars: 120,
  promptChars: 900,
  partnerFace: 'avoid',  // avoid | allow
};

// 身份锁：这几行必须逐字稳定。改它等于换人。
export const SELFIE_IDENTITY = [
  '同一位角色，不要改她的长相：',
  '蓝色到白色渐变的长发（发梢偏白），蓝色眼睛，头顶一根呆毛，戴白色荷叶边女仆发箍；',
  '穿蓝白配色的女仆装（白色围裙、蓝色蝴蝶结），身后有一条鲸鱼尾巴；',
  '圆润一点的少女身材，表情柔和。',
].join('');

export const SELFIE_STYLES = {
  photo: '手机自拍/生活照的质感：自然光、轻微手抖、皮肤细节真实，像随手拍的不是摆拍；不要影楼打光，不要精修。',
  sketchbook: '铅笔加彩铅的手绘手账风格：可见的铅笔线条和排线、柔和的彩铅上色、手绘轮廓略微不齐，像画在速写本上。',
};

export const SELFIE_SCENES = {
  家里: '在家的房间书桌边，穿常服，桌上散着纸和笔，背景是书架',
  咖啡店: '在窗边的咖啡店里，手边一杯热饮，窗外有街景',
  街上: '在傍晚的街上走着，路灯刚亮，远处是店铺招牌',
  海边: '在海边，风把头发吹起来，远处是海平线和云',
  夜里: '在自己房间，只开一盏小台灯，屏幕的光照在脸上',
};

export const SELFIE_GUARD = '画面里不要出现任何文字、字母、水印、签名、边框。';

function num(v, d, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  if (!Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

export function selfieCfg(cfg) {
  const raw = cfg?.socialV2?.selfie;
  const src = raw && typeof raw === 'object' ? raw : {};
  const style = String(src.style ?? SELFIE_DEFAULTS.style);
  return {
    enabled: src.enabled !== false,
    style: Object.prototype.hasOwnProperty.call(SELFIE_STYLES, style) ? style : SELFIE_DEFAULTS.style,
    size: String(src.size ?? SELFIE_DEFAULTS.size).slice(0, 20),
    maxPerDay: num(src.maxPerDay, SELFIE_DEFAULTS.maxPerDay, { min: 0, max: 20 }),
    sceneChars: num(src.sceneChars, SELFIE_DEFAULTS.sceneChars, { min: 10, max: 400 }),
    promptChars: num(src.promptChars, SELFIE_DEFAULTS.promptChars, { min: 200, max: 2000 }),
    partnerFace: String(src.partnerFace ?? SELFIE_DEFAULTS.partnerFace) === 'allow' ? 'allow' : 'avoid',
  };
}

export function cleanScene(scene, cfg = SELFIE_DEFAULTS) {
  const s = String(scene ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > cfg.sceneChars ? s.slice(0, Math.max(1, cfg.sceneChars - 1)) + '…' : s;
}

// 认预设场景（「咖啡店」这类），认不出就用她给的原话。
export function resolveScene(scene, cfg = SELFIE_DEFAULTS) {
  const s = cleanScene(scene, cfg);
  if (!s) return { text: SELFIE_SCENES.家里, keyword: '家里' };
  for (const [k, v] of Object.entries(SELFIE_SCENES)) {
    if (s.includes(k)) return { text: v, keyword: k };
  }
  return { text: s, keyword: '' };
}

export function buildSelfiePrompt({ scene = '', withPartner = false, style = '', cfg = SELFIE_DEFAULTS } = {}) {
  const c = { ...SELFIE_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const st = Object.prototype.hasOwnProperty.call(SELFIE_STYLES, style) ? style : c.style;
  const sc = resolveScene(scene, c);
  const parts = [];
  parts.push(SELFIE_IDENTITY);
  parts.push(`画风：${SELFIE_STYLES[st]}`);
  parts.push(`场景：${sc.text}。`);
  if (withPartner) {
    parts.push(
      c.partnerFace === 'allow'
        ? '画面里还有另一个人（男性，二十多岁），和她挨在一起，两个人的脸都要清楚。'
        : '画面里还有另一个人，但不要画出他的脸——只出现他的肩膀、手臂或背影，或者只拍两个人牵着的手；把注意力留给她。',
    );
  } else {
    parts.push('画面里只有她一个人，自拍视角（镜头离脸近一点，像举着手机拍的）。');
  }
  parts.push(SELFIE_GUARD);
  return {
    prompt: parts.join('').slice(0, c.promptChars),
    scene: sc.text,
    keyword: sc.keyword,
    style: st,
    withPartner: Boolean(withPartner),
  };
}

// 一天几张：按「今天已经生成过的自拍数」判，不另建账。
export function selfieQuota({ todayCount = 0, cfg = SELFIE_DEFAULTS } = {}) {
  const c = { ...SELFIE_DEFAULTS, ...(cfg && typeof cfg === 'object' ? cfg : {}) };
  const used = num(todayCount, 0, { min: 0, max: 999 });
  return { allowed: c.enabled && used < c.maxPerDay, used, max: c.maxPerDay };
}

export function selfieFileName(now = Date.now()) {
  const d = new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `selfie-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.png`;
}
