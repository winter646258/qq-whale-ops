/**
 * 世界层条目的会话归属。
 *
 * 背景：`wishes` / `dates` / `topics` 这几个 store 原本是全局单例 —— 私聊里聊出来的
 * 东西会原样注入到群聊。2026-10-30 线上撞到的就是这样：私聊里 settle 记下
 * 「看半场CS比赛，等他讲压了谁」，然后她在两个群里都主动说「我今天说要看半场CS」，
 * 而那句里的「他」本来是主人，进了群就变成对着群友说话。
 *
 * `threads` 从一开始就按 key 存（`normalizeThread` 里带 key，`dueThreads` 按 key 过滤），
 * 所以它没有这个问题；`portrait` 是**故意**跨会话共享的（长期认识），也不改。
 * 这里补的是剩下三个漏的。
 *
 * 规则：
 *   · 条目上记 `k` = 写它时的会话 key。
 *   · 注入时只给同一个 key 看。
 *   · `k` 为空（这个文件上线之前写的老条目，或者她自己在 settle 里凭空想出来的）
 *     一律可见 —— 否则一上线她的愿望和纪念日就全消失了，那比串味更糟。
 */

/** 归一化会话 key；不合法的返回空串（= 不归属，全局可见）。 */
export function normScopeKey(key) {
  const s = String(key ?? '').trim();
  if (!s) return '';
  return /^(private|group):\d+$/.test(s) ? s : '';
}

/**
 * 这条记录该不该给 currentKey 看。
 * 任一侧为空都放行：没有来源 = 老数据，没有当前 key = 调用方没传（不该因此清空）。
 */
export function visibleFor(srcKey, currentKey) {
  const src = normScopeKey(srcKey);
  if (!src) return true;
  const cur = normScopeKey(currentKey);
  if (!cur) return true;
  return src === cur;
}

/** 给条目打来源标记（不改原对象）。key 不合法时原样浅拷贝，不加字段。 */
export function withScope(item, key, field = 'k') {
  if (!item || typeof item !== 'object') return item;
  const src = normScopeKey(key);
  if (!src) return { ...item };
  return { ...item, [field]: src };
}

/** 过滤一批条目：只留 visibleFor 为真的。 */
export function filterByScope(items, currentKey, field = 'k') {
  const list = Array.isArray(items) ? items : [];
  return list.filter((x) => x && visibleFor(x[field], currentKey));
}
