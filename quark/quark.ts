/**
 * 夸克网盘每日签到 —— 单文件插件。
 *
 * 逻辑来自 asunajs/asign 的 @asunajs/quark / @asign/quark-core（MIT）：
 * 先 GET info 取签到状态，未签到时 POST sign；只保留签到所需的最小请求，
 * 不再依赖 axios / dayjs / 青龙 / 配置文件。
 *
 * 这个文件是 TypeScript。商城安装时会用 Bun 或 Node 22.13+ 转成 quark.js，
 * 运行期只加载 JavaScript；也可以手动 `bun build` 后放进 plugins/js/。
 */

import {
  config,
  http_fetch,
  log,
  register_cron,
  start,
  success,
} from 'host-api';

type Auth = { kps: string; sign: string; vcode: string };
type HttpResult = {
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  error?: string;
};

const API_BASE = 'https://drive-m.quark.cn/1/clouddrive/capacity/growth';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 Edg/122.0.0.0';

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
 * 面板的「插件列表 → 配置」会把 config.json 渲染成表单；`url` 一项就够，
 * 不需要用户拆 query。token 不打印、不拼进错误文本。
 */
function readAuth(): Auth {
  let cfg: any;
  try {
    cfg = config();
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
  } catch {
    // 不要把 endpoint 拼进错误里：query 里有 sign / vcode。
    throw new Error('请求夸克接口失败（网络错误或超时），请稍后重试');
  }

  // QuickJS 的 http_fetch 在网络 / HTTP 状态失败时返回 { error }，不是抛异常。
  // 不要把 error 或 endpoint 原样拼进日志：endpoint 的 query 里有 sign/vcode。
  const netError = text(res.error);
  if (netError) {
    if (/\b401\b|\b403\b/.test(netError)) {
      throw new Error('夸克登录已失效，请重新抓包并更新插件配置里的 url');
    }
    throw new Error('请求夸克接口失败（网络错误或超时），请稍后重试');
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

function run(): void {
  start('夸克签到开始');
  const auth = readAuth();

  const info = request(auth, 'info');
  if (Number(info.code) !== 0) {
    throw new Error(`获取签到信息失败：${text(info.message) || info.code}`);
  }

  const cap = info.data && info.data.cap_sign;
  if (!cap) throw new Error('夸克没有返回签到状态，链接可能不完整或已失效');

  const progress = Number(cap.sign_progress) || 0;
  const target = Number(cap.sign_target) || 0;
  const progressText = target > 0 ? `${progress}/${target}` : String(progress);

  if (cap.sign_daily) {
    success(`今日已签到：${rewardName(cap, progress)}，连签 ${progressText}`);
    return;
  }

  const signed = request(auth, 'sign');
  const code = Number(signed.code);
  if (code === 44210) {
    log('info', '今日已签到（夸克返回 44210）');
    return;
  }
  if (code !== 0) {
    throw new Error(`签到失败：${text(signed.message) || code}`);
  }

  const reward = signed.data && signed.data.sign_daily_reward;
  success(`签到成功，获得 ${megabytes(reward)}；连签 ${progress + 1}/${target || progress + 1}`);
}

register_cron('签到', '0 8 * * *', run, {
  summary: '夸克网盘每日签到',
});
