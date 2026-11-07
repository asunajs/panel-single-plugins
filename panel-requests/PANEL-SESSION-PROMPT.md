# 面板会话提示词：QuickJS 二进制/gzip 能力补齐（向 Node API 对齐）+ 版本门禁

> 用法：分三段跑——先功能 A，验收过再做 B，最后 C/D。
> 核心原则一句话：**插件面只向 Node API 对齐，不发明面板专属接口**；
> base64 隧道是 compat 层与宿主 RPC 的内部实现细节，插件永远看不见。
> 行号是近期核实的，动手前先 grep 确认。

---

## 背景（30 秒读完）

面板插件跑三个引擎。央视频插件（asunajs/panel-single-plugins 仓 yangshipin/yangshipin.ts）
要发**二进制 HTTP 信封**（jacc 协议：`[24B 头][63B 段][BE16][gzip 内层][0x03]`），
现在只有 Node/Bun 引擎能跑。原因两个：

1. QuickJS 的 fetch 兼容层拒绝二进制请求体（docs/plugin-api.md §4.10：
   "Uint8Array ⇒ fetch 返回已 reject 的 Promise"，并建议"自己 base64"——
   但宿主 RPC 是 JSON 载体，插件自己 base64 后宿主并不会解码，此路实际不通）；
2. QuickJS 没有 node:zlib（docs/node-compat.md 整行 ❌），gzip 内层组不出来。

本仓哲学（plugin-api.md §4.10）："三个引擎同名同义，QuickJS 用面板的实现，
Node/Bun 用平台原生那份，插件源码一字不改"。jscompat 层就是为了删掉
"不要引入 fetch/URL/TextEncoder"那条规矩而存在的。本次补齐遵循同一原则：
**插件面提供 Node 形状 API；base64 隧道藏在 compat↔hostapi 的 RPC 内部**。
补齐后央视频插件在 QuickJS 全功能可跑，且它的二进制路径代码与 Node 分支逐字相同。

**参考基线**：`asunajs/yangshipin` 仓 CLI 版（src/）是协议金标准（逐字节对拍测试）。
面板会话只做宿主能力，协议字节不进本仓。

---

## 功能 A：QuickJS fetch 接受二进制请求体，Response 给出真字节

### 插件面（Node 形状，不新增任何面板 API）

QuickJS compat 层的 fetch 对齐 Node fetch 的 body 类型：

```js
// 三引擎同一段插件代码：
const body = new Uint8Array([...]);            // 或 ArrayBuffer / Buffer
const res  = await fetch(url, { method: 'POST', body, headers: {...} });
const bytes = await res.arrayBuffer();          // 真字节，不是从被改坏的文本切
```

- 现状：`fetch.js` 的 `bodyToText` 对非 string 抛 TypeError（docs 写明"宁可不支持"）；
- 改后：`string` / `URLSearchParams`（现状不变）+ `Uint8Array` / `ArrayBuffer` /
  `Buffer` / `DataView` 接受；`ReadableStream` 仍不支持（无流，沿用现有边界）。
- `Response.arrayBuffer()` / `.bytes()`：从**宿主给的原始字节**返回（见下），
  不再从可能被改坏的文本切。`text()` / `json()` 行为一字不变。

### RPC 面（内部实现，插件不可见）

宿主 `do_http_fetch`（src/hostapi.rs:796）的 JSON opts 增加**内部字段** `body_b64`；
响应 JSON 增加 `body_b64`（原始字节的 base64）：

- 请求：compat 层 JS 把 `Uint8Array` base64-encode 进 `body_b64`；
  宿主在 opts 解析处解码为字节。`body`（str）与 `body_b64` 互斥，
  同给报错（这是 RPC 内部约定，防 compat 层 bug 静默发坏包）；
- 传输层：两条后端现状 body 都是 `&str`（ureq hostapi.rs:1592 `req.body(body.to_string())`、
  reqwest native :1596 同形）——参数改 `&[u8]`/`Vec<u8>`，文本路径 `body.as_bytes()`
  传入即零行为变化；字节路径传解码结果。**不要**把字节再转 String。
- 响应：宿主读到的原始字节，除现状转 `body` 文本外，同时 base64-encode 放 `body_b64`。
  响应体上限 1 MiB 不变，base64 膨胀 33% 属可接受瞬时内存（写进文档说明）。
- 解码/编码用 `base64` crate（已是依赖，Cargo.toml:97）。
- SSRF/超时/日志脱敏对二进制路径同样生效（实现在 `ensure_outbound_url_allowed`
  之后、传输之前，天然覆盖；验收确认）。

### 改哪里

1. `src/hostapi.rs:796` `do_http_fetch`：opts 加 `body_b64`（内部字段），
   互斥校验、解码、传输层参数类型改字节（上述 :1592/:1596 两处）；
   响应组装处加 `body_b64`。
2. `src/jscompat/fetch.js`：`bodyToText` 拆成"文本可转 / 字节走 b64"两条路；
   Request 构造同样接受字节；Response 包装层用 `body_b64` 支撑
   `arrayBuffer()` / `.bytes()`（有 `body_b64` 用它，没有则维持现状从文本切——
   Node/Bun 原生路径本来就给真字节）。
3. `src/extproc.rs`：Node/Bun 适配器如有 fetch 包装，确认原生 fetch 直接吃字节即可
   （平台原生，无需改；有 RPC 包装的话同步内部字段）。
4. docs 三处：`host-api.md` §1.4（body 类型放宽 + `body_b64` 内部字段说明）、
   `plugin-api.md` §4.10 表（"只收文本"行改为对齐 Node 的描述，
   **删掉"要发字节请自己 base64"那句死路建议**）、`node-compat.md` fetch 行更新。

### 验收（写进测试）

- 单元：`do_http_fetch` 收 `body_b64` → 传输层字节数与解码后一致（含 `+/=` 与无 padding）；
  `body`+`body_b64` 同给 → 报错；非法 base64 → 报错且未发请求。
- compat 层：QuickJS 里 `fetch(url, {body: new Uint8Array([0x00,0xff,0x13])})`
  不再 reject；echo server 收到 3 字节与发送逐字节相等（修复前：reject）。
- 端到端（协议向）：489B 信封 base64 后经 QuickJS fetch 发出 →
  echo 收到 489B（对照：走文本层会被改写成 703B——这就是历史 bug 的数字）。
  向量：`asunajs/yangshipin` 仓 `reference/packets/24680_req_outer.bin`。
- 回归：现有 fetch_test.rs 全绿；文本 body 路径行为零变化。
- ⚠ 这是一条**有意的放宽**（旧文档称之为"宁可不支持"）：从"reject"到"接受"是行为变化，
  在 docs 里标注"自 <版本> 起"；预期没有插件依赖旧 reject 行为，但仍写进变更说明。

---

## 功能 B：`node:zlib` 兼容层（gzipSync / gunzipSync）

### 插件面（Node 形状）

```js
import { gzipSync, gunzipSync } from 'node:zlib';
const gz = gzipSync(Buffer.from(inner));    // Buffer，1f 8b 开头
const raw = gunzipSync(gz);                 // Buffer，逐字节等于 inner
```

不发明 `gzip()`/`gunzip()` host-api——`node:crypto`/`node:buffer` 已经确立了
"compat JS 模块 + Rust 真实现"的模式，zlib 照抄。docs/node-compat.md 的
`node:zlib` 行 ❌ → 🟡，标注"仅 gzipSync/gunzipSync（同步，Buffer 进出）"。

### 改哪里

1. `src/hostapi.rs`：内部 RPC `do_gzip_b64` / `do_gunzip_b64`（进出走 base64，
   与功能 A 的 RPC 风格一致），用 `flate2`（**已在依赖树**：ureq 3 → flate2 1.1.10，
   显式加进 `[dependencies]`）；**gzip 头 mtime 必须置 0**
   （有些协议信封对头字节敏感，央视频 CLI 版即 `gzipSync(buf, {mtime: 0})`）。
2. `src/jscompat/node_zlib.js`：照 `node_crypto.js` 模式，JS 侧转调 host RPC，
   返回 compat Buffer；注册进内置模块表。
3. docs：`node-compat.md` zlib 行、`host-api.md` 若在函数表列内部 RPC 则同步。

### 验收

- 单元：100B 随机字节 → gzipSync → gunzipSync 逐字节相等；产物 `1f 8b` 开头、
  头部 mtime 字节（第 4–7 字节）为 0；gunzipSync 非法输入 → 报错文案含"zlib"。
- 回归：无 zlib 依赖的现有插件零感知。

---

## 功能 C（收尾）：央视频插件回归

A+B 合并后在面板验证：

```
# 1. 商城安装（或本地放）yangshipin 插件，引擎 QuickJS，不切 Node
# 2. 配置 phone → send-code → （收码填 code）→ login → session-check → do-tasks
# 3. 全部应成功
```

插件侧配合改动（`asunajs/panel-single-plugins` 仓，**不是本仓**）：
删除 `IS_NODE` 二进制分支与 `quickJsUnsupported`——A/B 落地后该插件的二进制路径
**不再需要任何引擎分支**（这就是对齐原则的直接收益）。

---

## 功能 D：插件版本 ↔ 面板版本兼容门禁

### 问题

新插件用了新 host-api（如做完 A/B 后的央视频插件依赖字节 fetch / node:zlib），
装到老面板上两种坏法：加载就炸（`gzipSync is not defined`，用户只知道"插件坏了"）；
更糟的是运行时才炸（装好了、任务跑了、结算一半抛错）。
老插件装新面板没事（向后兼容是红线），所以门禁单向：**新插件拒绝老面板**。

### 四件事（2 是核心）

**1. 商城目录条目 `min_panel`**

```json
{ "id": "yangshipin", "min_panel": "0.3.0", "...": "不变" }
```

面板版本 < min_panel：商城按钮置灰、提示"需要面板 ≥ 0.3.0（当前 0.2.3）"，
接口返回明确错误（不下载）。不填 = 不设限，现有条目零改动。

**2. 插件加载时声明 + 运行时查询（核心保证）**

目录只挡商城一条路，挡不住手动放文件。真保证在加载时：

- 插件源文件头可选声明（注释形态，转译前可读）：
  `/* @panel { "min": "0.3.0" } */`
- 加载时（QuickJS context 安装序列、插件代码执行前；Node/Bun spawn 前）校验：
  当前版本 < min → 拒载，错误可操作：
  `插件 yangshipin 需要面板 ≥ 0.3.0（当前 0.2.3）。请升级面板：https://github.com/asunajs/panel/releases`
- 运行时查询，给插件做**能力降级**而非硬拒：

  ```js
  panel.version()        // "0.2.3"
  panel.atLeast("0.3.0") // false
  ```

**3. 版本比较语义（一次定死，写进文档）**

- semver 比较（无 crate 就加 `semver`，很小）；预发布 `0.3.0-rc.1 < 0.3.0`；
  缺省 patch 视为 0；非法版本串在解析/加载时报错，不静默降级。

**4. 文档三处**：market.md（`min_panel` 行）、host-api.md（`panel.version/atLeast` +
`@panel` 头）、plugin-api.md（插件作者怎么写门禁）。

### 改哪里（已核对）

1. `src/market.rs`：目录解析加 `Option<String>` `min_panel`；安装/更新入口校验，
   拒绝时返回带双方版本的结构化错误。
2. `src/web.rs:4809` `pub const VERSION` 已有；启动时注入两引擎
   （QuickJS context 变量 / Node 环境变量 `PANEL_VERSION`）。
3. 门禁：QuickJS 在 `install_host` 末尾（jscompat 注入同层）读 `@panel` 头判定；
   Node/Bun 在 `extproc.rs` spawn 前读。

### 验收

- 商城：测试条目 `min_panel: "999.0.0"` → 置灰/报错且含双方版本；恢复后可装。
- 加载：带 `/* @panel { "min": "999.0.0" } */` 的本地插件 → 拒载，错误含双方版本与升级链接。
- 查询：`panel.atLeast("0.0.1") === true`、`panel.atLeast("999.0.0") === false`，
  `panel.version()` 与 web.rs VERSION 一致。
- 回归：**无 `@panel` 头的现有插件全部照常加载**（绝大多数，绝不能误伤）。

### 插件侧配合（后续）

央视频插件发依赖新能力的版本时：源文件加 `@panel` 头、商城条目同步 `min_panel`；
代码里用 `panel.atLeast` 对老宿主降级提示，不让用户看裸报错。

---

## 红线（防跑偏）

- **插件面只向 Node 对齐**：不新增插件可见的面板专属 API（`body_b64`/内部 RPC 字段
  必须留在 compat↔hostapi 之间）。判断标准：插件代码拿到任何引擎（含面板外的裸 Node）
  都应该跑得通。
- **协议字节不进面板仓**：宿主只提供通用"发字节/压字节"，jacc 信封怎么组是插件的事；
  测试向量用 `asunajs/yangshipin` 的对拍产物。
- **向后兼容硬约束**：文本 body 路径、`text()/json()`、现有 Response 形状、
  现有测试、**无 `@panel` 头插件的加载行为**——一个都不能变；
  唯一有意的行为变化是"fetch 拒绝字节" → "接受"（docs 标注自某版本起）。
- **SSRF/超时/脱敏对二进制路径同样生效**：`body_b64` 不许成为绕过
  `ensure_outbound_url_allowed` 的口子（实现位置天然保证，验收确认）。
- **门禁默认关闭**：所有门槛字段留空 = 行为与现在完全一致。
- 文档与实现同步改：docs 行号即契约，改实现不改文档 = 没改。
