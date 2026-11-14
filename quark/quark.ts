/**
 * 夸克网盘每日签到 —— 单文件插件（面板 0.4 / `panel:host` 契约）。
 *
 * 逻辑来自 asunajs/asign 的 @asunajs/quark / @asign/quark-core（MIT）：
 * 先 GET info 取签到状态，未签到时 POST sign；只保留签到所需的最小请求，
 * 不再依赖 axios / dayjs / 青龙 / 配置文件。
 *
 * 这个文件是 TypeScript，但**没有类型之外的构建步骤**：面板安装时会用内置 OXC
 * 擦掉类型、落成 `quark.js` 再加载。所以这里可以放心写 type/interface。
 *
 * # 0.3 → 0.4 契约迁移（v0.2.0）
 *
 * 老版用的是老面板（QuickJS）的 `host-api`，在 0.4 里加载期就会报
 * `Error resolving module 'host-api'`。逐条对应关系：
 *
 *   · `import {...} from 'host-api'`      → `from 'panel:host'`
 *   · `config()`                          → `self_config()`（异步，读本插件自己的配置）
 *   · `http_fetch(url, opts)`             → 同名，但**失败是抛错**（0.3 才是回 `{error}`）
 *   · `log('info', msg)`                  → `info(msg)`
 *   · `start(msg)`                        → `info(msg)`
 *   · `success(msg)`                      → `info(msg)` + `notify(标题, msg)`
 *   · `register_cron(name, cron, run, {})`→ 0.4 的 `register_cron` **只登记调度、不绑函数**；
 *                                           handler 靠同名 `register_handler` 绑上，顺序先 cron 后 handler。
 */

import {
  http_fetch,
  info,
  notify,
  register_cron,
  register_handler,
  self_config,
} from 'panel:host';

const VERSION = '0.2.0';

type Auth = { kps: string; sign: string; vcode: string };
type HttpResult = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  body_error?: string | null;
};

const API_BASE = 'https://drive-m.quark.cn/1/clouddrive/capacity/growth';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';
/** 手动运行 / 定时运行的预算：这条链路最多两三个请求，60 秒足够，别占着线程。 */
const BUDGET_MS = 60_000;
/** 任务名：`register_cron` 与 `register_handler` 必须用同一个名字。 */
const JOB = '签到';

function text(value: unknown): string {
  return value === null || value === undefined ? '' : String(value).trim();
}

function decodePart(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    return value;
  }
}

/** 从抓包 URL 的 query 里取 kps / sign / vcode；不依赖 URL 全局对象。 */
function parseQuery(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const at = raw.indexOf('?');
  if (at < 0) return out;
  const query = raw.slice(at + 1).split('#')[0];
  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = decodePart(eq < 0 ? part : part.slice(0, eq));
    const value = decodePart(eq < 0 ? '' : part.slice(eq + 1));
    if (key) out[key] = value;
  }
  return out;
}

/**
 * 配置优先读 `url`（抓包得到的完整 info 链接），也兼容分别填三个值。
 *
 * 面板的「插件列表 → 配置」会把 config.json 渲染成表单（字段见 quark.panel.json）；
 * `url` 一项就够，不需要用户拆 query。token 不打印、不拼进错误文本。
 */
async function readAuth(): Promise<Auth> {
  let cfg: any;
  try {
    cfg = await self_config();
  } catch (error: any) {
    throw new Error('读取插件配置失败：' + text(error && error.message ? error.message : error));
  }
  cfg = cfg || {};

  const url = text(cfg.url);
  const query = url ? parseQuery(url) : {};
  const kps = text(cfg.kps) || text(query.kps);
  const sign = text(cfg.sign) || text(query.sign);
  const vcode = text(cfg.vcode) || text(query.vcode);

  if (!kps || !sign || !vcode) {
    throw new Error(
      '还没有配置夸克签到链接。打开「插件列表 → 配置」，添加一项 url，' +
        '把抓包得到的 drive-m.quark.cn/.../info?... 链接粘进去；' +
        '也可以分别填写 kps / sign / vcode。',
    );
  }
  return { kps, sign, vcode };
}

function queryString(auth: Auth): string {
  return (
    `__t=${Date.now()}&sign_cyclic=true&fr=android` +
    `&kps=${encodeURIComponent(auth.kps)}` +
    `&sign=${encodeURIComponent(auth.sign)}` +
    `&vcode=${encodeURIComponent(auth.vcode)}` +
    '&pr=ucpro&uc_param_str='
  );
}

function request(auth: Auth, action: 'info' | 'sign'): any {
  const endpoint = `${API_BASE}/${action}?${queryString(auth)}`;
  const options: any = {
    method: action === 'sign' ? 'POST' : 'GET',
    headers: {
      'content-type': 'application/json',
      'user-agent': USER_AGENT,
    },
    timeout_ms: 10000,
  };
  if (action === 'sign') options.body = JSON.stringify({ sign_cyclic: true });

  let res: HttpResult;
  try {
    res = http_fetch(endpoint, options);
  } catch (e: any) {
    // 0.4 的 http_fetch 失败是**抛错**（0.3 才回 `{error}`）。
    // 不要把 endpoint 拼进错误里：query 里有 sign / vcode。
    const msg = text(e && e.message ? e.message : e);
    const statusInError = msg.match(/http status:\s*(\d+)/i);
    if (statusInError) {
      const httpStatus = Number(statusInError[1]);
      if (httpStatus === 401 || httpStatus === 403) {
        throw new Error('夸克登录已失效，请重新抓包并更新插件配置里的 url');
      }
      throw new Error(`夸克接口请求失败（HTTP ${httpStatus}）`);
    }
    throw new Error('请求夸克接口失败（网络错误或超时），请稍后重试');
  }

  // 传输层读正文失败就别把半个响应喂给业务层
  if (res.body_error) {
    throw new Error('读取夸克响应失败：' + text(res.body_error));
  }

  const status = Number(res.status) || 0;
  let data: any = null;
  try {
    data = JSON.parse(res.body || '');
  } catch {
    data = null;
  }

  if (status === 401 || (data && Number(data.code) === 401)) {
    throw new Error('夸克登录已失效，请重新抓包并更新插件配置里的 url');
  }
  if (!data || typeof data !== 'object') {
    throw new Error(`夸克接口返回了非 JSON 内容（HTTP ${status || '未知'}）`);
  }
  if (status < 200 || status >= 300) {
    const message = text(data.message) || `HTTP ${status}`;
    throw new Error(`夸克接口请求失败：${message}`);
  }
  return data;
}

function rewardName(cap: any, progress: number): string {
  const rewards = cap && Array.isArray(cap.sign_rewards) ? cap.sign_rewards : [];
  const item = rewards[progress - 1];
  return item && item.name ? String(item.name) : '今日奖励';
}

function megabytes(value: any): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '奖励已到账';
  return `${(n / 1048576).toFixed(2)} MB`;
}

async function run(): Promise<void> {
  info(`夸克签到开始（v${VERSION}）`);
  const auth = await readAuth();

  const data = request(auth, 'info');
  if (Number(data.code) !== 0) {
    throw new Error(`获取签到信息失败：${text(data.message) || data.code}`);
  }

  const cap = data.data && data.data.cap_sign;
  if (!cap) throw new Error('夸克没有返回签到状态，链接可能不完整或已失效');

  const progress = Number(cap.sign_progress) || 0;
  const target = Number(cap.sign_target) || 0;
  const progressText = target > 0 ? `${progress}/${target}` : String(progress);

  if (cap.sign_daily) {
    const msg = `今日已签到：${rewardName(cap, progress)}，连签 ${progressText}`;
    info(msg);
    await notify('夸克签到', msg);
    return;
  }

  const signed = request(auth, 'sign');
  const code = Number(signed.code);
  if (code === 44210) {
    info('今日已签到（夸克返回 44210）');
    return;
  }
  if (code !== 0) {
    throw new Error(`签到失败：${text(signed.message) || code}`);
  }

  const reward = signed.data && signed.data.sign_daily_reward;
  const msg = `签到成功，获得 ${megabytes(reward)}；连签 ${progress + 1}/${target || progress + 1}`;
  info(msg);
  await notify('夸克签到', msg);
}

// 0.4 的注册形状：`register_cron` 只登记调度（名字 + cron + 预算），
// 真正的函数靠**同名** `register_handler` 绑上。顺序：先 cron，后 handler。
register_cron(JOB, '0 8 * * *', BUDGET_MS);
register_handler(JOB, run, BUDGET_MS);
