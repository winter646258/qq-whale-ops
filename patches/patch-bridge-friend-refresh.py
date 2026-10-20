import re, shutil, time, sys

P = '/opt/qq-bridge/src/bridge.js'
src = open(P, encoding='utf-8').read()
orig = src

# ── 1) 刷新间隔 10 分钟 -> 1 分钟 ──────────────────────────────
old1 = "const FRIEND_REFRESH_MS = 10 * 60 * 1000;"
new1 = "const FRIEND_REFRESH_MS = 60 * 1000;"
assert src.count(old1) == 1, f'第1处匹配数异常: {src.count(old1)}'
src = src.replace(old1, new1)

# ── 2) 刷新函数加去抖，并挂到模块作用域供事件侧调用 ────────────
old2 = """    const refreshFriends = async () => {
      try {
        const data = await bot.request('get_friend_list', {});"""
new2 = """    // 去抖：事件侧的「刚加好友」补拉与定时刷新共用这一把闸，避免并发重复请求。
    // 定时刷新会把 friendRefreshPending 归零，所以正常周期刷新不受影响。
    let friendRefreshPending = false;
    const refreshFriends = async (reason = '定时') => {
      if (friendRefreshPending) return;
      friendRefreshPending = true;
      try {
        const data = await bot.request('get_friend_list', {});"""
assert src.count(old2) == 1, f'第2处匹配数异常: {src.count(old2)}'
src = src.replace(old2, new2)

old3 = """      } catch (error) {
        log(`[friendOnly] 好友列表刷新失败：${error?.message ?? error}`);
      }
    };
    setTimeout(refreshFriends, 5000).unref?.();"""
new3 = """      } catch (error) {
        log(`[friendOnly] 好友列表刷新失败：${error?.message ?? error}`);
      } finally {
        friendRefreshPending = false;
      }
    };
    // 暴露给 handleIncoming：命中「非好友」时立刻补拉一次
    friendRefreshNow = refreshFriends;
    setTimeout(refreshFriends, 5000).unref?.();"""
assert src.count(old3) == 1, f'第3处匹配数异常: {src.count(old3)}'
src = src.replace(old3, new3)

# ── 3) 关于「10 分钟」的注释同步 ───────────────────────────────
src = src.replace(
    '// 由 SnowLuma 的 get_friend_list 定时刷新（默认 10 分钟）。未就绪时 friendSetReady=false，',
    '// 由 SnowLuma 的 get_friend_list 定时刷新（默认 1 分钟）。未就绪时 friendSetReady=false，')

# ── 4) 模块级变量声明 ─────────────────────────────────────────
old4 = """let friendSet = new Set();
let friendSetReady = false;"""
new4 = """let friendSet = new Set();
// 供 handleIncoming 在「非好友发来消息」时触发一次立刻补拉（刚加好友的窗口期兜底）
let friendRefreshNow = null;
let friendSetReady = false;"""
assert src.count(old4) == 1, f'第4处匹配数异常: {src.count(old4)}'
src = src.replace(old4, new4)

# ── 5) 非好友被拦时补拉一次好友列表 ────────────────────────────
old5 = """      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;"""
new5 = """      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      // 刚通过好友申请的人会撞上好友列表的刷新窗口期：这里立刻补拉一次，
      // 让下一条消息能过。本条仍然丢弃（fail-closed，不放行身份未确认的人）。
      if (kind === 'private' && cfg.friendOnly === true && typeof friendRefreshNow === 'function') {
        Promise.resolve()
          .then(() => friendRefreshNow('非好友消息触发'))
          .catch((error) => log(`[friendOnly] 补拉好友列表失败：${error?.message ?? error}`));
      }
      return;"""
assert src.count(old5) == 1, f'第5处匹配数异常: {src.count(old5)}'
src = src.replace(old5, new5)

# ── 落盘 ─────────────────────────────────────────────────────
stamp = time.strftime('%Y%m%d-%H%M%S')
bak = f'{P}.bak.{stamp}'
shutil.copy2(P, bak)
tmp = P + '.tmp'
open(tmp, 'w', encoding='utf-8').write(src)
import os
os.replace(tmp, P)
print(f'备份: {bak}')
print(f'原大小 {len(orig)} -> 新大小 {len(src)} 字节')
for line in [
    "const FRIEND_REFRESH_MS = 60 * 1000;",
    "let friendRefreshNow = null;",
    "friendRefreshNow = refreshFriends;",
    "friendRefreshNow('非好友消息触发')",
]:
    print('  落盘确认:', line, '->', src.count(line))
