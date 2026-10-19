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

## 为什么单文件

- 面板的插件扫描器只认入口 `.js`；单文件插件最容易审阅、对比和覆盖安装。
- `.ts` 由面板商城在安装时转成 `.js`，运行期不引入 TypeScript、npm 依赖或 tsconfig。
- 一个目录只放一个插件入口；需要拆模块的插件不放这里。
- 每个目录的 README 说明配置项、抓包方式和已知限制。

## 作为商城目录

仓库根目录的 [`catalog.json`](catalog.json) 可以直接作为面板的 `PANEL_MARKET_URL`：

```bash
PANEL_MARKET_URL=https://raw.githubusercontent.com/asunajs/panel-single-plugins/main/catalog.json
```

也可以在面板的官方目录里收录本仓库的条目。目录格式见
[`rust-plugin-panel` 的插件商城文档](https://github.com/asunajs/panel/blob/main/docs/market.md)。

## 安装

面板「插件列表 → 插件商城」里找到条目安装；装好后点插件卡片的「配置」填参数，
再在「插件任务」里运行或调整时间。

单文件插件也可以手动下载后放进 `plugins/js/`；`.ts` 必须先转成 `.js`（商城会自动做）。

## 约定

- 插件名 = 文件名去掉扩展名；`quark.ts` 安装为 `quark.js`。
- 不在仓库里放 token、cookie、抓包 URL 或 `config.json`。
- 插件里只用 `host-api`，保证 QuickJS / Node / Bun 三个引擎行为一致。
- 每个插件一个 README；发现配置项变化时同步更新 README。

## License

MIT。各插件目录的 README 会注明是否改编自其他项目。
