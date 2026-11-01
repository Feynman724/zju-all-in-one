# 本机微信聊天查询

入口为 `node <SKILL>/scripts/wechat.mjs chat <子命令>`。需要 Windows 和 应用自带 Node 24.18 以上版本。首次取得密钥需要运行且已登录的微信，之后关闭微信也能查询。本轮实测微信 4.1.15.13。只读本机已同步的数据，不代表手机或云端的完整历史。

## 离线查询

首次在微信登录时执行 `node scripts/wechat.mjs chat search --type text --limit 1`，会为联系人、会话和当前所有消息分库准备密钥。密钥经 Windows DPAPI CurrentUser 加密保存到 `%LOCALAPPDATA%/weread-skill/chat-keys/`，仅供当前 Windows 用户使用；每次读取仍校验对应数据库的 HMAC。之后六个查询命令自动使用本机密钥，不要求微信运行，也不需要每次添加参数。

`list/contacts/info/members/read/search` 都可加 `--offline`，强制不枚举或读取微信进程。`wechat_offline_key_unavailable` 表示所需分库尚未准备、密钥已变更或当前 Windows 用户无法解开缓存，需要打开微信并去掉 `--offline` 重跑上述准备命令。查询不会自动启动微信。游标不绑定 `--offline`，其余筛选条件仍须保持一致。

关闭微信不会同步新消息。媒体导出不在离线保证范围内，图片密钥仍可能依赖微信进程。删除上述缓存目录只会清除离线密钥，下次需重新准备；不会删除聊天数据。

## 命令

| 子命令 | 参数与用途 |
|---|---|
| `list` | 会话按最近消息时间倒序；`--kind personal\|group`、`--query 文字` |
| `contacts` | 本地联系人按名称排序；`--query 文字` 匹配名称、昵称、备注、微信号和 ID；可加 `--kind` |
| `info --chat 名称或ID` | 联系人资料与本地会话状态；群聊增加本地群主 ID、成员数和已同步的公告字段 |
| `members --chat 群名或ID` | 本地群成员，含 `groupNickname`、`isOwner`；可用 `--query` 筛选成员 |
| `read --chat 名称或ID` | 一个会话的消息，按时间倒序 |
| `search [--query 文字]` | 在文本、引用和转发内容中做字面子串搜索；也可以只用 `--type file` 等筛选条件；至少指定一个关键词、会话、发送者、类型或时间条件 |
| `download --message 消息ID --out 目录` | 保存这条消息中的本地图片、语音、视频和附件，包括已缓存的转发附件 |

除 `info` 和 `download` 外都接受 `--limit 1..500`（默认 50）和 `--cursor`。结果里的 `hasMore`、`nextCursor` 表示是否还有下一页；继续时保持原筛选条件不变。游标不固定数据库快照，新同步或删除的数据可能改变后续结果。名称先精确匹配，再部分匹配；同名不自动选人，返回 `chat_ambiguous` 和候选 ID。

`read` 与 `search` 还支持：

- `--since`、`--until`：含起点、不含终点。`2026-10-13` 表示 UTC+8 当天零点；也接受 `2026-10-13T15:00:00+08:00` 或 `2026-10-13T07:00:00Z`。查询一整天应把 `until` 写为下一天。
- `--sender 名称或ID`：按发送者筛选。
- `--type 类型`：`text`、`image`、`voice`、`video`、`file`、`link`、`quote`、`forward`、`miniapp`、`channel`、`contact`、`location`、`sticker`、`call`、`system`、`transfer`、`red_packet`、`app`、`unknown`。

```sh
node scripts/wechat.mjs chat read --chat "群名" --since 2026-10-13 --until 2026-10-14 --type text
node scripts/wechat.mjs chat search --chat "联系人 ID" --query "会议" --limit 20
node scripts/wechat.mjs chat members --chat "群 ID" --query "成员名字"
node scripts/wechat.mjs chat search --type file --since 2026-10-01
node scripts/wechat.mjs chat download --message "read/search 返回的 id" --out ./downloads
```

## 返回内容

查询成功结果为 `ok: true`，集合分别在 `chats`、`contacts`、`members`、`messages` 中，单条资料在 `chat` 中。查询结果带 `coverage: "local_synced"`。

联系人有 `id`、`name`、`nickname`、`remark`、`alias` 和 `kind`。资料字段只描述本地记录；联系人中可能有群成员和历史联系人，不能据此判断好友关系。有群昵称时，成员的 `nameSource` 为 `group`，名称优先使用 `groupNickname`；否则用联系人资料。群消息发送者也带群昵称。成员数与公告可能落后于实时状态。

消息有稳定的 `id`、`chatId`、`sender`、`isSelf`、`sentAt`、`type`、`rawType`、`text`、`contentStatus`，以及定位用的 `database`、`localId`、`serverId`。64 位服务端消息 ID 和原始类型用字符串表示，避免 JavaScript 精度损失；无法确定的发送者或本人标记为 null。

| 内容 | 当前范围 |
|---|---|
| 文本、压缩文本 | 返回 `text`；支持关键词搜索 |
| 引用回复 | `reference` 包含原消息内容、发送者、时间和服务端 ID |
| 合并转发 | `items` 展开各条内容及嵌套转发，文字参与搜索 |
| 链接、小程序、视频号、文件 | 可用标题、简介和链接；小程序包含页面信息，文件包含名称、扩展名和大小 |
| 图片、语音、视频 | 查询返回大小、时长等元数据；用 download 保存实际内容 |
| 位置、名片、通话、支付与系统消息 | 解析已有的对应字段或提示文字，不执行任何交互操作 |
| 表情及未知应用消息 | 返回类型和可解析的元数据；不解包商店表情包 |
| 系统消息 | 能解析的提示文字会返回；不能解析时保留元数据，不恢复已撤回或已删除的原消息 |

`contentStatus` 为 `parsed`、`metadata_only`、`empty_or_unreadable` 或 `unsupported`，表示消息载荷的解析情况，不能据此判断附件是否已缓存。搜索范围是 `text_and_nested_content`，不执行图片 OCR、语音转写或附件正文解析。类型映射的自动测试不等于每一种类型都已有本轮真实样本。

## 媒体下载

`download` 直接使用 read/search 返回的完整消息 ID。所有媒体类型共用此命令，转发消息会逐项提取其中已缓存的附件。输出保存在 `--out` 下新建的消息目录，不覆盖已有文件。

- 普通图片恢复为 JPEG、PNG、GIF 或 WebP；微信 WXGF 保存完整源文件，并用 Skill 自带的 FFmpeg 生成 PNG 首帧预览，动画的所有数据仍保留在源文件中。
- 语音从本地媒体库或转发缓存读取，使用自带的 silk-wasm 转成 24 kHz 单声道 WAV。
- 视频和文件直接复制本地原始内容。只找到图片/视频缩略图时返回 `variant: "thumbnail"`。
- 返回 `files`、`failed`、`complete` 和输出目录。部分资源不可用时保留成功文件并列出失败项；全部失败则返回错误。没有缓存的附件不会从远程 CDN 猜测下载，也不能恢复已过期的文件。

图片 V1/V2 解密复用微信进程读取底座，验证密钥后在内存中解密。支持读取图片密钥，以及微信 4.1 的账户 seed 推导；不保存 seed 或密钥。`image_key_unavailable` 时可在微信中打开图片后重试，`media_not_local` 时先在微信中下载该资源。

聊天查询不使用 `--source` 或 `WEREAD_SOURCE`，不依赖 Electron、微信读书或识别模型。数据库密钥只以 DPAPI 密文保存在本机；解密后的密钥、数据库通过内存与匿名管道传递，不生成个人数据库副本，不自动写查询日志。

常见错误为 `wechat_not_running`、`wechat_key_unavailable`、`chat_not_found`、`chat_ambiguous`、`chat_not_group`、`invalid_cursor`、`chat_schema_unsupported`。一个命令内任一所需数据库读取或校验失败会整体报错；不静默把不完整结果当成功返回。

## macOS 源码版

微信 4.x 默认目录通过仓库的 `setup-wechat-mac.command` 首次授权，也可从插件页的「初始化 Mac 微信」打开。密钥在系统钥匙串中，查询仍复用同一套 Query 和消息解析器；不使用第三方微信 CLI。原始数据库只读，不落盘明文。多个本地账号不会自动选择；Mac 暂不提供附件导出。缺失密钥时重新初始化，不尝试以管理员身份运行日常查询。

Mac 快照不按文件修改时间忽略旧分片；缺失的消息库会标为 `partial`，自动监控保留原进度。尚未获得本机授权前只能完成模拟数据库与原生密钥校验测试，不能视为真实账号兼容性验证。
