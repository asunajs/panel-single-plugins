# panel-single-plugins

专门放 **单文件插件** 的仓库：每个目录一个入口文件（`.js` / `.ts`），外加一个 README。

```text
quark/
├── quark.ts      # 插件入口，安装时转成 quark.js
└── README.md     # 配置与使用说明
```

## 目录

| 插件 | 文件 | 说明 |
|---|---|---|
| `quark` | [`quark/quark.ts`](quark/quark.ts) | 夸克网盘每日签到（单账号） |
| `yangshipin` | [`yangshipin/yangshipin.ts`](yangshipin/yangshipin.ts) | 央视频短信登录 + 一键积分任务（引擎差异见其 README） |

## 为什么单文件

- 面板的插件扫描器只认入口 `.js`；单文件插件最容易审阅、对比和覆盖安装。
- `.ts` 是**本仓源码**形态；0.4 面板不带转译，进目录前要构建成 `.js`（见上面「资产必须是 0.4 形状」）。
- 一个目录只放一个插件入口；需要拆模块的插件不放这里。
- 每个目录的 README 说明配置项、抓包方式和已知限制。

> ⚠ "必须单文件"是**商城 `type: file` 当前的形态**，不是永远的天条：
> 协议类插件内联后体积大（yangshipin 32 KB），可审阅性会反转。
> 已向面板提了 `type: dir` 多文件工程的反向需求
> （见 [`panel-requests/PANEL-TODOS.md`](panel-requests/PANEL-TODOS.md) §6）；面板支持后本仓会收多文件插件。

## panel-requests/ —— 给面板仓的反向需求

宿主能力补齐清单与工作会话提示词放这里（[`panel-requests/`](panel-requests/)），
不放在插件目录：插件面向用户，宿主诉求面向面板维护者，两类读者分开。

## 官方货架（面板 0.4 的插件商店读这一份）

仓库根目录的 [`catalog.json`](catalog.json) **就是官方插件目录**：面板 0.4 的商店插件
（`asunajs/panel-store`）默认读它

```text
https://raw.githubusercontent.com/asunajs/panel-single-plugins/main/catalog.json
```

放在这里而不是面板仓：目录是「有哪些插件」这件事，跟插件源码同一个仓才改得动；
面板仓只管「怎么装」的能力（`POST /api/plugins/install` + `panel plugin install`）。详见
[面板仓 `docs/store.md`](https://github.com/asunajs/panel/blob/main/docs/store.md)。

### 收一条之前：资产必须是 **0.4 形状**

    <name>.js             ← 顶层，名字就是插件名
    <name>.webui/…        ← 可选，界面目录，与 .js 并列
    <name>.panel.json     ← 可选，清单

**不能**是 0.3 那种 `js/<name>.js` + `<name>/index.html`：装进去只会得到
`plugins/js/<name>.js`，面板按 `plugins/*.js` 扫，一个都不会被加载。

一条长这样：

```json
{
  "id": "quark", "name": "夸克网盘签到", "summary": "每日签到（单账号）",
  "tags": ["夸克", "签到"], "provides": ["quark"],
  "type": "file", "repo": "asunajs/panel-single-plugins",
  "path": "quark/quark.js", "ref": "main"
}
```

三条硬规矩：`provides` 要写全（一个包可能带几个插件，商店靠它判断「已装」）；
能给 `sha256` 就给（写了就必须对上，否则一个字节都不写）；`type: file` **只认 `.js`**。

改完这份 JSON 不用发面板版本，商店点「刷新目录」就重取（进程内缓存 15 分钟）。

> ⚠ 现在目录里这条 `quark` 还是 `.ts`：0.4 面板**不带 TypeScript 转译**（老面板内置 OXC）。
> 商店点它会明确拒绝并说明原因，不会静默装错。要进 0.4 的目录，先在本仓把它构建成
> `quark/quark.js`（`panel plugin check` 可验），再把 `path` 改过去。

## 安装（0.4）

商店里找到条目点「安装」；装好后点插件卡片的「配置」填参数，再去「任务」里跑或调时间。
手动路径也行：`panel plugin install <文件.js|目录|url>`（CLI 不加载插件，装完到界面点「重载」）。

## 约定

- 插件名 = 文件名（去掉 `.js`）；目录里的 `provides` 要和它对得上。
- 不在仓库里放 token、cookie、抓包 URL 或 `config.json`。
- 插件里只用 `host-api`，保证 QuickJS / Node / Bun 三个引擎行为一致。
- 每个插件一个 README；发现配置项变化时同步更新 README。

## License

MIT。各插件目录的 README 会注明是否改编自其他项目。
