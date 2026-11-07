# 面板会话提示词：QuickJS 全能力改造（base64 请求体 + gzip）

> 用法：把本文件全文粘给面板仓库（rust-plugin-panel）的工作会话。
> 分两段跑：先做功能 A，验收过再做功能 B；A+B 完成后跑 C 的回归。
> 背景结论都已核对过源码与文档行号，可直接动手；不确定的行号先 grep 再改。

---

## 背景（30 秒读完）

面板插件跑三个引擎。央视频插件（asunajs/panel-single-plugins 仓 yangshipin/yangshipin.ts）
要发**二进制 HTTP 信封**（jacc 协议：`[24B 头][63B 段][BE16][gzip 内层][0x03]`），
现在只有 Node/Bun 引擎能跑（原生 fetch 吃 Uint8Array + node:zlib），
QuickJS 引擎只能跑它的 H5 文本接口。原因就两个：

1. 宿主 `http_fetch` 的 body 只收文本，插件没有任何办法发二进制
   （docs/plugin-api.md §4.10 写的"自己 base64"是死路——宿主拿到 base64 字符串只会当文本发出去）；
2. QuickJS 没有 `node:zlib`（docs/node-compat.md 里整行 ❌），连 gzip 内层都组不出来。

需求清单原文在 `asunajs/panel-single-plugins` 仓的 `yangshipin/PANEL-TODOS.md`
（#1、#2 两条 + "QuickJS 全能力的路径"一节）。本次把这两个缺口补上，
补齐后该插件在 QuickJS 里全功能可跑，README 的"必须切 Node 引擎"说明整体删除。

**参考实现基线**：本仓 `yangshipin/` 里的 CLI 版（`src/`）是这套协议的**金标准**——
它有逐字节对拍测试。面板会话做的是**宿主能力**，协议字节不该在这里出现。

---

## 功能 A：`http_fetch` / `fetch_async` / `fetch` 支持 base64 请求体与响应

### 要做什么

`options` 新增 `body_base64`（string）；响应对象新增 `body_base64`（string）。
语义：

- 请求：`body_base64` 与 `body` **互斥**，同时给 → 明确报错
  `"body 与 body_base64 只能给一个"`。给了 `body_base64` → 宿主 base64-decode 成字节，
  以 `application/octet-stream` 原样发出（用户 headers 里的 content-type 优先）。
- 响应：**总是**同时返回 `body`（现状的 str，行为一字不改）和 `body_base64`
  （响应原始字节的 base64）。文本场景多一个字段没人用；二进制场景就是救命字段。
- 三个引擎一致：QuickJS 宿主侧解码；Node/Bun 兼容层同样处理（语义对齐，实现各自）。

### 改哪里（已核对的落点）

1. `src/hostapi.rs:796` `do_http_fetch`：
   - opts 解析处（`body` 取值旁边）加 `body_base64`；
   - 互斥校验；
   - 解码用 `base64` crate（**已是依赖**，Cargo.toml:97 `base64 = "0.23"`，
     `use base64::Engine as _; base64::engine::general_purpose::STANDARD.decode(...)`）；
   - 解码失败报错：`"body_base64 不是合法 base64: <原因>"`；
   - **字节必须原样到传输层**。现状两条后端的 body 都是 `&str`（ureq 路径
     hostapi.rs:1592 `req.body(body.to_string())`、reqwest native :1596 同形）——
     把参数类型改成 `&[u8]`（或 `Vec<u8>`），文本路径 `body.as_bytes()` 传入即可零行为变化；
     二进制路径传解码后的字节。**不要**把解码后的字节再转 String（那就是本次要修的 bug 本身）。
   - 响应组装处：读出来的字节除按现状转 `body` 文本外，同时 base64-encode 放 `body_base64`。
2. `src/jscompat/fetch.js`：Web 形状 `fetch` 的 options 透传 `body_base64`；
   `Response` 包装层把 `body_base64` 挂到响应对象（`bytes()` 现在从"已读完的整段"切——
   让它优先用 `body_base64` 解码，这样 QuickJS 的 `bytes()` 第一次能拿到真字节）。
3. `src/extproc.rs`（Node/Bun 适配器）：`fetch_async` / Node 端 `fetch` 兼容层同步该语义。
4. `docs/host-api.md` §1.4 / `docs/plugin-api.md` §4.10 表格更新：
   "请求体只收文本"改为"文本或 `body_base64`"；把那句误导性的"自己编码成文本（base64）"
   删掉或改写为指向新参数。
5. `docs/node-compat.md` 相应行。

### 验收（写进测试）

- 单元：`do_http_fetch` 收 `body_base64`（含 `+/=` 与无 padding 两种）→ 传输层收到的字节数与解码后一致；
  同时给 `body` + `body_base64` → 报错；非法 base64 → 报错且**没有发出请求**。
- 回归：现有 fetch/fetch_test.rs 全绿；`body` 纯文本路径行为零变化。
- 端到端（可直接抄）：起本地 echo server，QuickJS 插件里发
  `http_fetch(url, {method:'POST', body_base64: <489B 信封的 base64>, headers:{'content-type':'application/octet-stream'}})`
  → echo 收到的字节数 = 489（修复前经文本层是 703）。
  489B 测试向量在 `asunajs/yangshipin` 仓 `reference/packets/24680_req_outer.bin`。

---

## 功能 B：QuickJS gzip/gunzip

### 要做什么

让 QuickJS 插件能 gzip/gunzip。**两个落点都做**（代价都很小，覆盖两类调用习惯）：

1. **host-api 新函数**：`gzip(bytes) -> {b64: string}`、`gunzip(b64: string) -> {b64: string}`。
   输入输出都走 base64 —— 与功能 A 的 `body_base64` 呼应，插件侧永远不碰裸字节穿越问题。
   （签名如果你们更愿意 `(bytes) -> bytes`，也可以，但必须在 QuickJS 的 Buffer 兼容层上成立。）
2. **`node:zlib` 兼容层**：QuickJS 的 node 兼容里补 `gzipSync` / `gunzipSync`
   （`docs/node-compat.md` 里 `node:zlib` 那行 ❌ → 🟡，标注"仅 gzip/gunzip 两个同步函数"）。

### 改哪里

1. `src/hostapi.rs`：新 `do_gzip` / `do_gunzip`，用 `flate2`
   （**已在依赖树**：ureq 3 → flate2 1.1.10，直接显式加进 `[dependencies]` 即可）；
   compression level 用默认，但 **gzip 头的 mtime 必须置 0** —— 有些协议信封
   对头字节敏感，央视频 CLI 版就是 `gzipSync(buf, {mtime: 0})`。
2. `src/jscompat/`：照 `node_crypto.js` 的模式加 `node_zlib.js`（JS 侧从 host-api 转调）+
   注册进内置模块表；host-api 侧暴露 `gzip` / `gunzip`。
3. `docs/host-api.md` 函数表 + `docs/node-compat.md` `node:zlib` 行更新。

### 验收

- 单元：任意 100B 随机字节 → gzip → gunzip 逐字节相等；gzip 输出以 `1f 8b` 开头、
  头部 mtime 字节（第 4–7 字节）为 0；非法 gunzip 输入 → 明确报错。
- 端到端：QuickJS 里 `zlib.gzipSync(Buffer.from('x'.repeat(100)))` 不抛且产物正确。

---

## 功能 C（收尾）：央视频插件回归

A+B 都合并后，在面板里验证：

```bash
# 1. 商城安装（或本地放）yangshipin 插件，引擎选 QuickJS，不切 Node
# 2. 配置 phone 后依次跑：
#    send-code → （真机收码，填 code）→ login → session-check → do-tasks
# 3. 全部应成功；README"引擎要求"一节此时已过时 —— 提醒插件侧更新
```

插件侧配合改动（在 `asunajs/panel-single-plugins` 仓，**不是本仓**）：
`IS_NODE` 探测改为能力探测
（`typeof gzip === 'function' && typeof http_fetch === 'function'`），删除 `quickJsUnsupported`。
这个改动等 A+B 真落地后再做，PANEL-TODOS.md 里已写好方案。

---

## 红线（防跑偏）

- **协议字节不要出现在面板仓**：宿主只提供"发字节/压字节"的通用能力，
  jacc 信封怎么组是插件的事。测试用 `asunajs/yangshipin` 的对拍产物当向量即可。
- **向后兼容是硬约束**：`body` 文本路径、现有 `Response` 形状、现有测试，一个都不能变。
  新能力全部走新增字段/新函数。
- **SSRF/超时/脱敏对 base64 路径同样生效**：`body_base64` 不允许成为绕过
  `ensure_outbound_url_allowed` 的口子（功能 A 的实现位置已经保证了这点，验收时确认一遍）。
- 文档与实现同步改：本仓的规矩是 docs 行号即契约（host-api.md 的函数表、node-compat.md 的矩阵），
  改了实现不改文档 = 没改。
