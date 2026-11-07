# 面板侧待办（补齐后插件可以去掉的兼容代码）

> 本文件是 `yangshipin` 插件作者的**反向需求清单**：插件现在硬兼容的三类问题，
> 根因都在面板宿主，面板补齐后插件代码可以删掉对应分支。
> 每条都写了现状、提议、验收判据，按代价从低到高排序。

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

## 3. QuickJS 的 `fs.mkdirSync`（小）

**现状**：QuickJS 的 `fs` 兼容层没有 `mkdirSync`（或行为不同）。插件现在
`try { fs.mkdirSync('data', { recursive: true }); } catch {}` 静默吞掉。

**提议**：QuickJS `fs.mkdirSync(path, {recursive})` 语义对齐 Node（已存在不报错）。

**验收**：QuickJS 里连续两次 `mkdirSync('data', {recursive: true})` 都不抛。

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

## 优先级建议

| # | 项 | 代价 | 收益 |
| --- | --- | --- | --- |
| 1 | base64 请求体 | 极小（schema + 一处 decode） | **QuickJS 引擎跑通二进制插件**，收益最大 |
| 2 | QuickJS gzip | 小（flate2 一次封装） | 配合 #1 彻底去掉"必须切 Node 引擎"的说明 |
| 3 | mkdirSync | 极小 | 代码洁癖 |
| 4 | 敏感输入 | 中（前端） | 一次性凭据不落配置文件 |
| 5 | summary 显示 | 确认即可 | — |

---

## 附：当前插件对宿主的全部假设

给面板实现者自查用（`yangshipin.ts` 里逐条可搜）：

| 假设 | 出处 | 若不成立 |
| --- | --- | --- |
| Node 引擎 `fetch` 吃 `Uint8Array` | `nativeFetchHttp` | 已有兜底报错 |
| Node 引擎 `process.getBuiltinModule('node:zlib')` | `gzipMember` | 回退 `require`，再不行抛错 |
| QuickJS `http_fetch` 同步、返回 `{status, body}` | `h5Http` 的 QuickJS 分支 | 报错信息已写明 |
| QuickJS `fs` 相对路径围栏在数据目录 | `readState` / `writeState` | `docs/plugin-fs.md` §22.1 承诺 |
| `config()` 按 mtime 缓存、保存后无需重载 | `readConfig` | `docs/host-api.md` §1.2.10 承诺 |
| `register_handler` 第三参 `{summary}` 可选 | 8 个 handler | 若面板忽略也不报错 |
