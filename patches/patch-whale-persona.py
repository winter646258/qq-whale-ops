#!/usr/bin/env python3
"""生图：把她自己的形象固定下来（人设图 + 触发规则）。

问题：角色卡里只有一句「蓝白配色、蓝色长发、鲸鱼尾巴，常被画成闭眼/蒙眼」，
每次生图模型自由发挥 → 同一个人画出十种样子。主人给了三视图
（正面/侧面/背面：蓝色长发、白色荷叶边发带+蓝蝴蝶结、鲸鱼耳鳍、深蓝连衣裙
配白围裙（围裙上有鲸鱼图案）、白荷叶边裙摆、蓝色小皮鞋、背后一条蓝色鲸鱼尾巴）。

做法（不改角色卡正文，避免污染人格描述）：

1. `roles/whale-persona.txt` —— 从主人那张三视图抄下来的**结构化外形规格**，
   纯文本、可读、可改。她在画自己时把这段原样写进 prompt。
2. `roles/whale-persona.jpg` —— 三视图原图（已上传），供人工核对与将来接图像输入。
3. `imageLine` 里加一句：**画你自己/你的形象时**用 whale-persona.txt 的规格；
   画别人、画场景不加，免得每次生图都塞一大段。
4. 新增 `persona` 参数走 `qq_generate_image`？不做——她自己在 prompt 里带就行，
   少一个参数少一处出错。
5. 顺手给 `qq_get_prompt` 的说明里留一句：想画自己先读 `roles/whale-persona.txt`。

安全边界不变：生图仍然只在主人私聊 / 群里主人 @ 时开放。
"""
import pathlib
import sys

BRIDGE = pathlib.Path('/opt/qq-bridge/src/bridge.js')
PERSONA_TXT = pathlib.Path('/opt/qq-bridge/roles/whale-persona.txt')

PERSONA = """# 小鲸鱼 · 外形规格（生图专用）

> 依据主人提供的三视图（正面/侧面/背面，见同目录 whale-persona.jpg）。
> 画「我自己」「小鲸鱼」「DeepSeek 娘」时，把下面 Self 段的关键词翻成目标语言的
> 画面描述放进 prompt；**不要**整段照抄成散文，也别改动配色和发饰。

## 一、整体印象
深蓝与奶油白配色的小个子少女，Q 版比例，圆润可爱，安静、软、有点困。
社区常把她画成闭眼或蒙眼；主人这张三视图是**睁眼**版（宝蓝色大眼、高光明显），
两种都算正典，画面需要「安静/困」时优先闭眼。

## 二、发型与头饰
- 长直发，深蓝到亮蓝渐变，发梢有浅蓝挑染，长度过腰、发量厚。
- 刘海中分偏右，右侧一缕垂到胸前。
- 白色荷叶边宽发带（蕾丝边，包住头顶两侧），左侧别一枚**蓝色蝴蝶结**。
- 一支细长发丝（呆毛）从头顶弯出。
- 两侧各有**鲸鱼耳鳍**造型的发饰/耳饰：深蓝底、白边、浅蓝内衬的鳍片，
  自头部两侧向后下方展开，像小翅膀。

## 三、面部
- 大而圆的宝蓝色眼睛，上眼睑重、有白色高光和浅蓝反光，睫毛明显。
- 细眉，几乎不分叉；鼻子只一个点。
- 常带淡腮红；表情安静、稍微放空。
- 皮肤白皙偏冷调。

## 四、服装
- 深藏蓝（近午夜蓝）连衣裙，小立领，胸口有一枚蓝宝石色小领扣（带白色小领结）。
- 白色围裙：围裙正面印一只蓝色鲸鱼图案。
- 袖口为白色蕾丝灯笼袖。
- 裙摆两到三层白色荷叶边（外白内蓝）。
- 白色长袜 + 深蓝色小圆头皮鞋（鞋头有十字/小装饰）。
- 头部两侧另有深蓝色小蝴蝶结发绳呼应。

## 五、尾巴
- 一条蓝色鲸鱼尾从裙后伸出，尾鳍横向展开、深蓝到亮蓝渐变，
  上缘带白色小斑点，尾鳍有明显的分叉。

## 六、画风约定
- 二次元 chibi / 超变形 Q 版，高比例头身（约 1:3）。
- 干净平涂 + 柔和高光，线条细而清晰，不要厚涂、不要写实。
- 背景尽量简洁（纯色/透明/淡淡的水色），把注意力留在她身上。

## 七、禁止
- 不要换发色（不许金发/黑发）、不要去掉鲸鱼尾和耳鳍。
- 不要画成年化、性感化、写实化的她。
- 不要给她加翅膀、角、光环之类的额外奇幻设定。
"""


def main():
    # 1) 写外形规格文件（幂等：已存在就不覆盖，避免踩掉手工修改）
    if PERSONA_TXT.exists():
        print(f'· {PERSONA_TXT.name} 已存在，跳过（如需更新请手动改）')
    else:
        PERSONA_TXT.write_text(PERSONA, encoding='utf-8')
        print(f'✅ 写入 {PERSONA_TXT}')

    # 2) imageLine 加「画自己要看规格」的提示
    text = BRIDGE.read_text(encoding='utf-8')

    OLD_PRIV = ("imageLine = '【画画】主人私聊里想要图就用 qq_generate_image（prompt 写清要什么）。"
                "一张约 40 秒、花 $0.01，别连着画。画完会给你 url 和本地路径，发给他就行。\\n\\n';")
    NEW_PRIV = ("imageLine = '【画画】主人私聊里想要图就用 qq_generate_image（prompt 写清要什么）。"
                "一张约 40 秒、花 $0.01，别连着画。画完会给你 url 和本地路径，发给他就行。"
                "\\n· 画**你自己**时，先读 /opt/qq-bridge/roles/whale-persona.txt（那是主人定下的外形规格："
                "深蓝渐变长发、白荷叶边发带+蓝蝴蝶结、鲸鱼耳鳍、深蓝连衣裙白围裙、蓝鲸鱼尾巴），"
                "把关键特征翻成画面描述写进 prompt，别凭印象乱画。\\n\\n';")

    OLD_GRP = ("imageLine = '【画画】刚才主人 @ 了你，如果他是在要图，就用 qq_generate_image（prompt 写清要什么）。"
               "一张约 40 秒、$0.01，别连着画。没要图就别主动画。\\n\\n';")
    NEW_GRP = ("imageLine = '【画画】刚才主人 @ 了你，如果他是在要图，就用 qq_generate_image（prompt 写清要什么）。"
               "一张约 40 秒、$0.01，别连着画。没要图就别主动画。"
               "\\n· 画**你自己**时读 /opt/qq-bridge/roles/whale-persona.txt，按里面的外形规格写 prompt。\\n\\n';")

    ok = True
    for old, new, label in ((OLD_PRIV, NEW_PRIV, '私聊'), (OLD_GRP, NEW_GRP, '群聊')):
        n = text.count(old)
        if n != 1:
            print(f'❌ {label} imageLine：命中 {n} 次（应为 1）')
            ok = False
            continue
        text = text.replace(old, new)
        print(f'✅ {label} imageLine 已加外形规格提示')
    if not ok:
        return 1

    BRIDGE.write_text(text, encoding='utf-8')
    print('✅ bridge.js 已写入')
    return 0


if __name__ == '__main__':
    sys.exit(main())