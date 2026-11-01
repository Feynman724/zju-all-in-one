# PTA

PTA 使用百腾独立账号，公网直连，不依赖校园网、WebVPN 或 CAS。账号（邮箱）和密码在应用「插件」页的「课程与作业」里填。`profile show` 只显示密码是否已填。

## 命令

```text
pta
├─ homework    list · view · start · finish   作业（题目集）
├─ problem     view · save · submit           小题
├─ submission  list · view                    提交记录
├─ reconcile                                  回查上次没确认的写入
└─ session     login · status · logout · import-cookie
```

作业写名称里的一段（`--set HW02`），小题写题号（`--problem 7-1`），不需要任何平台编号。名称先在还没截止的作业里找，找不到再查历史作业；不唯一时返回候选。时间都是北京时间 `YYYY-MM-DD HH:mm`。

| 用户目标 | 命令 | 结果 |
|---|---|---|
| PTA 有什么作业、做完没 | `homework list` | 还没截止的作业：state、deadline、题数与对错数、得分。历史作业加 `--scope all`（配合 `--keyword` 缩小范围，全量扫描约一分钟）；`--state todo` 只看没答完的 |
| 一份作业的情况 | `homework view --set HW02` | 截止时间、进度、得分，每道小题的题号、题型、分值、对错 |
| 看一道题 | `problem view --set HW02 --problem 7-1` | 题面全文、选项或样例、时空限制、可用编译器，本人最后一次作答与判题结果，代码草稿 |
| 提交记录 | `submission list --set HW02`，可加 `--problem 7-1` | 每次提交的时间、状态、得分；单次详情用 `submission view --set HW02 --id 提交编号` |

- state 为 未开始 / 未作答 / 部分作答 / 已全部作答 / 未知。已全部作答不等于全对，看 accepted、wrong；`closed: true` 表示时间或状态已关闭，`endedByUser: true` 才是本人主动交卷。
- 未开始的作业没有小题列表，查询不会自动开始答题。
- 判断题、单选题、多选题、填空题是整组一起提交的：提交历史里显示为「判断题（整组）」，详情里逐题列出答案与对错。
- 没有查看权限的历史作业列在 `unknown`，不当作没做。
- 题面里的 `$$…$$` 是公式。选项字母按平台原始顺序，网页可能随机打乱显示顺序，不能和网页上看到的字母混用。

## 登录与会话

业务命令自动登录并复用 Cookie。按账号隔离到 `data/sessions/pta-<账号哈希>.json`，不缓存密码。只读请求明确认证失效后最多重登一次，业务写入不自动重试。

`session login --fresh` 忽略缓存，仍可能触发 PTA 验证码或二次验证；此时返回 `NEEDS_USER`，不循环尝试，也不会删除磁盘上原有的会话。正常浏览器登录后，可将本人 PTA 请求的单行 Cookie 头放入私有文件，用 `session import-cookie --file 文件` 导入；只接收 `PTASession/JSESSIONID`，验证账号与填写的 PTA 邮箱一致后持久化。不要把 Cookie 放进命令参数、示例或 Git。

### 桌面版遇到验证码时如何登录

点击「校园事务」PTA 报错旁边的「登录 PTA」，或打开「插件 → 课程与作业」，在 PTA 账号下面点击「登录 PTA」。先填写 PTA 邮箱和密码；账号设置中的登录按钮会先保存当前填写的配置。

应用会打开 PTA 官网登录窗口。使用与账号设置相同的邮箱正常登录，完成验证码或二次验证。验证成功后窗口自动关闭，会话保存在本机；从校园事务打开时会自动刷新作业。关闭登录窗口即取消。

不需要开发者工具、复制 Cookie 或新建对话。网页登录窗口不接触应用的凭据桥接接口；只有本机主进程将 PTA 会话交给 Core 验证，不将 Cookie 发给模型。

高级用法仍可用 `session import-cookie --file 文件` 导入私有文件中的单行 Cookie 请求头。不要把 Cookie 放到聊天、命令参数或 Git。外部终端须设置 `CAMPUS_PROFILE_DIR` 为当前实例的 `profile` 目录。

遇到 429 返回 `RATE_LIMITED` 和重试等待提示，停止当前扫描。

## 开始、保存、提交与结束

所有写命令需要 `ZJU_ALLOW_WRITE=1` 和 `--confirm`，按用户已经给出的具体目标和答案执行。开始、保存、提交、结束是四件不同的事，不能擅自合并。

| 动作 | 命令 |
|---|---|
| 开始答题（可能启动限时计时） | `homework start --set HW02 --confirm` |
| 保存一题，不判题 | `problem save --set HW02 --problem 1-2 --answer TRUE --confirm` |
| 提交一道编程题并判题 | `problem submit --set HW02 --problem 7-1 --code-file solution.c --compiler GCC --confirm` |
| 保存或提交整份答案 | `problem save` / `problem submit` 加 `--set HW02 --answers-file answers.json --confirm` |
| 结束整份作业（交卷） | `homework finish --set HW02 --confirm`，教师允许提前结束时才行 |

- **save**：判断、选择、填空保存为正式答题记录；代码题只保存草稿，不判题。
- **submit**：代码题发起判题，命令会等判题出结果（最多约 20 秒）再返回，结果里有 status、得分和各测试点；判断、选择、填空同样保存为答题记录。submit 不会结束整份作业。
- 编译器取 `problem view` 结果里 compilers 中的一个。
- 结果的 `verified: true` 只表示平台确实收到了这次写入，不代表答对；对错看 status 和 score。

`answers.json` 用题号写每一题：

```json
{
  "answers": [
    {"problem": "1-1", "answer": "TRUE"},
    {"problem": "3-1", "answer": ["A", "C"]},
    {"problem": "4-1", "answer": ["第一空", "第二空"]},
    {"problem": "7-1", "code": "int main() { return 0; }", "compiler": "GCC"}
  ]
}
```

| 题型 | 答案写法 |
|---|---|
| 判断题 | `answer: "TRUE"` / `"FALSE"`，也可写 T / F |
| 单选题 | `answer: "A"`，字母对应 `problem view` 里 choices 的顺序 |
| 多选题 | `answer: ["A", "C"]` |
| 填空题、程序填空题 | `answer: ["...", "..."]`，个数等于空位数（`problem view` 的 blanks）；某一空可留空串 |
| 选择填空题 | 每空一个选项字母的数组 |
| 编程题 | `code` 加 `compiler` |
| 函数题、SQL 编程题 | 只要 `code` |
| 主观题 | `answer` 正文；只支持 submit 文字，不支持附件 |
| 多文件编程题 | `fileContents: {"main.cpp": "..."}`；只支持 submit 文本文件，不支持 ZIP |

单题用 `--answer`（多选、填空写 JSON 数组）、`--answer-file` 或 `--code-file`，三者给一个。整份输入会先完成格式、题型、归属和期限校验，再按题型依次提交。

判断、选择、填空按整组保存，命令会合并平台上已有的答案，只改这次给出的题；答案没变时跳过。不要同时在网页和命令里改同一题型，平台没有冲突检查。跨题型不是原子操作，中途失败时错误详情里有已成功的部分和停在哪一题。主观题更新文字会保留已有的附件。

`homework finish` 不上传本地文件，也不把代码草稿变成判题提交。教师没开放提前结束时拒绝；默认有题没答不交卷，确需结束加 `--allow-incomplete`。互评作业只能查看；监考客户端、Scratch、附件与 ZIP 上传、同伴互评尚未接入。

## 没确认的写入

写入前先记日志和未决摘要，再发一次请求，随后回查。超时不当作失败重发：有未决记录时，下一条写命令只回查并停止，返回 `status: recovered-previous-operation`、`performedNewWrite: false`，表示确认的是上一次操作，这一次没有写入，不能说成本次已执行。

`reconcile --set 作业名` 只读回查，确认成功后清除未决记录。日志在 `data/journal/`；未决摘要与锁在 `data/pta/pending/`，只记答案哈希，不存密码或答案正文。进程崩溃留下的 `.lock` 要先确认进程已停止才能删，旁边的 `.json` 保留用于回查。
