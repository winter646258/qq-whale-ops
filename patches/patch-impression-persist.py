"""配套补丁（2/2）：把 lastImpressionRefreshAt 纳入状态持久化白名单。

为什么必须补：loadSocialV2State 用显式字段白名单重建会话状态，
不在名单里的字段每次重启都会被丢掉 —— 于是「上次重写印象的时间」
永远为 0，提醒会在每一轮唤醒里重复出现（唠叨）。

默认值策略：首次没有记录时给「现在」，只延迟一次；
之后完全由「她真的改了印象」来重置。
"""
import shutil
import time

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()
orig_len = len(src)

# ── 1) 加载路径：纳入白名单 ───────────────────────────────────
old1 = """            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })()
          };"""
new1 = """            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            // 印象维护计时。默认给「现在」：宁可第一次提醒晚一轮，
            // 也绝不因为字段缺失而每轮唤醒都唠叨一次。
            lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt) > 0 ? Number(val.lastImpressionRefreshAt) : Date.now()
          };"""
assert src.count(old1) == 1, f'加载路径匹配数异常: {src.count(old1)}'
src = src.replace(old1, new1)

# ── 2) 新建会话路径：一并初始化 ───────────────────────────────
old2 = """        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {}
      };"""
new2 = """        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        lastImpressionRefreshAt: Date.now()
      };"""
assert src.count(old2) == 1, f'新建路径匹配数异常: {src.count(old2)}'
src = src.replace(old2, new2)

stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak.{stamp}'
shutil.copy2(P, bak)
tmp = P + '.tmp'
open(tmp, 'w', encoding='utf-8').write(src)
import os
os.replace(tmp, P)

print(f'备份 -> {bak}')
print(f'字节数 {orig_len} -> {len(src)}')
print(f'  加载路径落盘确认: {src.count("lastImpressionRefreshAt: Number(val.lastImpressionRefreshAt)")} 次')
print(f'  新建路径落盘确认: {src.count("lastImpressionRefreshAt: Date.now()")} 次')
