# 央视频（yangshipin）短信登录 + 积分任务

单文件面板插件，**带 WebUI**（照 mgmusic-plugin 形态）。侧边栏「📺 央视频」进入，
短信登录、任务结算、积分领取、cookie 导出都在页面里完成，不用手改配置文件。
实测积分 15 → 80（一夜 7/7 任务写满）。

## 安装

「插件列表 → 插件商城」→ 央视频 → 安装。安装时 `.ts` 自动转 `.js`。

**面板要求：≥ 0.3.0**（源文件头的 `@panel` 声明会让老面板在加载时直接拒载）。

**三个引擎全功能、同一份代码**：0.3.0 起 QuickJS 的 `fetch` 也吃 `Uint8Array`、
也有 `node:zlib` / `node:fs`，所以发码/登录/结算这条二进制路径与 Node 分支**逐字相同**
——文件里已经没有任何 `IS_NODE` 分支了。

## 使用（WebUI，一次登录长期可用）

1. 侧边栏出现「📺 央视频」入口（`register_nav`）；
2. 页面输入手机号 → 「发验证码」→ 输入短信码 → 「登录」；
3. 「一键做任务」结算 7 个任务并领取（可选"先点赞一次"）。

登录态存插件数据目录 `data/state.json`（0600），之后任务无需重复登录。
配置文件方式（`phone`/`code` + handlers）仍然可用，与 WebUI 等价。

## 定时任务与耗时预算

```
0 17-19 * * * ~15m    # 17/18/19 点各一次，各带 ±15 分钟抖动
```

**为什么一天三次**：服务端的计数语义是「每次 `TaskComplete` 让 `completedCount` +1，
累计到 `maxCompleteCount` 为止」。观看类/关注的 `maxCompleteCount` 是 3，
所以一次执行最多让每个任务 +1 —— 一轮值 35 分（7×5），全天 70 分（14×5）要三轮。

**为什么不在一次执行里跑三轮**：7 个包 × 35–65 秒 ≈ 5 分钟/轮，
面板 `budget_ms` 上限是 **10 分钟**，三轮就是 15 分钟，超了直接 SIGKILL 进程组。
所以让**调度**去分摊，而不是让**执行**去循环。

`~15m` 是面板 cron 的抖动后缀（`host-api.md` §1.2.8）：实际触发落在 `[t-15m, t+15m]`
随机，固定时刻是脚本指纹。三次互不重叠（16:45–19:15）。
只想要下午 5 点一次、不追满分，改回 `0 17 * * * ~1h`。

**多账号**：一个账号一条 `register_cron`，绝不在一次调用里循环账号 ——
3 个账号就是 15 分钟，必被砍。当前实现是单账号（`state.json` 里一份会话）。

## WebUI 路由（`register_route`，页面同源 fetch）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `api/status` | GET | 登录态 + 积分（首屏） |
| `api/login/send` | POST | 发短信验证码（写操作） |
| `api/login/verify` | POST | 用验证码登录并落盘 token |
| `api/logout` | POST | 清除登录态 |
| `api/tasks` | GET | 任务列表 + 当前积分 |
| `api/do-tasks` | POST | 结算全部任务 + 领取（body 可带 `{likeFirst: true}`） |
| `api/cookies` | GET | 导出 Netscape cookie |

页面 `index.html` 由面板静态服务在 `/plugins/yangshipin/`；
侧边栏入口 `register_nav({ label: '央视频', icon: '📺' })`。

## 任务 handlers（可与 WebUI 并用）

三个引擎（QuickJS / Node / Bun）行为一致，没有「哪个引擎不能跑」这回事。

| 名字 | 作用 |
| --- | --- |
| `send-code` | 发短信验证码（写操作） |
| `login` | 用 `code` 登录，token 落 `data/state.json` |
| `session-check` | App 侧验活（24802） |
| `h5-check` | H5 会话自检 |
| `tasks` | 任务列表 + 当前积分 |
| `do-tasks` | 结算 7 个任务 + 自动领取 |
| `like` | 点赞一次（幂等） |
| `export-cookies` | 导出 H5 cookie（Netscape + JSON） |

## 能力与边界（诚实清单）

**能做**（2026-11-07 真机验证）：

- 短信登录 → 三枚 token（access_token / refresh_token / vusession，映射逐字节比对过）；
- `TaskComplete`(25042) 尾字节 = 任务 id，7 个任务（含每日签到）全部脚本写满 maxCompleteCount；
- H5 领取积分、导出 cookie（vplatform=5，iOS）。

**不能做**：

- **观看/分享/关注类任务不需要真实动作**——`TaskComplete` 直接写计数（今晚订正的结论）；
- 不能无限刷分：到 `maxCompleteCount` 后幂等返回 `task has been complete`；
- ~~QuickJS 引擎发不了二进制信封~~ —— 面板 0.3.0 已补齐（字节 `fetch` + `node:zlib`），
  现在三个引擎都能跑；老面板会被 `@panel` 头拒载，而不是跑到一半才炸；
- 24802 验活在部分会话状态下回业务码 6（CLI 与插件行为一致，属服务端侧状态）。

**安全**：

- token 只落插件数据目录 `data/state.json`（宿主 0600），不进日志、不进错误文本；
- 本文件内所有骨架均为**脱敏占位**（`A`×43 token、`900000001` vuserid 等）；
- 短信验证码一次一码，插件不做自动重试（防风控）。

## 回归测试（不用手机号也能跑）

```bash
python3 yangshipin/regression/panel-check.py            # 对拍：抓包 ↔ 真上网的字节
python3 yangshipin/regression/panel-check.py --live     # 打真实服务器（只读 handler）
```

它起一个临时面板（QuickJS 引擎）+ 一个 mock jacc 服务器，跑 `send-code`，
然后把**真正发出去的字节**与 `reference/packets/24680_req_outer.bin` 对拍：
内层必须逐字节相同（只允许 requestId / UUID / 手机号三处不同），
外层头只允许总长度字段不同，尾字节必须是 `0x03`。

这条脚本存在的理由：这个插件坏过两次，都不是协议理解错，而是「真上网的字节不对」——
宿主把 `Uint8Array` 当文本发（489 → 703 字节，服务端 500），以及单文件版漏了
`writeStructEnd`（只有调用没有定义，二进制路径一跑就 ReferenceError）。

## 协议证据

全部字节级结论见 `mcloud-capture/cctv-video/re/14-jacc-envelope-and-sms-login.md`
（§3 信封与 0x03 尾字节、§5 发码字段、§12.11 TaskComplete=任务 id）。
CLI 版（`asunajs/yangshipin`，含对拍测试）与本插件共享同一套骨架与字段替换逻辑。
