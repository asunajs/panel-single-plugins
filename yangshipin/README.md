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

## 定时任务与请求节奏

```
0 5,17 * * * ~1h      # 每天早 5 点 + 晚 5 点，各带 ±1 小时随机
```

**早场主做，晚场兜底**。任务额度按自然日 0 点重置，早上那次通常就把当天做满了，
所以晚 5 点多半是：

```
兜底检查：今天已完成，未发送任务请求；当前积分 150     ← 1.0 秒，零个任务包
```

它的价值只在**早上没成**的时候：网络失败、会话过期、机器没开机、或者额度没吃满，
晚场会接着把缺口补上（`planTasks` 按 `maxCompleteCount - completedCount` 现算）。

**`~1h` 是抖动后缀**（`host-api.md` §1.2.8）：每次计算下一拍时重新抽随机数，
实际触发落在 `[04:00, 06:00]` 和 `[16:00, 18:00]` 之间随机。模拟结果：

| 理论 | 实际 | 偏移 |
|---|---|---|
| 11-09 05:00 | 04:19 | −40 分钟 |
| 11-09 17:00 | 16:35 | −24 分钟 |
| 11-10 05:00 | 04:28 | −31 分钟 |
| 11-10 17:00 | 16:47 | −12 分钟 |

固定时刻是所有用户在同一秒打同一个接口 —— 既是脚本指纹，也是服务端峰值。
连两次之间的间隔也因此不固定（10–14 小时浮动）。
只往后偏就把 `~1h` 换成 `+1h`；不要抖动直接写 `0 5,17 * * *`。

**一次执行做完今天所有能做的**，不是「跑几轮」：

1. 先查**一次**任务列表，拿到每个任务的 `completedCount` / `maxCompleteCount`；
2. 算出每个任务还差几次（观看/关注各 3 次，点赞/分享/签到各 1 次，最多 15 个包）；
3. **只发还差次数的包** —— 已满的任务一个请求都不发；点赞/分享/签到只在第一轮出现；
4. 发完领取积分。


## 卡死取证看门狗（`tools/ysp-watchdog.sh`）

`step()` 只是兜底，真要定位「为什么挂住」得看线程栈。插件自己卡住时没法自救，
所以有一个**独立于面板**的看门狗：

- 由 launchd 每 30 秒跑一次（`~/Library/LaunchAgents/com.asunajs.panel.watchdog.plist`）
- 判据：最后一条 `[start] [yangshipin]` **晚于**最后一条结束标志
  （`任务 已停止` / `每日任务：N 新完成` / `任务 执行失败`），
  且 start 与最后一条插件日志都静默超过 **90 秒**
- 命中就 `sample <面板 pid> 2`，栈落到
  `~/Library/Application Support/plugin-panel/watchdog/stacks/`
- 同一轮只抓一次（`.last-sampled` 记 start 行号）

> 部署时踩过一次：起初只认「已停止」，而**正常跑完**写的是
> `每日任务：11 新完成 / …`，于是空闲状态被误判成执行中，抓了一份空现场。
> 现在三种结束形态都认。

看现场：`cat watchdog/stacks/stall-*.txt`（先看最后 5 条插件日志与静默时长），
再用 `.stack` 找 Rust 线程停在哪个系统调用。

---

## 超时与预算（防「跑了 10 分钟什么也没干」）

一轮任务由 7~15 个包组成，包间隔 3~50 秒，正常 **1~3 分钟**跑完。历史上出现过
两次「占满 600 秒预算被杀」，根因不是任务慢，而是**某一步永久挂住**：

| 挂点 | 为什么能挂 |
| --- | --- |
| `fetch` 读体（`res.text()` / `arrayBuffer()`） | 面板的 `timeout_ms` 只管请求阶段，读体是另一段 |
| `gunzipSync` | QuickJS 里是**同步宿主 RPC**，宿主不返回时 JS 侧连 `catch` 都轮不到 |
| 兑吧跳转循环的 `duFetch` | 每次都没传超时 |

现在的三层防护：

1. **`step()` 单步 25 秒硬上限** —— 覆盖 `h5`/`jacc` 的请求与读体、`gunzip`、
   `duFetch`。超时会抛一句带名字的错误（`h5 /web/task/point/nocollect 读体 超过 25 秒未返回`）
   并**继续往下跑**，而不是拖到预算耗尽。
2. **cron 预算压到 240 秒** —— 同步死循环（`step` 拦不住，实测确认）的最后兜底。
3. **每步都有日志** —— `→ 阶段名` / `jacc cmd=N →←` / `h5 GET path →←`，
   卡住时最后一条即位置。

> 实测：修复前一轮 600 秒被杀；修复后同样的失败场景 **41 秒**干净结束。

---

## 两个「签到」

这个 App 里有**两套签到**，互不相干：

| | 任务表里的「每日签到」 | 兑吧签到（真签到） |
|---|---|---|
| 入口 | 积分任务列表 `id=28` | 积分页 → 签到按钮 → H5 |
| 实现 | `TaskComplete(28)` | `POST /sign/component/doSign` |
| 给分 | **0 分**（`point: 0`） | 1-6 天各 5 分，第 3 天抽奖，第 7 天 20 分 + 抽奖 |
| 上限 | 1/天 | 连续 7 天一个周期，周期内最高 50 分 |

只刷前者会出现「任务表显示签到 1/1，但兑吧里一次没签」——两边是两套账。

## 兑吧签到链路（纯 HTTP，不需要 App / 浏览器）

```
① GET  /web/jump_duiba?redirect=<兑吧签到页>   → 带一次性免登票的 autologin URL
② GET  autologin（手动跟 302）                 → 在 jifenmall.yangshipin.cn 立起兑吧会话
③ POST /chw/ctoken/getToken                    → 返回 ~18KB 混淆 JS
④ eval 那段 JS                                  → window['40d5f02t'] = 9 位一次性 token
⑤ POST /sign/component/doSign                  → body: signOperatingId=..&token=..
```

几个坑：

- **③ 必须带 `referer` / `origin` / `accept` / `accept-language`**，否则服务端直接掐连接（不给响应体，表现为 `Remote end closed connection`）。
- **④ 的键名 `40d5f02t` 是服务端写死的**。那段 JS 会往 `window` 上撒几十个同形状的干扰变量（`cw7mxls`、`aj26afec1`…），只有这一个是真的 token。
- 那段 JS **能脱离浏览器执行**（不需要 DOM），插件里用 `new Function('window','document','navigator','location', js)` 传一个假 window 即可。
- `token` 每次不同（`q2hkm6ddk`、`kdwjcgl`…），随机编一个会被判「非法token」——服务端真的校验。

已签到时接口返回 `{"success":false,"code":null,"desc":"今日已签到"}`，这是正常状态不是错误；插件发写请求前会先查 `index`，已签就直接跳过（幂等）。

**间隔按动作分级**，不是一刀切：

| 动作 | 间隔 | 为什么 |
|---|---|---|
| 观看（电视/视频/直播）同一任务两次之间 | **35–50 秒** | 任务要求「观看 30 秒」，几秒内连发 3 次自相矛盾 |
| 关注央视频号 两次之间 | 8–20 秒 | 点进去、点关注、退出来 |
| 换到另一个任务 | 3–8 秒 | 切页面 / 换动作 |
| 点赞 / 分享 / 签到 | 各只做 1 次 | 不存在「同一任务两次」 |

编排上**同一个任务连着做完**（电视×3 → 视频×3 → 直播×3 → 关注×3 → 点赞 → 分享 → 签到），
而不是按轮交错 —— 交错会让相邻请求全是「不同任务」，只能统一用长间隔，
把点赞、分享也拖到 30 秒，既慢又不像人。

| 情况 | 包数 | 总时长 |
|---|---|---|
| 全新账号 | 15 | ≈5.2 分钟 |
| 已做过一半 | 7 | ≈2–3 分钟 |
| 当天已满 | 0 | **1.2 秒**（零请求） |

看观看间隔可用 `config().watch_gap_ms` 放大（下限钉死 32 秒，上限 120 秒）。
面板 `budget_ms` 硬上限是 10 分钟，超了是 SIGKILL 进程组，
所以插件先估总时长，超预算就把间隔等比例压缩，另有一道 deadline 兜底。

**多账号**：一个账号一条 `register_cron`，绝不在一次调用里循环账号 ——
2 个账号就是 16 分钟，必被砍。当前实现是单账号（`state.json` 里一份会话）。

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
| `signin` | 兑吧真签到（写操作，幂等） |
| `export-cookies` | 导出 H5 cookie（Netscape + JSON） |

## 能力与边界（诚实清单）

**能做**（2026-11-07 真机验证）：

- 短信登录 → 三枚 token（access_token / refresh_token / vusession，映射逐字节比对过）；
- `TaskComplete`(25042) 尾字节 = 任务 id，7 个任务全部脚本写满 maxCompleteCount；
- **兑吧真签到**（连续 7 天周期）：`jump_duiba → autologin → ctoken → eval → doSign`，纯 HTTP 跑通，
  不需要 App、不需要浏览器；
- H5 领取积分、导出 cookie（vplatform=5，iOS）。

**不能做**：

- **任务表里的「每日签到」不给分**——`point: 0`，它只是把计数写满；真正的分要靠兑吧签到（已实现）；
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
