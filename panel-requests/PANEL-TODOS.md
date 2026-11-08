# 面板侧待办（补齐后插件可以去掉的兼容代码）

> 本文件是 `yangshipin` 插件作者的**反向需求清单**：插件现在硬兼容的三类问题，
> 根因都在面板宿主，面板补齐后插件代码可以删掉对应分支。
> 每条都写了现状、提议、验收判据，按代价从低到高排序。

---

## ✅ 已实现：`fetch` 支持 `redirect: 'manual'` + `Headers.getSetCookie()`

**（2026-11-08 已由 panel `6fe1ace` 实现并发布；本节留作验收记录）**

**当初的问题**：免登 / OpenID 类链路的会话 cookie 在 **302 那一跳**用 `Set-Cookie` 下发
（一次十几条），宿主的 `fetch` 只认 `redirect:'follow'` 且跟跳后丢弃中间响应头，
插件完全无法复现。央视频→兑吧签到就卡在这：`autologin` 的 11 条 cookie 全丢，最终落到
`/sign/notlogin`。

**已做的改动**：

| 位置 | 改动 |
| --- | --- |
| `src/hostapi.rs` | `do_http_fetch` 新增 `redirect` 选项（`follow`/`manual`/`error`）；`manual`/`error` 不跟跳、3xx 原样交回；返回体加 `set_cookie` 数组（`Set-Cookie` 不允许合并） |
| `src/jscompat/fetch.js` | 放行 `manual`/`error` 并透传；`responseFromHost` 重建多条 `Set-Cookie`；新增 `Headers.prototype.getSetCookie()` |
| 测试 | 原「只支持 follow」的断言改为 `redirect_policy_is_follow_manual_or_error`；全套 627 passed / 0 failed |

**验收读数**（QuickJS 引擎，真机）：
```
hop1: status=302 setCookie=0   jar=0
hop2: status=302 setCookie=11  jar=11     ← 修复前这里全丢
hop3: status=302 setCookie=0   jar=11
hop4: status=200 setCookie=0   jar=11
```

**插件侧可删的分支**：不再需要「必须切 Node/Bun 引擎」的守卫；现在只剩一句
能力探测（老面板报 `redirect` 不支持时翻译成人话）。

---

## 1. `http_fetch` 支持 base64 请求体（一行 schema，代价最小）

**现状**（`docs/host-api.md` §1.4 / `docs/plugin-api.md` §4.10）：

> `fetch` 只收文本请求体。`Uint8Array` / `ArrayBuffer` ⇒ `fetch` 返回已 reject 的
> Promise（`TypeError`）……要发字节请自己编码成文本（base64）

**但宿主拿到 base64 字符串后并不会还原成字节发出去**——它就是当普通文本发的。
所以"自己 base64"这个建议实际上是**死路**：宿主侧没有解码动作，二进制信封发出去就是错的。

**提议**：`http_fetch` / `fetch_async` / `fetch` 的 `options` 增加一项：

```js
http_fetch(url, { method: 'POST', body_base64: b64str, headers: { 'content-type': 'application/octet-stream' } })
```

- 宿主在发送前 `base64 → bytes`，其余流程（SSRF、超时、日志脱敏）不变；
- 响应体同步增加 `body_base64` 字段（现有 `body: str` 保持不变，避免破坏老插件）；
- 三个引擎一致：QuickJS 宿主侧解码；Node/Bun 原生 fetch 侧包一层同样的语义。

**验收**：插件发一个 489 B 的二进制信封，本地 echo server 收到的字节数 = 489
（现在经文本层是 703 B）。这个用例直接救活 QuickJS 引擎的央视频登录。

**插件侧可以删的代码**：`quickJsUnsupported` 分支、`IS_NODE` 判定里关于二进制的部分。

---

## 2. QuickJS 内置 gzip/gunzip（或注入 host-api）

**现状**：QuickJS 宿主没有 zlib。jacc 信封是 `[头][guid 段][BE16][gzip 内层][0x03]`，
gzip 不可用 ⇒ 内层都组不出来。现在的 workaround 是把 `node:zlib` 挂在 Node 引擎的
`process.getBuiltinModule` 上，QuickJS 路径直接抛错。

**提议**（三选一，按实现代价排序）：

| 方案 | 做法 | 说明 |
| --- | --- | --- |
| a. host-api 新函数 | `gzip(bytes) -> bytes` / `gunzip(bytes) -> bytes` | 面板 Rust 侧用 `flate2`，一处实现三引擎受益 |
| b. 兼容层补 `zlib` | QuickJS 的 `node:zlib` 兼容层加 `gzipSync` / `gunzipSync` | 跟现有 `node:crypto` 兼容层同思路 |
| c. `Buffer` 顺带 | `Buffer.from(b64, 'base64')` 已有；再加 `zlib.gzipSync` 即可 | 同 b |

**验收**：QuickJS 引擎里 `gzipSync(Buffer.from('x'.repeat(100)))` 返回 0x1f 0x8b 开头的字节。

**插件侧可以删的代码**：`gzipMember` / `gunzipMember` 的 `IS_NODE` 分支。

---

## 3. ~~QuickJS 的 `fs.mkdirSync`~~（已核实：不缺，作废）

**2026-11-07 复核**：`docs/node-compat.md` §node:fs 导出清单里 `mkdirSync` 是 🟡
（`mkdirSync(path, {recursive}?)`，语义与 Node 一致）。插件里的 try/catch 只是防御性写法，
不是兼容需要。**本条作废**，留作"写待办前先查 node-compat.md 矩阵"的记录。

QuickJS `fs` 真正的注意事项只有两条：`writeFileSync` 忽略 options（不转码）、
`readFileSync` 只认 utf8 编码 —— 对本插件都无影响（写的 JSON、读的 JSON）。

---

## 4. 配置表单的「敏感输入」类型（体验）

**现状**：配置表单里 `code`（短信验证码）、`phone` 都是普通文本框，
值会留在浏览器输入历史 / 面板日志里。

**提议**：`config.json` 支持字段级提示（可选）：

```json
{
  "phone": "13800138000",
  "code": "",
  "__form__": { "code": { "type": "password", "placeholder": "6 位短信验证码", "ttl": 300 } }
}
```

- `type: password`：输入框不回显、不进日志；
- `ttl`：验证码类字段 N 秒后由面板自动清空（一次性凭据不该长期躺在配置文件里）。

**验收**：设置 `ttl` 后，验证码在表单里 5 分钟后自动消失；日志里永远没有 code 值。

---

## 5. `register_handler` 的 payload 提示（已有，确认即可）

`register_handler(name, handler, { summary })` 面板已经支持（`docs/host-api.md` §1.2.1）。
**待确认**：面板任务列表上是否把 `summary` 显示出来？如果已显示，这条可关闭。

---

## 6. 商城支持多文件 `.ts` 工程（type: dir / zip 源码）

**现状**（`docs/market.md` §TypeScript）：

> `.ts` 单文件在安装时转成 `.js`，运行时不会加载 TypeScript，也不会为它引入
> `tsx`/`tsconfig`/npm 依赖解析。插件只能 import `host-api` 或**自己携带的代码**。

"自己携带的代码"目前只有一条路：**全部内联进一个文件**（本插件 32 KB 就是这么来的）。
协议类插件一内联就会出现：JCE 编解码 + 信封 + 4 份骨架 base64 + 业务 + H5 全挤在一起，
可审阅性明显下降 —— 单文件本来就以"容易审阅"为卖点，超过一定体积后这个卖点反转。

Release zip 路径倒是支持多文件，但要求打 Release（版本节奏重）；日常迭代想直接从分支装。

**提议**：`type: "file"` 之外加 `type: "dir"`：

```json
{
  "id": "yangshipin",
  "repo": "asunajs/panel-single-plugins",
  "type": "dir",
  "path": "yangshipin-ts/",        // 目录：入口 + 相对 import 的模块
  "entry": "plugin.ts",
  "ref": "main",
  "provides": ["yangshipin"]
}
```

安装时：

1. 用 GitHub contents API 递归拉目录内文件（或 git trees API 一次拿）；
2. 相对 import 拓扑排序后**合并/打包成一个 .js**（面板已有 OXC，缺的只是 bundling 一步；
   或约定"只允许一层相对 import，按序拼接"的最简实现）；
3. 后续转译/校验/落盘流程与单文件完全一致，产物仍是 `plugins/js/<id>.js`。

**边界**（建议照搬单文件的哲学）：

- 不解析 tsconfig paths / npm 依赖（仍然只有 host-api + 自带代码）；
- 目录大小上限沿用 32 MiB；
- `sha256` 记录为"目录内文件按路径排序后逐个拼接的 SHA"（安装标记里写明算法）。

**验收**：把本插件拆回 `jce.ts / envelope.ts / skeletons.ts / plugin.ts` 四个文件，
`type: dir` 安装后行为与单文件版一致，安装标记记录 4 个源文件。

**插件侧可以删的代码**：无（这是商城体验项，不影响运行时）；
但拆分后 `single-file-plugin.ts` 模板可以退役成"打包含示例"。

---

## 优先级建议

| # | 项 | 代价 | 收益 |
| --- | --- | --- | --- |
| 1 | base64 请求体 | 极小（schema + 一处 decode） | **QuickJS 引擎跑通二进制插件**，收益最大 |
| 2 | QuickJS gzip | 小（flate2 一次封装） | 配合 #1 彻底去掉"必须切 Node 引擎"的说明 |
| 3 | ~~mkdirSync~~ | — | 作废（node-compat.md 已有 🟡） |
| 4 | 敏感输入 | 中（前端） | 一次性凭据不落配置文件 |
| 5 | summary 显示 | 确认即可 | — |
| 6 | 商城多文件 dir | 中（拉目录 + 打包一步） | 协议类插件可拆模块，恢复可审阅性 |

## QuickJS 全能力的路径（#1 + #2 落地后）

逐项核对 `node-compat.md` 矩阵后的结论：**QuickJS 跑全功能只差 2 个缺口**。

| 能力 | QuickJS 现状 |
| --- | --- |
| `TextEncoder/Decoder`、`URL/URLSearchParams`、`atob`、`crypto.randomUUID` | ✅ 兼容层已有 |
| `Buffer.from(b64, 'base64')` | ✅ `node:buffer` 兼容层已有 |
| 文本 HTTP | ✅ `http_fetch` |
| `node:fs`（readFileSync / writeFileSync / mkdirSync） | ✅ 兼容层已有（🟡 但够用） |
| `node:zlib`（gzip/gunzip） | ❌ **缺口 1** → 待办 #2 |
| 二进制请求体 | ❌ **缺口 2** → 待办 #1 |
| `process` / `getBuiltinModule` | ❌（明确不做）→ 插件引擎探测须改（见下） |

#1 + #2 落地后的插件形态：

- 登录全流程（发码 → NewLogin → 24802 → TaskComplete ×7）全走宿主 `fetch`
  （`body_base64` 进 / `body_base64` 出），**一个 IS_NODE 分支都不剩**；
- 额外收益：QuickJS 路径全部过宿主数据面（SSRF 判定 / 超时钳位 / 1 MiB 上限 / 日志脱敏），
  比 Node 原生 fetch **更可控**；
- 插件引擎探测改法：不探测 `process`（QuickJS 明确没有），改为探测宿主能力本身
  —— `typeof gzip === 'function' && typeof http_fetch === 'function'` 即视为宿主通路可用。

## 附：当前插件对宿主的全部假设

给面板实现者自查用（`yangshipin.ts` 里逐条可搜）：

| 假设 | 出处 | 若不成立 |
| --- | --- | --- |
| Node 引擎 `fetch` 吃 `Uint8Array` | `nativeFetchHttp` | 已有兜底报错 |
| Node 引擎 `process.getBuiltinModule('node:zlib')` | `gzipMember` | 回退 `require`，再不行抛错 |
| QuickJS `http_fetch` 同步、返回 `{status, body}` | `h5Http` 的 QuickJS 分支 | 报错信息已写明 |
| QuickJS `node:fs` 有 readFileSync/writeFileSync/mkdirSync（🟡） | `readState` / `writeState` | `docs/node-compat.md` §node:fs 已核 |
| QuickJS `fs` 相对路径围栏在数据目录 | `readState` / `writeState` | `docs/plugin-fs.md` §22.1 承诺 |
| `config()` 按 mtime 缓存、保存后无需重载 | `readConfig` | `docs/host-api.md` §1.2.10 承诺 |
| `register_handler` 第三参 `{summary}` 可选 | 8 个 handler | 若面板忽略也不报错 |
| 引擎探测用 `process.versions` | `IS_NODE` | **QuickJS 明确无 `process`** ⇒ 探测必然两分支；
  面板若加"能力探测"宿主函数（见 §QuickJS 全能力的路径），此处应改写 |
