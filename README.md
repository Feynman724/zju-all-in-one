# ZJU All-in-One Assistant

浙大学生的一站式校园 AI 助手，Windows / macOS 桌面应用。

[![ZJU All-in-One Assistant 宣传片](docs/cover.jpg)](https://github.com/Anchorite-no/zju-all-in-one/releases/download/demo-video/campus-agent-demo-1080p.mp4)

宣传片 8 分 24 秒，点上面的封面看完整版（1080p，约 60 MB）。片子里的界面数据是演示实例里编的，人物都是化名。

<!-- 32 秒亮点：在 GitHub 网页上编辑这个文件，把 video/out/campus-agent-highlights.mp4 拖到这一行，生成的链接替换这条注释，就能在页面里直接播放。 -->

把散在各处的校园信息串成你自己的日常：教务网、学在浙大、智云课堂、学习通、PTA、学校和学院的通知、公众号，再加上你选定的钉钉群和微信群，接到一起，按课程整理成一份个人档案；问一句话，它去各个网站查、比对，把结果交给你。

> 这是学生个人项目，不是浙江大学的官方产品，和学校各系统的运营方没有关系。

## 能做什么

| 方面 | 内容 |
|---|---|
| 课程和作业 | 课表、成绩、课程信息；学在浙大和 PTA 的作业、截止时间；学在浙大、学习通的课件下载，智云课堂回放的转写 |
| 通知 | 教务网、学工部、研工部、团委、综合服务网和本人学院官网的通知公告；二课、三课的活动和本人记点 |
| 校园生活 | 体艺场馆的空场、预约须知和放号时间；CC98 帖子；图书馆电子书在哪个平台有全文；知网检索和下载 |
| 消息 | 浙大邮箱收信和写信；微信公众号文章；你选定的微信群和钉钉群（只读本机已有的聊天记录） |
| 学习 | 个人档案记下你学到哪、喜欢怎么听讲；把资料讲成带画面的讲解 |
| 文档 | PDF、Word、PPT、Excel 取文字，PDF 找页、切页、取图，照片和 Word 转 PDF |

会改动你账号状态的操作，比如场馆预约、选课、交作业、二课报名、发邮件，只在你明确要它做时才执行；发邮件之前会先给你看完整的草稿。

## 安装

Windows x64：

1. 到 [Releases](https://github.com/Anchorite-no/zju-all-in-one/releases/latest) 下载 `CampusAgent-Setup-<版本>.exe`（约 310 MB）。
2. 安装程序没有代码签名，Windows 可能弹出 SmartScreen 提示，点「更多信息」再点「仍要运行」。
3. 默认装到 `C:\Program Files\CampusAgent`，装给这台电脑上的所有用户，需要管理员权限。
4. 打开后在设置里填 DeepSeek API Key，或者用 ChatGPT 账号登录；再到「插件 → 校园账号」填统一身份认证的学号和密码。

Windows 装好以后应用会自己检查更新。

macOS（Apple Silicon / Intel）：

1. 在 Releases 下载 `CampusAgent-<版本>-mac-arm64.dmg`（M 系列芯片）或 `CampusAgent-<版本>-mac-x64.dmg`（Intel）。
2. 打开 DMG，把 CampusAgent 拖到「应用程序」。也提供 ZIP 格式。
3. 当前 Mac 包没有 Developer ID 签名和公证。首次打开被系统拦截时，在「系统设置 → 隐私与安全性」确认来源后允许打开。
4. Mac 版暂不启用自动更新，升级时下载并替换应用，用户数据会保留。

macOS 数据目录为 `~/Library/Application Support/CampusAgent`；源码模式使用 `CampusAgent-dev` 目录。校园账号仍为明文保存，邮箱密码通过系统安全存储保存。Mac 微信聊天读取在源码开发版提供，首次需按下方步骤授权。钉钉本机聊天读取和配音环境的一键安装仍仅支持 Windows。校园服务的实际账号登录和查询需自行配置后验证。

## 数据和隐私

这个项目没有自己的服务器，数据都在你的电脑上：

- 校园账号和密码存在 `%APPDATA%\CampusAgent\profile\accounts.json`，没有加密，只用来登录学校的系统。
- API Key 和 ChatGPT 登录令牌存在 `%APPDATA%\CampusAgent\api-keys.local.yaml`。
- 浙大邮箱的客户端专用密码用 Windows 的安全存储加密后保存。
- 下载的课件、转写、讲解和每次对话的文件夹在 `文档\CampusAgent` 下。

对话内容会发给你选的模型服务（DeepSeek 或 OpenAI），助手查到的校园数据也会随对话一起发过去。

## 从源码运行

需要 Node.js 24.x（24.18 以上）和 npm 11，支持 Windows x64、macOS arm64 / x64。

```powershell
npm ci
```

```powershell
npm start
```

`npm start` 构建界面并打开窗口，Mac 可以双击 `start.command`，Windows 可以双击 `start.cmd`。`npm run verify` 跑类型检查和全部测试，`npm run installer` 打 Windows 安装程序，`npm run installer:mac` 打 Mac DMG / ZIP。必须在目标系统和架构上执行 `npm ci` 后打包（内含平台原生依赖，不支持交叉打包）。各块功能的做法、取舍和验证记录在 [开发记录](docs/DEVELOPMENT.md)。

### 日常开发（无需安装包）

首次克隆或依赖变更后执行 `npm ci`；之后运行 `npm start`，Mac 也可双击 `start.command`。Mac 启动脚本使用项目自带的 Node，避免依赖系统 PATH 中的 Node 版本。

启动时会编译界面并打开 Electron，运行期间监听界面文件改动、自动重新编译。修改 `desktop/` 主进程或引擎代码后，退出应用（⌘Q）并重新启动。仅需编译、不打开窗口时运行 `npm run ui`。

源码模式使用 `CampusAgent-dev` 数据目录，可与安装版同时运行；源码模式的模型密钥文件位于项目目录的 `api-keys.local.yaml`（已被 Git 忽略）。日常修改直接在开发窗口验证，只在检查安装、分发或发布时生成 DMG / ZIP。

### macOS 发布流程

`.github/workflows/macos-release.yml` 在 PR 和手动运行时分别在 Apple Silicon / Intel runner 上检查、打包、执行隔离启动测试并保存构建产物。推送 `v*` 标签时还会把 DMG / ZIP 上传到该仓库的草稿 Release，供维护者检查后发布。未签名版本不上传自动更新清单。

本地验证成品：将 `.app` 复制到源码目录外，再运行 `node scripts/smoke-packaged.cjs /绝对路径/CampusAgent.app`。测试使用临时用户数据和精简 PATH，验证 Core CLI、引擎页面和桌面窗口启动，不需要真实校园账号。

## 项目结构

| 位置 | 内容 |
|---|---|
| `desktop/` | 桌面端的壳：`main.cjs` 开窗口、管进程；`preload.cjs` 让界面顶到窗口边缘；`host.mjs` 启动引擎 |
| `ui/` | 界面包：`client/` 是浏览器侧源码，`host.js` 是引擎侧入口，`lib/` 是构建产物 |
| `core/zju/` | ZJU Core：校园系统的命令和技能说明 |
| `core/learn/` | Learning Core：把资料讲成带画面的讲解 |
| `core/weread/` | WeRead Core：从微信读书找公众号文章，读正文、存成 Markdown |
| `core/mail/`、`core/chat/`、`core/wechat/`、`core/dingtalk/` | 浙大邮箱；本机微信、钉钉聊天记录的只读查询 |
| `core/initialize/` | 初始化：第一次用时建个人资料、课程和平台入口档案 |
| `core/skills/` | 应用自带的技能：选课、考前复习、课程学习、我的一周、交作业、写技能 |
| `core/AGENT.md` | 助手的底层说明，每次对话都放进系统提示 |
| `app.patch.yml` | 组合层：关掉引擎的哪些部分、换人设、插入我们的包 |
| `build/` | 打包用的图标；`icon/` 是图标的源文件和导出脚本 |
| `plans/` | 计划和盘点；`shots/` 是界面截图，`probes/` 是探测脚本，`plugin-pages/` 是插件页改造的交互草图，`dingtalk-wechat/` 是钉钉和公众号的调研 |
| `video/` | 做宣传片的工程，不放成品；`demo/` 是给它截界面的隔离实例和假数据（见 `video/README.md`） |
| `docs/` | 宣传片封面 `cover.jpg`；开发记录 `DEVELOPMENT.md` |

引擎是 DeepSeek Harness（`@deepseek-ai/dsh`），桌面壳和界面包是这个项目自己写的。第三方代码和素材的许可见 `core/weread/THIRD_PARTY_NOTICES.txt`、`video/assets/fonts/LICENSES.md` 和 `video/vendor/GSAP-LICENSE.txt`。

## 许可证

项目自有代码采用 [GNU GPL v3（仅限第 3 版）](LICENSE)，SPDX 标识为 `GPL-3.0-only`。允许使用、修改和再分发；分发本项目或其衍生程序时，须按 GPL 提供相应源码并保留许可。

第三方代码、依赖和素材沿用各自许可，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

### Mac 微信首次授权（源码版）

在「插件 → 微信聊天」点击「初始化 Mac 微信」，或双击仓库里的 `setup-wechat-mac.command`。按提示登录微信并在终端完成管理员授权，然后回到插件页点「立即同步」并选择聊天。需要 Xcode 命令行工具；初始化入口会从本仓库编译读取器，不需要第三方微信工具。支持微信 4.x 默认数据目录；多个本地账号不会自动猜选。

Mac 读取器移植 Windows 版的进程密钥探测和 SQLCipher 校验：只读微信进程与数据库，密钥保存到当前用户的系统钥匙串，解密和 WAL 合并只在内存完成。首次授权及微信更换密钥后可能需重新初始化。若 macOS 拒绝进程访问，按提示为 Terminal 开启开发者工具权限；不修改微信签名或关闭 SIP。缺少旧记录库密钥时明确提示不完整，监控不会推进进度。Mac 附件导出暂未适配。

校园 HTTP 请求遵循 `HTTP_PROXY` / `HTTPS_PROXY` 和 `NO_PROXY`。代理只在 Node 进程的环境中配置时生效；网页内登录和后台查询需要各自能够连通校园服务。
