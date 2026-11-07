# 央视频（yangshipin）短信登录 + 积分任务

单文件面板插件。手机号 + 短信验证码登录央视频 App 通道，保存登录态，
一键结算全部积分任务并领取（实测积分 15 → 80）。

## 安装

「插件列表 → 插件商城」→ 央视频 → 安装。安装时 `.ts` 自动转 `.js`。

**面板要求：≥ 0.3.0**（源文件头的 `@panel` 声明会让老面板在加载时直接拒载）。

**三个引擎全功能、同一份代码**：0.3.0 起 QuickJS 的 `fetch` 也吃 `Uint8Array`、
也有 `node:zlib` / `node:fs`，所以发码/登录/结算这条二进制路径与 Node 分支**逐字相同**
——文件里已经没有任何 `IS_NODE` 分支了。

## 使用（人机配合，一次登录长期可用）

1. 「插件列表 → 配置」添加 `phone`（11 位手机号）；
2. 运行任务 `send-code` → 去手机上看短信；
3. 把 6 位数字填进配置项 `code`，运行 `login`；
4. 完成。之后每天跑一次 `do-tasks`（可挂面板定时任务）即可。

## handlers

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
