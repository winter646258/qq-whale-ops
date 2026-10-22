#!/usr/bin/env python3
"""主动机会（proactiveCheck）不能对自己发、不能对「群号当私聊」的幽灵会话发。

## 现象

`state/social-v2.json` 里有 4 个 `recentMessages` 为空的幽灵会话，而且**都排上了主动档期**：

    private:2157801858   19.5 分钟后   ← 这是她自己的 QQ 号
    private:673877456    65 分钟后     ← 这其实是 allow.groups 里的群号
    private:906710082    （幽灵）
    private:910502749    （幽灵）

`private:2157801858` 最荒唐：19.5 分钟后她会主动给「自己」发一条私聊。

## 根因

1. `config.json` 的 `allow.private` 里躺着 `2157801858`（她自己）。这份名单大概是从
   「好友列表」抄的，但好友列表不会包含自己 —— 更可能是历史手工加的。
2. `getSocialV2State(key)` 对**任意** key 都会 `conversations.set()` 建会话并
   `scheduleProactiveCheckV2(key)`。所以任何路径（GET /api/socialV2/state、
   active-members 扫描、日志巡检）碰到一个不存在的 key，就会凭空造一个会话并排上档期。
3. `proactiveAllowed` 只检查「在不在白名单」，不检查「这是不是我自己」。

## 改法（不改白名单配置，交给主人决定）

`proactiveAllowed` 里加一条早退：`id === selfUserId` 直接 false。
`selfUserId` 取自 `bot.getLoginInfo()` 的 `user_id`（SDK 类型 `LoginInfo.user_id: number`），
和现有的 `selfNickname` 一起记录、一起刷新。

顺带清掉已有的幽灵档期（只清 `proactiveNextAt`，不删会话 —— 删了反而会因
`getSocialV2State` 被重新造出来）。

**为什么不直接从 allow.private 删？** 删除白名单条目会同时改变「接收」权限
（`modeAllowed` 也读这份表），影响面比这个大。先把「主动打扰自己」这条路堵死，
白名单要不要清由主人拍板。
"""
import json
import pathlib
import sys
import time

BRIDGE = pathlib.Path('/opt/qq-bridge/src/bridge.js')
STATE = pathlib.Path('/opt/qq-bridge/state/social-v2.json')

# ① 全局变量
OLD_DECL = "  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别\"被提到\"用）"
NEW_DECL = ("  let selfNickname = 'deepseek'; // 机器人昵称（启动时从网关获取，识别\"被提到\"用）\n"
            "  // MARKER: self-user-id\n"
            "  // 自己的 QQ 号。用于「不主动打扰自己」—— 幽灵会话 private:<自己> 会排上主动档期。\n"
            "  let selfUserId = '';")

# ② 记录登录 user_id
OLD_LOGIN = """      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }"""
NEW_LOGIN = """      if (login?.nickname) {
        selfNickname = String(login.nickname).toLowerCase();
        log(`机器人昵称: ${login.nickname}`);
      }
      // MARKER: self-user-id —— 记下自己的 QQ 号，供 proactiveAllowed 拒绝「对自己主动」。
      if (login?.user_id != null && String(login.user_id).trim()) {
        selfUserId = String(login.user_id).trim();
      }"""

# ③ proactiveAllowed 早退
OLD_ALLOW = """  function proactiveAllowed(key, kind, id, cfg, mode) {
    if (!modeAllowed(key, kind, id, cfg, mode)) return false;"""
NEW_ALLOW = """  function proactiveAllowed(key, kind, id, cfg, mode) {
    // MARKER: self-user-id —— 绝不主动找自己。白名单里历史上混进了自己的号
    // （allow.private 含 2157801858），会让幽灵会话 private:<自己> 排上档期，
    // 到点就「主动给主人自己发私聊」。这里兜住，不依赖白名单配置是否正确。
    if (selfUserId && String(id) === selfUserId) return false;
    if (!modeAllowed(key, kind, id, cfg, mode)) return false;"""


def patch_bridge():
    text = BRIDGE.read_text(encoding='utf-8')
    if 'MARKER: self-user-id' in text:
        print('· 已装 self-user-id，跳过代码改动')
        return 0
    for name, old, new in [('selfNickname 声明', OLD_DECL, NEW_DECL),
                           ('登录回调', OLD_LOGIN, NEW_LOGIN),
                           ('proactiveAllowed', OLD_ALLOW, NEW_ALLOW)]:
        n = text.count(old)
        if n != 1:
            print(f'❌ {name} 锚点命中 {n} 次（应为 1）')
            return 1
        text = text.replace(old, new)
    assert text.count('MARKER: self-user-id') == 3, text.count('MARKER: self-user-id')
    BRIDGE.write_text(text, encoding='utf-8')
    print('✅ bridge.js：selfUserId 声明 + 登录时记录 + proactiveAllowed 早退')
    return 0


def clear_ghost_schedules():
    """清掉幽灵会话已排的主动档期（保留会话本身）。"""
    raw = STATE.read_text(encoding='utf-8')
    data = json.loads(raw)
    convs = data.get('conversations') or {}
    now = int(time.time() * 1000)
    cleared = []
    for key, val in convs.items():
        if not isinstance(val, dict):
            continue
        recent = val.get('recentMessages') or []
        nx = val.get('proactiveNextAt') or 0
        if not nx:
            continue
        # 幽灵判定：从没收到过任何消息
        if isinstance(recent, list) and len(recent) == 0:
            val['proactiveNextAt'] = 0
            cleared.append((key, (nx - now) / 60000))
    if not cleared:
        print('· 没有需要清理的幽灵档期')
        return 0
    backup = STATE.with_suffix(f'.json.bak-selffix-{time.strftime("%Y%m%d-%H%M%S")}')
    backup.write_text(raw, encoding='utf-8')
    STATE.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f'✅ 清理幽灵档期 {len(cleared)} 个（备份 {backup.name}）：')
    for key, mins in cleared:
        print(f'   {key:24} 原本还有 {mins:.1f} 分钟')
    return 0


def main():
    rc = patch_bridge()
    if rc:
        return rc
    return clear_ghost_schedules()


if __name__ == '__main__':
    sys.exit(main())
