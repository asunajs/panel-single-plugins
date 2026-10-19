# 夸克网盘签到（单文件插件）

从 [`asunajs/asign`](https://github.com/catlair/asign) 的 `@asunajs/quark` /
`@asign/quark-core` 抽出来的最小签到逻辑：

- 只用面板的 `host-api`，不依赖 axios / dayjs / 青龙 / 本地 `asign.json`；
- 配置直接从面板「插件列表 → 配置」读，改完下一次任务生效，不需要重载；
- 默认每天 08:00 签到，可在面板的「插件任务」里改运行时间；
- 单账号；不发送推送通知。

## 安装

在面板「插件列表 → 插件商城」里安装 `夸克网盘签到`。源文件是 `quark.ts`，
商城会用 Bun 或 Node 22.13+ 转成 `quark.js` 再落盘；运行期只加载 JavaScript。

手动安装：

```bash
# 需要 Bun 或 Node 22.13+
bun build quark.ts --outfile quark.js --target=node --format=esm --external host-api
# 把 quark.js 放到 <PLUGINS_DIR>/js/quark.js
```

## 配置

装好后打开「插件列表 → 夸克网盘签到 → 配置」：

1. 点「+ 添加配置项」；
2. key 填 `url`，类型选「文本」，值粘贴抓包得到的完整签到链接；
3. 保存。

也可以切到「JSON」页直接写：

```json
{
  "url": "https://drive-m.quark.cn/1/clouddrive/capacity/growth/info?__t=...&sign_cyclic=true&kps=...&sign=...&vcode=..."
}
```

链接里必须同时有 `kps`、`sign`、`vcode`。也可以不加 `url`，分别添加
`kps`、`sign`、`vcode` 三个文本配置项。

配置保存在插件的 `config.json`（`PLUGIN_DATA_DIR/quark/config.json`，面板以
`0600` 写入），不会进插件源码目录，覆盖安装也不会丢。不要把链接贴到
issue、日志或仓库里。

### 怎么拿链接

按 [`asign` 的夸克文档](https://github.com/catlair/asign/blob/suguha/docs/src/content/docs/reference/quark.mdx)：

- 用夸克 App / PC 客户端（**不要用网页端**）抓包；
- 找 `drive-m.quark.cn/1/clouddrive/capacity/growth/info` 请求；
- 复制完整 URL，或从请求头取 `x-u-kps-wg`、`x-u-sign-wg`、`x-u-vcode`；
- 浏览器直接访问该 URL 能返回签到信息，才说明没有过期。

链接会过期（重新登录 / 换设备 / 长时间后）。签到报“登录已失效”时重新抓一次，
更新配置即可。

## 任务

插件加载后会自动注册一条插件任务「签到」，默认：

```text
0 8 * * *
```

在「插件任务」里可以改时间、暂停，或点「运行一次」立即验证配置。
任务声明了 30 秒预算并独占一条执行线程：两次夸克请求都是同步 HTTP，不能
让同线程的其它插件跟着等。

## 实现边界

- 只调用签到需要的两个接口：`capacity/growth/info` 和 `capacity/growth/sign`；
- 不登录、不读写网盘文件、不上传任何数据；
- 不把 `sign` / `vcode` 写进日志或错误文本；
- 接口失败会让任务失败（面板记录 `last_error`、触发熔断），不会静默成功。

## License

MIT。签到流程改编自 [`asunajs/asign`](https://github.com/catlair/asign)（MIT），
原项目版权归 asunajs 所有。
