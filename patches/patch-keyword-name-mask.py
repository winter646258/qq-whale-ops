#!/usr/bin/env python3
"""关键词唤醒：先屏蔽「别人的名字」，再找关键词（修子串撞名）。

## 为什么改：今天 10-22 的唤醒里，79 次是 `keyword:大肥鱼`

`group:906710082` 最近缓冲的 100 条消息里，含「大肥鱼」的有 13 条，其中 **11 条其实是
「超大肥鱼」** —— 那是另一个 QQ 号（3960400511）。同理还有：

    小鲸鱼        3925980140   ← 群里还有一个号就叫这个名字
    小鲸鱼在潜水   3152427869
    小肥鱼        3928244052
    超大肥鱼      3960400511

她自己的 QQ 是 2157801858、登录昵称「八千代」。这些账号的名字恰好包含了
`recommendedKeywords` 里的 `大肥鱼` / `鲸鱼` / `小鲸鱼`，于是群里正常聊天
（「@超大肥鱼 对，你别认就行」）就一直在叫醒她。

## 改法：把别人的名字整段挖掉，再做关键词匹配

`evaluateWakeTriggerV2` 里 keywords 段原本是直接 `lower.includes(kwStr)`。
新增 `maskOtherMemberNamesV2(st, lowered)`：遍历 `st.recentMessages` 里非 self 的
sender 昵称，凡是**包含**该关键词、且**不等于**该关键词的（即撞名而非同名），
把这些昵称从待匹配文本里替换成 `\\u0000`。
剩下的文本再找关键词 —— 于是：

  「@超大肥鱼 对，你别认就行」   → 挖掉「超大肥鱼」→ 不含「大肥鱼」→ 不唤醒 ✅
  「大肥鱼你在吗」               → 没有别的昵称包含它 → 命中 → 唤醒 ✅
  「超大肥鱼 你过来，大肥鱼 说的是你」→ 挖掉前者，后者还在 → 命中 → 唤醒 ✅

## 为什么不直接删 keywords

因为「大肥鱼」确实是叫她的方式之一（她自己也在用）。问题不是关键词错了，
是**文本里分不清说的是谁**。挖名字是能拿到的最强证据 —— 数据来自真实的
`sender` 字段，不是猜的。

## 已知限制

真有一个号和她的关键词**完全同名**（`小鲸鱼` 3925980140 v.s. 关键词「小鲸鱼」）时，
文本层无法区分，「@小鲸鱼」仍会唤醒她。根治要么改关键词，要么靠 at 段（已有
`isDirectedAtOthers` 覆盖真 at 段的情况）。
"""
import pathlib
import sys

TARGET = pathlib.Path('/opt/qq-bridge/src/bridge.js')

HELPER = '''  // MARKER: keyword-name-mask
  // 群里有人名字本身就包含她的关键词（「超大肥鱼」含「大肥鱼」、「小鲸鱼在潜水」含「小鲸鱼」），
  // 直接 includes 会把别人的日常聊天全算成叫她。这里先把「撞名的别人昵称」整段挖掉再匹配。
  // 注意只挖「包含关键词但不等于关键词」的昵称：完全同名的没法靠文本区分，留给 at 段判定。
  function maskOtherMemberNamesV2(st, lowered, kwStr) {
    if (!lowered || !kwStr) return lowered;
    let hay = lowered;
    const seen = new Set();
    for (const m of st?.recentMessages ?? []) {
      if (!m || m.isSelf) continue;
      const name = String(m.sender ?? '').trim().toLowerCase();
      if (!name || name === kwStr || seen.has(name)) continue;
      if (!name.includes(kwStr)) continue;
      seen.add(name);
      hay = hay.split(name).join('\\u0000');
    }
    return hay;
  }

'''

ANCHOR = '  function evaluateWakeTriggerV2(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {'

OLD = '''    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\\\b${kwStr}\\\\b`, 'i').test(lower)) return `keyword:${kw}`;
        } else if (lower.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }'''

NEW = '''    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        // MARKER: keyword-name-mask —— 先挖掉撞名的别人昵称（「超大肥鱼」之于「大肥鱼」）。
        const hay = maskOtherMemberNamesV2(st, lower, kwStr);
        // 短英文/数字关键词（如 DS/R1）用词边界匹配，避免 ADS/BDSM/DSL 误触发。
        if (/^[a-z0-9]+$/.test(kwStr) && kwStr.length <= 4) {
          if (new RegExp(`\\\\b${kwStr}\\\\b`, 'i').test(hay)) return `keyword:${kw}`;
        } else if (hay.includes(kwStr)) {
          return `keyword:${kw}`;
        }
      }
    }'''


def main():
    text = TARGET.read_text(encoding='utf-8')
    if 'MARKER: keyword-name-mask' in text:
        print('· 已装 keyword-name-mask，跳过')
        return 0

    n = text.count(ANCHOR)
    if n != 1:
        print(f'❌ 函数锚点命中 {n} 次（应为 1）')
        return 1
    text = text.replace(ANCHOR, HELPER + ANCHOR)

    c = text.count(OLD)
    if c != 1:
        print(f'❌ keywords 段命中 {c} 次（应为 1）')
        return 1
    text = text.replace(OLD, NEW)

    assert text.count('MARKER: keyword-name-mask') == 2, text.count('MARKER: keyword-name-mask')
    assert text.count('maskOtherMemberNamesV2') == 2, text.count('maskOtherMemberNamesV2')
    TARGET.write_text(text, encoding='utf-8')
    print('✅ 已装 maskOtherMemberNamesV2 + keywords 段调用')
    return 0


if __name__ == '__main__':
    sys.exit(main())
