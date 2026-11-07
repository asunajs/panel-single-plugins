# 央视频（yangshipin）短信登录 + 积分任务

单文件面板插件。手机号 + 短信验证码登录央视频 App 通道，保存登录态，
一键结算全部积分任务并领取（实测积分 15 → 80）。

## 安装

「插件列表 → 插件商城」→ 央视频 → 安装。安装时 `.ts` 自动转 `.js`。

**引擎要求**：`send-code` / `login` / `do-tasks` / `like` / `session-check`
要发二进制信封，需要在插件卡片上把引擎切到 **Node 或 Bun**。
QuickJS 引擎只能跑 `h5-check` / `tasks` / `export-cookies`（纯 JSON）。

## 使用（人机配合，一次登录长期可用）

1. 「插件列表 → 配置」添加 `phone`（11 位手机号）；
2. 运行任务 `send-code` → 去手机上看短信；
3. 把 6 位数字填进配置项 `code`，运行 `login`；
4. 完成。之后每天跑一次 `do-tasks`（可挂面板定时任务）即可。

## handlers

| 名字 | 作用 | 引擎 |
| --- | --- | --- |
| `send-code` | 发短信验证码（写操作） | Node/Bun |
| `login` | 用 `code` 登录，token 落 `data/state.json` | Node/Bun |
| `session-check` | App 侧验活（24802） | Node/Bun |
| `h5-check` | H5 会话自检 | 任意 |
| `tasks` | 任务列表 + 当前积分 | 任意 |
| `do-tasks` | 结算 7 个任务 + 自动领取 | Node/Bun |
| `like` | 点赞一次（幂等） | Node/Bun |
| `export-cookies` | 导出 H5 cookie（Netscape + JSON） | 任意 |

## 能力与边界（诚实清单）

**能做**（2026-11-07 真机验证）：

- 短信登录 → 三枚 token（access_token / refresh_token / vusession，映射逐字节比对过）；
- `TaskComplete`(25042) 尾字节 = 任务 id，7 个任务（含每日签到）全部脚本写满 maxCompleteCount；
- H5 领取积分、导出 cookie（vplatform=5，iOS）。

**不能做**：

- **观看/分享/关注类任务不需要真实动作**——`TaskComplete` 直接写计数（今晚订正的结论）；
- 不能无限刷分：到 `maxCompleteCount` 后幂等返回 `task has been complete`；
- QuickJS 引擎发不了二进制信封（宿主 `http_fetch` 只收文本），会明确报错；
- 24802 验活在部分会话状态下回业务码 6（CLI 与插件行为一致，属服务端侧状态）。

**安全**：

- token 只落插件数据目录 `data/state.json`（宿主 0600），不进日志、不进错误文本；
- 本文件内所有骨架均为**脱敏占位**（`A`×43 token、`900000001` vuserid 等）；
- 短信验证码一次一码，插件不做自动重试（防风控）。

## 协议证据

全部字节级结论见 `mcloud-capture/cctv-video/re/14-jacc-envelope-and-sms-login.md`
（§3 信封与 0x03 尾字节、§5 发码字段、§12.11 TaskComplete=任务 id）。
CLI 版（`asunajs/yangshipin`，含对拍测试）与本插件共享同一套骨架与字段替换逻辑。
