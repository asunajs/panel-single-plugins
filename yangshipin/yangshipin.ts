/* @panel { "min": "0.3.0" } */
/**
 * 央视频（yangshipin）短信登录 + 积分任务 —— 单文件面板插件。
 *
 * 安装时由面板把 .ts 转成 .js（OXC / bun / node 均可），运行期只加载 JavaScript。
 * **一份文件、三个引擎、二进制路径零分支**：面板 0.3.0 起 QuickJS 的 fetch 也吃
 * Uint8Array、也有 node:zlib，所以发码/登录/结算的代码与 Node 分支逐字相同。
 *
 * 文件头的 @panel 是最低面板版本声明：老面板会在**加载时**拒载并给出升级链接，
 * 而不是等第一次发码才炸（0.2.x 的 QuickJS 既没有 zlib，也发不出字节）。
 *
 * 协议证据链（逐字节对拍 + 真机验证）：
 *   mcloud-capture/cctv-video/re/14-jacc-envelope-and-sms-login.md
 *   §3 信封（尾字节 0x03） §5 发码字段 §12.11 TaskComplete 尾字节=任务 id
 *
 * 用户数据落 <PLUGIN_DATA_DIR>/yangshipin/（QuickJS 围栏内 / Node 的 CWD），
 * 永远不写进插件源码目录 —— 面板会把那里当静态站点服务出去。
 */

import {
  config,
  http_fetch,
  log,
  register_cron,
  register_handler,
  register_nav,
  register_route,
  start,
  success,
  worker_hint,
} from 'host-api';
// 三个引擎都有 node:zlib（面板 0.3.0 起 QuickJS 也内置），所以是静态 import。
import fs from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

// ======================================================================
// 引擎探测：已不需要（二进制 fetch / node:zlib / node:fs 三引擎同形）。
// 留一个布尔值只为 UI 显示当前引擎名。
// ======================================================================

const IS_NODE = Boolean((globalThis as any).process?.versions?.node || (globalThis as any).process?.versions?.bun);

type HttpResult = { status?: number; headers?: Record<string, string>; body?: Uint8Array; error?: string };
type HttpRequest = { method: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number };
type HttpClient = (url: string, req: HttpRequest) => HttpResult | Promise<HttpResult>;

function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function errText(e: unknown): string {
  return text(e && typeof e === 'object' && 'message' in (e as any) ? (e as any).message : e);
}

/**
 * 等待。⚠ `sleep` 是**面板给 QuickJS 注入的全局**，Node/Bun 没有（node-compat.md：sleep ✅/❌），
 * 而 QuickJS 的 setTimeout 回调是同步执行的、等不了 IO。所以两边各走各的，插件里只认 wait()。
 */
function wait(ms: number): Promise<void> {
  const hostSleep = (globalThis as any).sleep;
  if (typeof hostSleep === 'function') return hostSleep(ms);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 任务之间的间隔：默认 35–65 秒随机，`config().task_gap_ms` 可覆盖（钳到 [30s, 300s]）。
 * 见下方 taskGapMs 里的说明 —— 真人做一个任务就是几十秒起步。
 */
function taskGapMs(): number {
  // 默认 35–65 秒。低于 30 秒基本等于明说「我是脚本」：真人做完一个任务
  // （看视频 / 点赞 / 分享）至少几十秒，7 个包在十几秒内发完是最典型的机器指纹。
  // 服务端也可能对「间隔恒定」单独打标，所以这里必须是随机区间而不是固定值。
  let base = 35000;
  try {
    const v = Number((config() as any)?.task_gap_ms);
    if (Number.isFinite(v) && v > 0) base = Math.min(Math.max(v, 30000), 300000);
  } catch { /* 读配置失败用默认值 */ }
  return base + Math.floor(Math.random() * 30000);
}

// 引擎探测已经不需要了：二进制 fetch / node:zlib / node:fs 三个引擎都有等价实现。
// （唯一的历史差异是 QuickJS 的 fs 是面板注入的围栏版本 —— 现在也走 node:fs。）

// ======================================================================
// gzip —— 与 Node 同一条路径（面板 0.3.0 起 QuickJS 也有 node:zlib）
// ======================================================================

function gzipMember(data: Uint8Array): Uint8Array {
  // mtime 恒为 0：gzip 头里那两个时间字节参与抓包对拍，不能带当前时间。
  // Node 的 gzipSync 没有 mtime 选项（它本来就是 0），面板侧也一样 —— 两边同义。
  return new Uint8Array(gzipSync(data, { mtime: 0 } as any));
}

function gunzipMember(data: Uint8Array): Uint8Array {
  return new Uint8Array(gunzipSync(data));
}

// ======================================================================
// JCE 变体编解码（央视频 jacc 通道，证据见 re/14 §4）
// ======================================================================

function writeTag(out: number[], tag: number, ty: number): void {
  if (tag < 15) out.push((tag << 4) | ty);
  else { out.push((15 << 4) | ty); out.push(tag); }
}

function writeInt(out: number[], tag: number, value: number): void {
  const v = Math.trunc(value);
  if (v === 0) { writeTag(out, tag, 11); return; }
  if (v >= -128 && v <= 127) { writeTag(out, tag, 0); out.push(v & 0xff); }
  else if (v >= -32768 && v <= 32767) { writeTag(out, tag, 1); out.push((v >> 8) & 0xff, v & 0xff); }
  else {
    writeTag(out, tag, 2);
    out.push((v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff);
  }
}

function writeStr(out: number[], tag: number, value: string): void {
  const b = new TextEncoder().encode(value);
  if (b.length > 255) throw new Error(`jce str 过长（${b.length} > 255）`);
  writeTag(out, tag, 6);
  out.push(b.length);
  for (const x of b) out.push(x);
}

function writeEmptyList(out: number[], tag: number): void {
  writeTag(out, tag, 12);
}

function writeStructBegin(out: number[], tag: number): void {
  writeTag(out, tag, 10);
}

const STRUCT_END = 0x0b;

// ⚠ 这个函数在 0.1.0 的单文件版里**丢了**（只有调用没有定义）—— 于是发码/登录/
// 结算这条二进制路径在任何引擎上都是 ReferenceError，只有 H5 那几个能跑。
// 对拍测试（scripts/… 或面板里的 mock）第一次真正跑到它。
function writeStructEnd(out: number[]): void {
  out.push(STRUCT_END);
}

/** 窄读取：按 tag 找最近的 str / int（不解析扩展类型，跳过即可）。 */
function readStrByTag(buf: Uint8Array, wantTag: number): string | null {
  let i = 0; let last: string | null = null; const n = buf.length;
  while (i < n) {
    let tag = buf[i] >> 4; const ty = buf[i] & 0x0f; i += 1;
    if (tag === 15) { if (i >= n) break; tag = buf[i]; i += 1; }
    if (ty === 11 || ty === 12 || ty === 10) continue;
    if (ty === 0) { i += 1; continue; }
    if (ty === 1) { i += 2; continue; }
    if (ty === 2) { i += 4; continue; }
    if (ty === 3) { i += 8; continue; }
    if (ty === 4) { i += 4; continue; }
    if (ty === 5) { i += 8; continue; }
    if (ty === 6) {
      if (i >= n) break;
      const len = buf[i]; i += 1;
      const s = new TextDecoder('utf-8').decode(buf.subarray(i, i + len)); i += len;
      if (tag === wantTag) last = s;
      continue;
    }
    if (ty === 13) { i += 4; continue; }
    if (ty === 8 || ty === 9 || ty === 14 || ty === 15) {
      if (i >= n) break;
      const len = buf[i]; i += 1 + len; continue;
    }
    break;
  }
  return last;
}

function readIntByTag(buf: Uint8Array, wantTag: number): number | null {
  let i = 0; let last: number | null = null; const n = buf.length;
  while (i < n) {
    let tag = buf[i] >> 4; const ty = buf[i] & 0x0f; i += 1;
    if (tag === 15) { if (i >= n) break; tag = buf[i]; i += 1; }
    if (ty === 11 || ty === 12 || ty === 10) continue;
    if (ty === 0) { const v = buf[i]; i += 1; if (tag === wantTag) last = v > 127 ? v - 256 : v; continue; }
    if (ty === 1) { const v = (buf[i] << 8) | buf[i + 1]; i += 2; if (tag === wantTag) last = v > 32767 ? v - 65536 : v; continue; }
    if (ty === 2) { const v = ((buf[i] << 24) | (buf[i + 1] << 16) | (buf[i + 2] << 8) | buf[i + 3]) >>> 0; i += 4; if (tag === wantTag) last = v | 0; continue; }
    if (ty === 3) { i += 8; continue; }
    if (ty === 4) { i += 4; continue; }
    if (ty === 5) { i += 8; continue; }
    if (ty === 6) { if (i >= n) break; const len = buf[i]; i += 1 + len; continue; }
    if (ty === 13) { i += 4; continue; }
    if (ty === 8 || ty === 9 || ty === 14 || ty === 15) { if (i >= n) break; const len = buf[i]; i += 1 + len; continue; }
    break;
  }
  return last;
}

// ======================================================================
// 信封（re/14 §3）：[24B 头][63B guid 段][BE16][gzip 内层][0x03]
// ======================================================================

const JACC_HOST = 'https://jacc.ysp.cctv.cn/';

const CMD = {
  GetCode: 24680,
  NewLogin: 59986,
  AccountUserInfo: 24802,
  LikeAction: 24803,
  TaskComplete: 25042,
} as const;

export type DeviceProfile = {
  guid: string; qimei36: string; idfv: string; clientKey: string;
  deviceModel: string; screenWidth: number; screenHeight: number;
  sysver: string; versionName: string; versionCode: string;
};

/** 设备档：抓包样本形状。guid/qimei/idfv 建议在配置里随机化一次后固定。 */
export const DEFAULT_DEVICE: DeviceProfile = {
  guid: 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6',
  qimei36: 'aabbccdd1122334455667788990011223344',
  idfv: 'AAAAAAAA-0803-5815-B990-B0D68B237D8F',
  clientKey: '1111110a0a6d254e0b0818918eaf2ee61a45001011ba07',
  deviceModel: 'iPad Pro (12.9 inch) 3G',
  screenWidth: 1536,
  screenHeight: 2048,
  sysver: '26.6',
  versionName: '3.5.3.23867',
  versionCode: '23867',
};

function newRequestUuid(): string {
  // 全局 crypto 三个引擎都有（面板 0.3.0 起 QuickJS 也是 WebCrypto 形状）
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID().toUpperCase();
  const b = new Uint8Array(16); c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x: number) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`.toUpperCase();
}

function encodeQua(out: number[], dev: DeviceProfile, requestUuid: string): void {
  writeStructBegin(out, 2);
  writeStr(out, 0, dev.versionName);
  writeStr(out, 1, dev.versionCode);
  writeInt(out, 2, dev.screenWidth);
  writeInt(out, 3, dev.screenHeight);
  writeInt(out, 4, 5); // platform = ios
  writeStr(out, 5, `sysver=ios${dev.sysver}&device=iPad&modify_time=&lang=zh_CN`);
  writeInt(out, 6, 1);
  writeEmptyList(out, 7);
  writeEmptyList(out, 8);
  writeStr(out, 9, '50001');
  writeStr(out, 10, '');
  writeStr(out, 11, '');
  writeStr(out, 12, '');
  writeStr(out, 13, dev.clientKey);
  writeStr(out, 14, '');
  writeStructBegin(out, 15);
  writeEmptyList(out, 0);
  writeEmptyList(out, 1);
  writeStr(out, 2, '');
  writeStructEnd(out);
  writeStr(out, 16, requestUuid);
  writeStr(out, 17, '');
  writeStr(out, 18, '');
  writeStr(out, 20, dev.idfv);
  writeStr(out, 21, dev.deviceModel);
  writeInt(out, 22, 3);
  writeEmptyList(out, 23);
  writeInt(out, 24, 1);
  writeEmptyList(out, 25);
  writeEmptyList(out, 26);
  writeStr(out, 27, '');
  writeStr(out, 28, '');
  writeStr(out, 29, dev.qimei36);
  writeStructEnd(out);
}

/** 内层（gzip 前）：tag2-str(2B LE 自含) 包住 [QMF 13B][tag0 struct 头][业务体] */
function encodeInner(opts: {
  cmd: number; requestId: number; requestUuid: string; device: DeviceProfile;
  body: (out: number[]) => void;
}): Uint8Array {
  const out: number[] = [];
  out.push(0x0a);
  writeInt(out, 0, opts.requestId);
  writeInt(out, 1, opts.cmd);
  encodeQua(out, opts.device, opts.requestUuid);
  writeStr(out, 3, '1200013');
  writeStr(out, 4, opts.device.guid);
  writeEmptyList(out, 8);
  writeEmptyList(out, 9);
  writeEmptyList(out, 10);
  writeStructBegin(out, 12);
  writeInt(out, 0, 1);
  writeStructEnd(out);
  writeStructEnd(out);
  opts.body(out);
  out.push(0x2a, 0x0c, 0x0b, 0x28); // 尾块（抓包常量）

  const payload = out.slice();
  const inner: number[] = [];
  inner.push(0x26);
  const total = 3 + 13 + payload.length;
  inner.push(total & 0xff, (total >> 8) & 0xff);
  inner.push(0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00);
  for (const x of payload) inner.push(x);
  return new Uint8Array(inner);
}

/** 外层信封（HTTP body）。⚠ 尾字节 0x03 不能省，缺了服务端 500。 */
function encodeOuter(opts: { cmd: number; inner: Uint8Array; device: DeviceProfile }): Uint8Array {
  const head: number[] = [
    0x13, 0x00, 0x00, 0x00, 0x00, 0x00, 0x02, 0xff, 0x01,
    (opts.cmd >> 8) & 0xff, opts.cmd & 0xff,
    0, 0, 0, 0, 0, 0, 0, 0, 0,
    0x35, 0x00, 0x00, 0x02,
  ];
  const seg: number[] = [0x13, 0x00, 0x00, 0x27, 0x1c, 0, 0, 0, 0, 0, 0, 0, 0];
  for (const c of new TextEncoder().encode(opts.device.guid)) seg.push(c);
  seg.push(0x02, 0x00, 0x00, 0x5d, 0x3b);
  for (let i = 0; i < 13; i++) seg.push(0);
  seg.push((opts.inner.length >> 8) & 0xff, opts.inner.length & 0xff);

  const gz = gzipMember(opts.inner);
  const totalLen = head.length + seg.length + gz.length + 1;
  head[3] = (totalLen >> 8) & 0xff;
  head[4] = totalLen & 0xff;

  const out = new Uint8Array(totalLen);
  let p = 0;
  for (const x of head) out[p++] = x;
  for (const x of seg) out[p++] = x;
  out.set(gz, p);
  out[p + gz.length] = 0x03;
  return out;
}

/** 从外层响应解出内层（兼容带/不带尾字节两种排布）。 */
function unwrapResponse(outer: Uint8Array): Uint8Array {
  let at = -1;
  for (let i = 60; i + 1 < outer.length; i++) {
    if (outer[i] === 0x1f && outer[i + 1] === 0x8b) { at = i; break; }
  }
  if (at < 0) throw new Error('响应里没有 gzip 体');
  const rest = outer.subarray(at);
  for (const tail of [0, 1]) {
    if (rest.length <= 18 + tail) continue;
    try { return gunzipMember(rest.subarray(0, rest.length - tail)); } catch { /* 换下一种 */ }
  }
  throw new Error('响应 gzip 解包失败');
}

// ======================================================================
// 传输：三个引擎都是 fetch + Uint8Array（面板 0.3.0 起 QuickJS 也吃字节）
// ======================================================================

const binaryHttp: HttpClient = async (url, req) => {
  try {
    const res = await fetch(url, { method: req.method, headers: req.headers, body: req.body });
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers) as Record<string, string>,
      body: new Uint8Array(await res.arrayBuffer()),
    };
  } catch (e) {
    return { status: 0, error: errText(e) };
  }
};

// ======================================================================
// 脱敏骨架（base64，gzip 前的内层）。来源：reference/packets/*.bin（已脱敏）
// ======================================================================

/** NewLogin(59986) 请求内层 551B。占位：+8613800138000 / 246810 */
const SKEL_NEWLOGIN =
  'JicCAAABAAAAAAAAAAAAAAoANhIAAOpSKgYLMy41LjMuMjM4NjcWBTIzODY3IQYAMQgAQAVWMnN5' +
  'c3Zlcj1pb3MyNi42JmRldmljZT1pUGFkJm1vZGlmeV90aW1lPSZsYW5nPXpoX0NOYAF8jJYFNTAw' +
  'MDGmALYAxgDWLjExMTExMTBhMGE2ZDI1NGUwYjA4MTg5MThlYWYyZWU2MWE0NTAwMTAxMWJhMDfm' +
  'APoPDBwmAAv2ECRCQkJCQkJCQi03NTQ3LTQ4REMtOEI4Ri03NzVBNUU3QTQwNzX2EQD2EgD2FCRB' +
  'QUFBQUFBQS0wODAzLTU4MTUtQjk5MC1CMEQ2OEIyMzdEOEb2FRdpUGFkIFBybyAoMTIuOSBpbmNo' +
  'KSAzR/AWA/wX8BgB/Bn8GvYbAPYcAPYdJGFhYmJjY2RkMTEyMjMzNDQ1NTY2Nzc4ODk5MDAxMTIy' +
  'MzM0NAs2BzEyMDAwMTNGIGExYjJjM2Q0ZTVmNmE3YjhjOWQwZTFmMmEzYjRjNWQ2jJysygABCwsd' +
  'AAEAkAkAAQoAaBoGABYOKzg2MTM4MDAxMzgwMDAmADYARgYyNDY4MTBcCwsaAAcWACYgYTFiMmMz' +
  'ZDRlNWY2YTdiOGM5ZDBlMWYyYTNiNGM1ZDY2JEFBQUFBQUFBLTA4MDMtNTgxNS1COTkwLUIwRDY4' +
  'QjIzN0Q4RkYYN19hcHB2ZXJzaW9uXzMuNS4zLjIzODY3CyoMCyg=';

/** AccountUserInfo(24802) 477B。token/vuserid 槽为占位。 */
const SKEL_USERINFO =
  'Jt0BAAABAAAAAAAAAAAAAAoAOxFg4ioGCzMuNS4zLjIzODY3FgUyMzg2NyEGADEIAEAFVjJzeXN2' +
  'ZXI9aW9zMjYuNiZkZXZpY2U9aVBhZCZtb2RpZnlfdGltZT0mbGFuZz16aF9DTmABfIyWBTUwMDAx' +
  'pgC2AMYA1i4xMTExMTEwYTBhNmQyNTRlMGIwODE4OTE4ZWFmMmVlNjFhNDUwMDEwMTFiYTA35gD6' +
  'DwwcJgAL9hAkODE1ODc0MDctQjU0Ny00OEYwLUE0NjctMTRFQTEzODQ3RTk19hEA9hIA9hQkNjY4' +
  'MUU3REItMDgwMy01ODE1LUI5OTAtQjBENjhCMjM3RDhG9hUXaVBhZCBQcm8gKDEyLjkgaW5jaCkg' +
  'M0fwFgP8F/AYAfwZ/Br2GwD2HAD2HSRhYWJiY2NkZDExMjIzMzQ0NTU2Njc3ODg5OTAwMTEyMjMz' +
  'NDQLNgcxMjAwMDEzRiBhMWIyYzNkNGU1ZjZhN2I4YzlkMGUxZjJhM2I0YzVkNlkAAQoGABAJLQAA' +
  'K0FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUE2CTkwMDAwMDAwMUAB' +
  'C3kMjJysygABCwsdAAACBgAqDAso';

/** TaskComplete(25042) 480B。尾部 1d 00 00 04 00 [2a] 的 2a = 任务 id 42（点赞）。 */
const SKEL_TASK =
  'JuABAAABAAAAAAAAAAAAAAoBAJkRYdIqBgszLjUuMy4yMzg2NxYFMjM4NjchBgAxCABABVYyc3lz' +
  'dmVyPWlvczI2LjYmZGV2aWNlPWlQYWQmbW9kaWZ5X3RpbWU9Jmxhbmc9emhfQ05gAXyMlgU1MDAw' +
  'MaYAtgDGANYuMTExMTExMGEwYTZkMjU0ZTBiMDgxODkxOGVhZjJlZTYxYTQ1MDAxMDExYmEwN+YA' +
  '+g8MHCYAC/YQJEI4MjQ1RkFGLTdEODUtNEQ3Mi04RDUyLUZFOEYyQzAyQjExNvYRAPYSAPYUJEFB' +
  'QUFBQUFBLTA4MDMtNTgxNS1COTkwLUIwRDY4QjIzN0Q4RvYVF2lQYWQgUHJvICgxMi45IGluY2gp' +
  'IDNH8BYD/BfwGAH8Gfwa9hsA9hwA9h0kYWFiYmNjZGQxMTIyMzM0NDU1NjY3Nzg4OTkwMDExMjIz' +
  'MzQ0CzYHMTIwMDAxM0YgYTFiMmMzZDRlNWY2YTdiOGM5ZDBlMWYyYTNiNGM1ZDZZAAEKBgAQCS0A' +
  'ACtBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBNgk5MDAwMDAwMDFA' +
  'AQt5DIycrMoAAQsLHQAABAAqFgAqDAso';

/** LikeAction(24803) 501B。尾部带抓包当次的视频 id（重放=再点同一个视频）。 */
const SKEL_LIKE =
  'JvUBAAABAAAAAAAAAAAAAAoBAJsRYOMqBgszLjUuMy4yMzg2NxYFMjM4NjchBgAxCABABVYyc3lz' +
  'dmVyPWlvczI2LjYmZGV2aWNlPWlQYWQmbW9kaWZ5X3RpbWU9Jmxhbmc9emhfQ05gAXyMlgU1MDAw' +
  'MaYAtgDGANYuMTExMTExMGEwYTZkMjU0ZTBiMDgxODkxOGVhZjJlZTYxYTQ1MDAxMDExYmEwN+YA' +
  '+g8MHCYAC/YQJDEzQzhBNTVDLUM4MzYtNDNCMi1BOEE5LUFCRkU4MkNGMUQwQvYRAPYSAPYUJEFB' +
  'QUFBQUFBLTA4MDMtNTgxNS1COTkwLUIwRDY4QjIzN0Q4RvYVF2lQYWQgUHJvICgxMi45IGluY2gp' +
  'IDNH8BYD/BfwGAH8Gfwa9hsA9hwA9h0kYWFiYmNjZGQxMTIyMzM0NDU1NjY3Nzg4OTkwMDExMjIz' +
  'MzQ0CzYHMTIwMDAxM0YgYTFiMmMzZDRlNWY2YTdiOGM5ZDBlMWYyYTNiNGM1ZDZZAAEKBgAQCS0A' +
  'ACtBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBNgk5MDAwMDAwMDFA' +
  'AQt5DIycrMoAAQsLHQAAGQYLbDAwMDA5OGd4cjUQAiYHOTAwMTEwMTwqDAso';

function b64decode(b64: string): Uint8Array {
  const clean = b64.replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(clean, 'base64'));
}

function indexOfSeq(hay: Uint8Array, needle: Uint8Array, from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const enc8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** 骨架 + 等长字段替换（长度字节全部不用动）。 */
function splice(skelB64: string, subs: Array<[string, string]>): Uint8Array {
  const buf = b64decode(skelB64);
  for (const [ph, real] of subs) {
    if (ph.length !== real.length) throw new Error(`占位符长度不一致：${ph.length} vs ${real.length}`);
    let at = indexOfSeq(buf, enc8(ph));
    while (at >= 0) {
      buf.set(enc8(real), at);
      at = indexOfSeq(buf, enc8(ph), at + ph.length);
    }
  }
  return buf;
}

// ======================================================================
// jacc 会话层
// ======================================================================

let requestIdCounter = 1;

async function postOuter(
  cfg: YspConfig, cmd: number, outer: Uint8Array, requestUuid: string, requestId: number,
): Promise<Uint8Array> {
  const res = await binaryHttp(JACC_HOST, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      jcegodid: String(cmd),
      'request-id': requestUuid,
      head_key_traceid: String(100 + (requestId % 900)),
      'user-agent': `CCTVVideo/3.5.3 (iPad; iOS ${cfg.device.sysver}; Scale/2.00)`,
    },
    body: outer,
    timeoutMs: 10000,
  });
  const netError = (res.error || '').trim();
  if (netError) throw new Error(`jacc 请求失败（${netError.slice(0, 60)}）`);
  const status = Number(res.status) || 0;
  if (status !== 200) {
    const hint = cmd === CMD.GetCode
      ? '；发码接口对不可用号码会直接 500（实测），请确认号码是已注册的央视频手机号'
      : cmd === CMD.NewLogin ? '；登录 500 常见于验证码已过期' : '';
    throw new Error(`jacc 返回 HTTP ${status}${hint}`);
  }
  if (!res.body || res.body.length === 0) throw new Error('jacc 返回空 body');
  return res.body;
}

async function postJacc(cfg: YspConfig, cmd: number, body: (out: number[]) => void): Promise<Uint8Array> {
  const requestId = requestIdCounter++;
  const requestUuid = newRequestUuid();
  const inner = encodeInner({ cmd, requestId, requestUuid, device: cfg.device, body });
  const outer = encodeOuter({ cmd, inner, device: cfg.device });
  return postOuter(cfg, cmd, outer, requestUuid, requestId);
}

function normalizePhone(input: string): string {
  const p = text(input);
  if (!p) throw new Error('手机号不能为空');
  const digits = p.replace(/[^0-9]/g, '');
  if (p.startsWith('+')) return `+${digits}`;
  if (digits.length === 11) return `+86${digits}`;
  throw new Error(`手机号形状不对：应为 11 位号码（收到 ${p.length} 个字符）`);
}

// ======================================================================
// 业务：发码 / 登录 / 验活 / 点赞 / 任务
// ======================================================================

async function getCode(cfg: YspConfig): Promise<{ ok: boolean; message: string }> {
  const phone = normalizePhone(cfg.phone);
  const outer = await postJacc(cfg, CMD.GetCode, (out) => {
    out.push(0x1d, 0x00, 0x00, 0x2b);
    writeStr(out, 0, '1400227916');
    writeStr(out, 1, phone);
    writeStr(out, 2, '');
    writeStr(out, 3, 'ONE');
    writeStr(out, 4, '');
    writeStr(out, 5, '');
    writeStr(out, 6, '86');
  });
  const inner = unwrapResponse(outer);
  const msg = readStrByTag(inner, 1) ?? '';
  const ok = /^ok$/i.test(msg.trim());
  return { ok, message: ok ? '验证码已发送' : `发码失败：${serverMessage(inner) || msg}` };
}

function serverMessage(inner: Uint8Array): string {
  let best = ''; let cur: number[] = [];
  const flush = () => {
    if (cur.length >= 3) {
      const s = new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(cur));
      if (/[\u4e00-\u9fa5]/.test(s) && s.length > best.length) best = s;
    }
    cur = [];
  };
  for (const b of inner) { if (b >= 0x20 && b <= 0xff) cur.push(b); else flush(); }
  flush();
  return best.replace(/\s+$/, '');
}

async function newLogin(cfg: YspConfig, code: string): Promise<{ ok: boolean; message: string; tokens?: Tokens }> {
  const phone = normalizePhone(cfg.phone);
  const dev = cfg.device;
  const requestId = requestIdCounter++;
  const requestUuid = newRequestUuid();

  // NewLogin 用骨架回放：登录体有扩展类型（type13/15）语义未闭合，手搓只能猜
  const skel = b64decode(SKEL_NEWLOGIN);
  const out = new Uint8Array(skel);
  const PHONE_PH = '+8613800138000';
  const CODE_PH = '246810';
  const UUID_PH = 'BBBBBBBB-7547-48DC-8B8F-775A5E7A4075';
  const GUID_PH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

  const phoneAt = indexOfSeq(out, enc8(PHONE_PH));
  if (phoneAt < 0) throw new Error('骨架里找不到手机号占位');
  out.set(enc8(phone), phoneAt);

  // 验证码 4–8 位长度可变 → 重建 + 改长度字节
  const codeAt = indexOfSeq(out, enc8(CODE_PH));
  if (codeAt < 0) throw new Error('骨架里找不到验证码占位');
  const codeBytes = enc8(code);
  const rebuilt = new Uint8Array(out.length - CODE_PH.length + codeBytes.length);
  rebuilt.set(out.subarray(0, codeAt), 0);
  rebuilt.set(codeBytes, codeAt);
  rebuilt.set(out.subarray(codeAt + CODE_PH.length), codeAt + codeBytes.length);
  rebuilt[codeAt - 1] = codeBytes.length;

  const uuidAt = indexOfSeq(rebuilt, enc8(UUID_PH));
  if (uuidAt >= 0) rebuilt.set(enc8(requestUuid), uuidAt);
  let at2 = indexOfSeq(rebuilt, enc8(GUID_PH));
  while (at2 >= 0) { rebuilt.set(enc8(dev.guid), at2); at2 = indexOfSeq(rebuilt, enc8(GUID_PH), at2 + 1); }
  rebuilt[18] = requestId & 0xff; // ⚠ requestId 在 [18]，写 [17] 是 tag 字节 → 404
  const total = rebuilt.length;
  rebuilt[1] = total & 0xff;
  rebuilt[2] = (total >> 8) & 0xff;

  const outer = encodeOuter({ cmd: CMD.NewLogin, inner: rebuilt, device: dev });
  const resp = await postOuter(cfg, CMD.NewLogin, outer, requestUuid, requestId);
  const inn = unwrapResponse(resp);

  // token 提取（映射经 2026-11-07 逐字节比对验证）：
  //   第1枚 43 位 = access_token；第2枚 = refresh_token；第3枚 = vusession/jce_token
  const tokens: string[] = [];
  let guid: string | null = null;
  let vuserid = 0;
  const latin = new TextDecoder('latin1').decode(inn);
  for (let i = 0; i + 2 < inn.length; i++) {
    const tagByte = inn[i]; const len = inn[i + 1];
    const tag = tagByte >> 4; const ty = tagByte & 0x0f;
    if (ty !== 6 || tag < 1 || tag > 4) continue;
    if (len === 43) {
      const raw = latin.slice(i + 2, i + 2 + 43);
      if (/^[A-Za-z0-9_-]{43}$/.test(raw)) tokens.push(raw);
    } else if (len === 32 && tag === 1 && !guid) {
      const raw = latin.slice(i + 2, i + 2 + 32);
      if (/^[0-9a-f]{32}$/i.test(raw)) guid = raw;
    }
  }
  for (let i = 0; i + 5 < inn.length; i++) {
    if (inn[i] !== 0x02) continue;
    const v = ((inn[i + 1] << 24) | (inn[i + 2] << 16) | (inn[i + 3] << 8) | inn[i + 4]) >>> 0;
    if (v >= 1_000_000 && v < 2_000_000_000) vuserid = v;
  }
  const uniq = Array.from(new Set(tokens));
  const ok = uniq.length >= 2;
  return {
    ok,
    message: ok ? '登录成功' : `登录失败：${serverMessage(inn) || '响应形状不符'}`,
    tokens: ok ? {
      guid: guid ?? dev.guid,
      vuserid: vuserid ? String(vuserid) : '',
      openid: guid ?? '',
      access_token: uniq[0],
      refresh_token: uniq[1],
      vusession: uniq[2],
      jce_token: uniq[2],
    } : undefined,
  };
}

/** 验活（AccountUserInfo 24802，只读）。 */
async function whoamiJce(cfg: YspConfig, t: Tokens): Promise<{ ok: boolean; message: string; nickname?: string }> {
  const inner = splice(SKEL_USERINFO, [
    [DEFAULT_DEVICE.clientKey, cfg.device.clientKey],
    [DEFAULT_DEVICE.qimei36, cfg.device.qimei36],
    [DEFAULT_DEVICE.guid, cfg.device.guid],
    ['A'.repeat(43), t.jce_token],
    ['900000001', t.vuserid.padStart(9, '0').slice(-9)],
  ]);
  const uuidInSkel = /[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}/.exec(
    new TextDecoder('latin1').decode(inner),
  )?.[0] ?? newRequestUuid();
  const outer = encodeOuter({ cmd: CMD.AccountUserInfo, inner, device: cfg.device });
  const res = await postOuter(cfg, CMD.AccountUserInfo, outer, uuidInSkel, 60);
  const body = unwrapResponse(res);
  const ret = readIntByTag(body, 2);
  const nick = /手机用户[\d*]+/.exec(new TextDecoder('utf-8').decode(body))?.[0];
  if (ret == null || ret === 0) return { ok: true, message: '会话有效', nickname: nick };
  return { ok: false, message: `业务码 ${ret}${ret === 15006 ? '（未登录/已过期）' : ''}` };
}

/**
 * 结算任务（TaskComplete 25042）。
 * ⚠ 尾字节 = 任务 id（re/14 §12.11）：不传 taskId 只会结算骨架自带的 42（点赞）。
 */
/** 15006 = 未登录/会话过期（服务端唯一明确的会话失效信号）。 */
function isSessionExpired(s: string): boolean {
  return s.includes('15006');
}

const SESSION_HINT = '会话已过期 —— 到插件页重新「发验证码 → 登录」';

async function completeTask(cfg: YspConfig, t: Tokens, taskId: number): Promise<{ ok: boolean; message: string }> {
  const inner = splice(SKEL_TASK, [
    [DEFAULT_DEVICE.clientKey, cfg.device.clientKey],
    [DEFAULT_DEVICE.idfv, cfg.device.idfv],
    [DEFAULT_DEVICE.qimei36, cfg.device.qimei36],
    [DEFAULT_DEVICE.guid, cfg.device.guid],
    ['A'.repeat(43), t.jce_token],
    ['900000001', t.vuserid.padStart(9, '0').slice(-9)],
  ]);
  const latin = new TextDecoder('latin1').decode(inner);
  const at = latin.lastIndexOf('\x1d\x00\x00\x04\x00');
  if (at >= 0) inner[at + 5] = taskId;
  const outer = encodeOuter({ cmd: CMD.TaskComplete, inner, device: cfg.device });
  const res = await postOuter(cfg, CMD.TaskComplete, outer, newRequestUuid(), 65);
  const body = unwrapResponse(res);
  const txt = new TextDecoder('utf-8').decode(body);
  if (/success/i.test(txt)) return { ok: true, message: 'success' };
  if (/has been complete/i.test(txt)) return { ok: true, message: '已完成（此前结算）' };
  if (isSessionExpired(txt)) return { ok: false, message: SESSION_HINT };
  return { ok: false, message: txt.replace(/[^\x20-\x7e\u4e00-\u9fa5]/g, '').slice(0, 40) };
}

/** 点赞（LikeAction 24803）：重放 = 再点抓包里那一个视频，幂等。 */
async function likeAction(cfg: YspConfig, t: Tokens): Promise<{ ok: boolean; message: string }> {
  const inner = splice(SKEL_LIKE, [
    [DEFAULT_DEVICE.clientKey, cfg.device.clientKey],
    [DEFAULT_DEVICE.idfv, cfg.device.idfv],
    [DEFAULT_DEVICE.qimei36, cfg.device.qimei36],
    [DEFAULT_DEVICE.guid, cfg.device.guid],
    ['A'.repeat(43), t.jce_token],
    ['900000001', t.vuserid.padStart(9, '0').slice(-9)],
  ]);
  const outer = encodeOuter({ cmd: CMD.LikeAction, inner, device: cfg.device });
  const res = await postOuter(cfg, CMD.LikeAction, outer, newRequestUuid(), 66);
  const body = unwrapResponse(res);
  const txt = new TextDecoder('utf-8').decode(body);
  if (txt.includes('点赞成功')) return { ok: true, message: '点赞成功' };
  const ret = readIntByTag(body, 2);
  return { ok: false, message: ret === 15006 ? '会话失效' : `业务码 ${ret ?? '?'}` };
}

// ======================================================================
// H5 通道（全 JSON/文本，QuickJS 也能跑）
// ======================================================================

const H5_BASE = 'https://h5access.yangshipin.cn/web';
const H5_VAPPID = '59306155';
const H5_VSECRET = 'b42702bf7309a179d102f3d51b1add2fda0bc7ada64cb801';
const H5_APP_ID = '1400227916';
const VPLATFORM = '5'; // iOS 端必须 5；9 → 一律 15006

type Tokens = {
  guid: string; vuserid: string; openid: string;
  access_token: string; refresh_token: string; vusession: string; jce_token: string;
  nickname?: string;
};

type H5Http = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json: any; text: string }>;

/** 文本 HTTP：三个引擎都是 fetch（面板 0.3.0 起 QuickJS 也有）。 */
const h5Http: H5Http = async (url, init) => {
  try {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
    const t = await res.text();
    let json: any = null;
    try { json = JSON.parse(t); } catch { json = null; }
    return { status: res.status, json, text: t };
  } catch (e) {
    return { status: 0, json: null, text: String(errText(e)) };
  }
};

function h5Qs(s: Tokens, extra: Record<string, string> = {}): string {
  return new URLSearchParams({
    vappid: H5_VAPPID, vsecret: H5_VSECRET, raw: '1',
    guid: s.guid, vplatform: VPLATFORM, ...extra,
  }).toString();
}

function cookieHeader(s: Tokens): string {
  const m: Array<[string, string]> = [
    ['guid', s.guid], ['openid', s.openid], ['vuserid', s.vuserid],
    ['access_token', s.access_token], ['refresh_token', s.refresh_token],
    ['vusession', s.vusession], ['vplatform', VPLATFORM],
    ['ysptokenappid', H5_APP_ID],
  ];
  return m.filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join('; ');
}

async function h5WhoAmI(s: Tokens) {
  const r = await h5Http(`${H5_BASE}/simple_user_info?${h5Qs(s)}`, {
    method: 'GET', headers: { cookie: cookieHeader(s) },
  });
  const user = r.json?.data?.user;
  if (r.json?.ret === 15006 || (!user && r.json?.ret !== 0)) {
    return { ok: false, message: `会话无效：${r.json?.msg ?? r.json?.ret ?? r.status}` };
  }
  return { ok: true, message: '会话有效', user };
}

async function pointTotal(s: Tokens): Promise<number | null> {
  const r = await h5Http(`${H5_BASE}/point_total?${h5Qs(s, { targetId: '1' })}`, {
    method: 'GET', headers: { cookie: cookieHeader(s) },
  });
  const v = r.json?.data?.integralCount;
  return typeof v === 'number' ? v : null;
}

type TaskRow = { id: number; name: string; point: number; status: number; completedCount?: number; maxCompleteCount?: number };

async function listTasks(s: Tokens): Promise<{ ok: boolean; message: string; tasks: TaskRow[] }> {
  const r = await h5Http(`${H5_BASE}/point_task_list_auth?${h5Qs(s)}`, {
    method: 'GET', headers: { cookie: cookieHeader(s) },
  });
  const list = r.json?.data?.taskList;
  if (!Array.isArray(list)) return { ok: false, message: r.json?.msg ?? `HTTP ${r.status}`, tasks: [] };
  return {
    ok: true, message: `${list.length} 个任务`,
    tasks: list.map((t: any) => ({
      id: t.id, name: t.name, point: t.point ?? 0, status: t.status ?? 0,
      completedCount: t.completedCount, maxCompleteCount: t.maxCompleteCount,
    })),
  };
}

async function collectPoints(s: Tokens): Promise<{ ok: boolean; message: string }> {
  const r1 = await h5Http(`${H5_BASE}/task/point/nocollect?${h5Qs(s)}`, {
    method: 'GET', headers: { cookie: cookieHeader(s) },
  });
  const d = r1.json?.data;
  if (!d || typeof d.totalCount !== 'number') return { ok: false, message: `待领取查询失败：HTTP ${r1.status}` };
  if (!d.totalCount) return { ok: true, message: '没有待领取的积分' };
  const details: any[] = d.noCollectDetails ?? d.details ?? d.list ?? [];
  const flowIDs = details.map((x) => String(x.flowID ?? x.flowId ?? '')).filter(Boolean);
  if (!flowIDs.length) return { ok: true, message: `待领取 ${d.totalCount} 条但没有 flowID` };
  const r2 = await h5Http(`${H5_BASE}/task/point/collect?${h5Qs(s)}`, {
    method: 'POST',
    headers: { cookie: cookieHeader(s), 'content-type': 'application/json' },
    body: JSON.stringify({ flowIDs }),
  });
  const ret = r2.json?.data?.retCode ?? r2.json?.ret;
  if (ret === 0) return { ok: true, message: `已领取 ${flowIDs.length} 条` };
  return { ok: false, message: `领取失败：${r2.json?.data?.errMsg ?? r2.json?.msg ?? `HTTP ${r2.status}`}` };
}

// ======================================================================
// 配置与状态（数据目录，0600 由宿主保证；不进插件源码目录）
// ======================================================================

type YspConfig = { phone: string; device: DeviceProfile };

/**
 * 取配置。手机号优先用 state（WebUI 登录时写进去的），config 只是补充 ——
 * 否则「WebUI 登录成功、跑任务却抱怨没配 phone」这种自相矛盾会天天发生。
 */
function resolveConfig(): YspConfig {
  const st = readState();
  let cfg: any = {};
  try { cfg = config() || {}; } catch { /* config 不可用也要能靠 state 跑 */ }
  const phone = text(st.phone) || text(cfg.phone);
  const device: DeviceProfile = { ...DEFAULT_DEVICE, ...(cfg.device || {}) };
  return { phone, device };
}

/** 严格版：要求配置里真的有手机号（发码/登录用）。 */
function readConfig(): YspConfig {
  const cfg = resolveConfig();
  if (!cfg.phone) {
    throw new Error('还没有手机号。打开「插件列表 → 配置」添加 phone，或在插件页「添加账号」登录。');
  }
  return cfg;
}

// 状态文件落插件数据目录。node:fs 三个引擎都有（QuickJS 那份被围栏在插件自己
// 的目录内，相对路径 'data/state.json' 就是 <PLUGIN_DATA_DIR>/yangshipin/data/state.json）。
function fsMod(): typeof import('node:fs') {
  return fs;
}

function readState(): { tokens?: Tokens; phone?: string; loggedAt?: string } {
  try { return JSON.parse(fsMod().readFileSync('data/state.json', 'utf-8')) || {}; } catch { return {}; }
}

function writeState(s: any): void {
  const fs = fsMod();
  try { fs.mkdirSync('data', { recursive: true }); } catch { /* QuickJS 可能已存在 */ }
  fs.writeFileSync('data/state.json', JSON.stringify(s, null, 2));
}

function needTokens(): Tokens {
  const t = readState().tokens;
  if (!t?.jce_token) throw new Error('还没有登录态。先运行「发验证码」→ 填 code → 运行「登录」。');
  return t;
}

// ======================================================================
// handlers（全部 register_handler：写操作由面板手动触发，不挂 cron）
// ======================================================================

/** 发验证码（写操作：真实发短信）。 */
async function hSendCode(): Promise<void> {
  start('央视频发码');
  const cfg = readConfig();
  const r = await getCode(cfg);
  if (!r.ok) throw new Error(r.message);
  success('验证码已发送，请查看短信，把 6 位数字填进 code 配置项，再运行「登录」');
}

/** 用 code 登录，token 落 data/state.json。 */
async function hLogin(): Promise<void> {
  start('央视频登录');
  const cfg = readConfig();
  let code = text((config() as any)?.code);
  if (!code) throw new Error('还没有填验证码。先运行「发验证码」，收到短信后把数字填进 code 配置项。');
  if (!/^\d{4,8}$/.test(code)) throw new Error('验证码应为 4–8 位数字');
  const r = await newLogin(cfg, code);
  if (!r.ok || !r.tokens) throw new Error(r.message);
  writeState({ tokens: r.tokens, phone: cfg.phone, loggedAt: new Date().toISOString() });
  success(`登录成功：vuserid=${r.tokens.vuserid}（token 已写入 data/state.json）`);
}

/** 登录态验活（App 侧 24802，需 Node/Bun 引擎）。 */
async function hSessionCheck(): Promise<void> {
  start('央视频会话自检');
  const cfg = readConfig();
  const t = needTokens();
  const r = await whoamiJce(cfg, t);
  if (!r.ok) throw new Error(`会话不可用：${r.message}（过期后重新「发验证码」+「登录」）`);
  success(`会话有效 ${r.nickname ?? ''} vuserid=${t.vuserid}`);
}

/** H5 只读自检（QuickJS 可跑）。 */
async function hH5Check(): Promise<void> {
  start('央视频 H5 自检');
  const t = needTokens();
  const r = await h5WhoAmI(t);
  if (!r.ok) throw new Error(r.message);
  success(`H5 会话有效 vuid=${r.user?.vuid ?? '?'} ${r.user?.nickname ?? ''}`);
}

/** 查任务 + 积分（H5，QuickJS 可跑）。 */
async function hTasks(): Promise<void> {
  start('央视频任务查询');
  const t = needTokens();
  const total = await pointTotal(t);
  log('info', `当前积分：${total ?? '?'}`);
  const r = await listTasks(t);
  if (!r.ok) throw new Error(`任务列表失败：${r.message}`);
  for (const x of r.tasks) {
    log('info', `  id=${x.id} ${x.name} +${x.point}分 status=${x.status} 完成 ${x.completedCount ?? 0}/${x.maxCompleteCount ?? '?'}`);
  }
  success(`任务列表 ${r.message}，当前积分 ${total ?? '?'}`);
}

/**
 * 一键做任务：TaskComplete ×7（Node/Bun 引擎）→ 领取（H5）。
 * maxCompleteCount 是上限（观看类 3/天），到顶幂等，不是错误。
 */
const TASK_LIST: Array<[number, string]> = [
  [14, '观看电视'], [17, '观看视频'], [13, '观看直播'],
  [37, '关注央视频号'], [42, '点赞视频'], [43, '分享'], [28, '每日签到'],
];

/** 面板 budget 硬上限 10 分钟；留 2 分钟给请求本身、领取和抖动，自己卡在 8 分钟。 */
const TASK_BUDGET_MS = 480_000;
const MIN_GAP_MS = 30_000;
const MAX_GAP_MS = 65_000;

type PlanItem = { id: number; name: string; need: number };
type QueueItem = { id: number; name: string };
type DoTasksResult = { ok: number; skip: number; failed: number; collect: string; points: number | null; lines: string[] };

/**
 * 查**一次**现状，算出每个任务还差几次。
 * 已满的任务直接 need=0 —— 一个包都不发（对已完成的任务发 TaskComplete，
 * 服务端只会回 task has been complete，纯属浪费请求、还多一次被风控看到的机会）。
 */
async function planTasks(t: Tokens): Promise<PlanItem[]> {
  const fallback: PlanItem[] = TASK_LIST.map(([id, name]) => ({ id, name, need: 1 }));
  try {
    const r = await listTasks(t);
    if (!r.ok || !r.tasks.length) return fallback;
    const plan = r.tasks.map((x) => {
      const max = Number(x.maxCompleteCount ?? 1);
      const done = Number(x.completedCount ?? 0);
      return {
        id: Number(x.id),
        name: x.name || String(x.id),
        need: Math.max(0, (Number.isFinite(max) ? max : 1) - (Number.isFinite(done) ? done : 0)),
      };
    });
    return plan.filter((x) => x.need > 0);
  } catch {
    return fallback; // 查不到就保守各发一次
  }
}

/**
 * 计划 → 请求序列。按轮交错：第 1 轮把所有任务过一遍，
 * 第 2 轮起只补没满的（观看/关注），点赞/分享/签到不会出现第二次。
 */
function buildQueue(plan: PlanItem[]): QueueItem[] {
  const queue: QueueItem[] = [];
  const rounds = plan.reduce((m, p) => Math.max(m, p.need), 0);
  for (let r = 0; r < rounds; r++) {
    for (const p of plan) if (r < p.need) queue.push({ id: p.id, name: p.name });
  }
  return queue;
}

/**
 * 做任务的核心（handler / WebUI 路由 / 定时任务三处共用）。
 *
 * 设计要点：
 *   1. **一次跑完**：查一次状态 → 只发还差次数的包 → 领取。没有「跑几轮」的概念，
 *      「3 次」是同一个任务要发 3 个包，不是三次调度。
 *   2. **只发有效请求**：点赞/分享/签到 maxCompleteCount=1，第一轮之后永不再发。
 *   3. **间隔自适应预算**：包多就把间隔压到 30 秒下限，包少就放宽到 65 秒，
 *      保证单次执行稳稳落在面板 10 分钟 budget 内（超了是 SIGKILL）。
 *   4. **一次调用只处理一个账号**：多账号要各注册一条 cron，别在这里循环。
 */
async function doTasksCore(opts: { likeFirst?: boolean; onLine?: (s: string) => void } = {}): Promise<DoTasksResult> {
  const deadline = Date.now() + TASK_BUDGET_MS;
  const cfg = resolveConfig();
  const t = needTokens();
  const lines: string[] = [];
  const push = (s: string) => { lines.push(s); opts.onLine?.(s); };

  let ok = 0; let skip = 0; let failed = 0;

  if (opts.likeFirst) {
    try { await likeAction(cfg, t); push('✓ 已点赞'); }
    catch (e) { push('⚠ 点赞失败：' + errText(e)); }
  }

  // ① 查一次现状
  const plan = await planTasks(t);
  const queue = buildQueue(plan);
  if (!queue.length) {
    push('今天的任务都已满额，没有要发的包');
  } else {
    push(`计划：${plan.filter((p) => p.need > 0).map((p) => `${p.name}×${p.need}`).join('、')}（共 ${queue.length} 个包）`);
  }

  // ② 间隔：按队列长度反推，保证不超预算
  const want = taskGapMs();
  const fit = queue.length > 1 ? Math.floor(TASK_BUDGET_MS / (queue.length - 1)) : want;
  const gap = Math.max(MIN_GAP_MS, Math.min(want, fit, MAX_GAP_MS));
  if (queue.length > 1 && gap < want) {
    push(`（${queue.length} 个包要发，间隔按预算压到 ${Math.round(gap / 1000)} 秒）`);
  }

  // ③ 逐个发
  const done = new Map<number, number>();   // 任务 id → 本次已成功次数
  const full = new Set<number>();           // 任务 id → 已满，后续跳过
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (full.has(item.id)) continue;
    if (Date.now() > deadline) {
      push(`⏱ 时间预算用完，还剩 ${queue.length - i} 个包没发（下次触发会接着做）`);
      break;
    }
    if (ok + skip + failed > 0) await wait(gap);
    try {
      const r = await completeTask(cfg, t, item.id);
      if (r.ok && r.message === 'success') {
        ok++;
        const n = (done.get(item.id) ?? 0) + 1;
        done.set(item.id, n);
        push(`✓ [${item.name}] 第 ${n} 次`);
      }
      else if (r.ok) { skip++; full.add(item.id); push(`· [${item.name}] ${r.message}`); }
      else { failed++; push(`✗ [${item.name}] ${r.message}`); }
    } catch (e) {
      failed++;
      push(`✗ [${item.name}] ${errText(e)}`);
    }
  }

  // ④ 领取
  await wait(400);
  const c = await collectPoints(t);
  const points = await pointTotal(t);
  push(`领取：${c.message}`);

  return { ok, skip, failed, collect: c.message, points, lines };
}

async function hDoTasks(): Promise<void> {
  start('央视频做任务');
  // 手动触发只跑 1 轮：要快。想一次拿满就在插件页点「做任务」多次，或等定时任务（3 轮）
  const r = await doTasksCore({ onLine: (s) => log(s.startsWith('✗') ? 'warn' : 'info', '  ' + s) });
  const summary = `任务结算 ${r.ok} 新完成 / ${r.skip} 已结算` + (r.failed ? ` / ${r.failed} 失败` : '')
    + `；${r.collect}；当前积分 ${r.points ?? '?'}`;
  if (r.failed && !r.ok && !r.skip) throw new Error(summary);
  success(summary);
}

/** 点赞一次（写操作，幂等）。 */
async function hLike(): Promise<void> {
  start('央视频点赞');
  const cfg = readConfig();
  const t = needTokens();
  const r = await likeAction(cfg, t);
  if (!r.ok) throw new Error(r.message);
  success(r.message);
}

/** 导出 H5 cookie（Netscape + JSON），喂给浏览器 / yt-dlp。 */
async function hExportCookies(): Promise<void> {
  start('央视频 cookie 导出');
  const t = needTokens();
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const pairs: Array<[string, string]> = [
    ['guid', t.guid], ['openid', t.openid], ['vuserid', t.vuserid],
    ['access_token', t.access_token], ['refresh_token', t.refresh_token],
    ['vusession', t.vusession], ['vplatform', VPLATFORM], ['ysptokenappid', H5_APP_ID],
  ];
  const netscape = ['# Netscape HTTP Cookie File']
    .concat(pairs.map(([k, v]) => `.yangshipin.cn\tTRUE\t/\tFALSE\t${exp}\t${k}\t${v}`))
    .join('\n');
  // ⚠ 不写日志：cookie 里是 access_token / refresh_token / vusession，
  // 日志会被面板落盘并可能在日志页/推送里被看到 —— 凭据只落 0600 的数据文件。
  const path = 'data/cookies.txt';
  try { fsMod().mkdirSync('data', { recursive: true }); } catch { /* 已存在 */ }
  fsMod().writeFileSync(path, netscape + '\n');
  success(`cookie 已写入 ${path}（含凭据，未写日志；不需要时记得删除）`);
}

register_handler('send-code', hSendCode, { summary: '发短信验证码（写操作）' });
register_handler('login', hLogin, { summary: '用 code 配置项登录并保存 token（写操作）' });
register_handler('session-check', hSessionCheck, { summary: 'App 侧会话验活' });
register_handler('h5-check', hH5Check, { summary: 'H5 会话自检' });
register_handler('tasks', hTasks, { summary: '任务列表与积分' });
register_handler('do-tasks', hDoTasks, { summary: '一键结算全部任务并领取积分（写操作）' });
register_handler('like', hLike, { summary: '点赞一次（写操作，幂等）' });
register_handler('export-cookies', hExportCookies, { summary: '导出 H5 cookie' });

/* ============================================================
 * WebUI（照 mgmusic-plugin 的形态）：
 *   index.html 静态页（面板服务在 /plugins/yangshipin/）
 *   + register_route 登录/任务 API
 *   + register_nav 侧边栏入口
 * 页面里的相对路径 fetch('api/xxx') 命中下面这些路由（同源，无需 CORS）。
 * ============================================================ */

const WEB_API = '/plugins/yangshipin/api';

function routeJson(status: number, obj: any) {
  return { status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(obj) };
}

function parseBody(req: any): any {
  if (!req || req.body === undefined || req.body === null || req.body === '') return {};
  if (typeof req.body === 'object') return req.body;
  try { return JSON.parse(req.body); } catch { throw new Error('请求体不是 JSON'); }
}

/** UI 状态：登录态 + 积分，页面首屏一次拿全。 */
function uiStatus() {
  const st = readState();
  const t = st.tokens;
  const engine = IS_NODE ? 'node' : 'quickjs';
  if (!t?.jce_token) return { ok: true, engine, accounts: [] };
  return {
    ok: true,
    engine,
    accounts: [{
      vuid: t.vuserid,
      phone: st.phone,
      nickname: t.nickname,
      loggedAt: st.loggedAt,
      // 积分靠 H5 现查：失败就是 null，不影响账号卡片显示
      points: null,
    }],
  };
}

register_route(WEB_API + '/status', 'GET', () => {
  const base = uiStatus();
  const t = readState().tokens;
  if (!t?.jce_token) return routeJson(200, base);
  // 补一次积分（quickjs 也跑同一条 H5 路径）；失败不报错，卡片先显示「积分未读取」
  return pointTotal(t)
    .then((p) => {
      if (p !== null && base.accounts[0]) base.accounts[0].points = p;
      return routeJson(200, base);
    })
    .catch(() => routeJson(200, base));
});

register_route(WEB_API + '/login/send', 'POST', (req: any) => {
  const body = parseBody(req);
  const phone = text(body?.phone);
  if (!/^\d{11}$/.test(phone)) return routeJson(400, { ok: false, message: '请输入 11 位手机号' });
  const cfg: YspConfig = { phone, device: (config() as any)?.device ?? DEFAULT_DEVICE };
  return getCode(cfg).then((r) =>
    r.ok ? routeJson(200, { ok: true, message: r.message })
         : routeJson(400, { ok: false, message: r.message }));
});

register_route(WEB_API + '/login/verify', 'POST', (req: any) => {
  const body = parseBody(req);
  const phone = text(body?.phone);
  const code = text(body?.code);
  if (!/^\d{11}$/.test(phone)) return routeJson(400, { ok: false, message: '手机号形状不对' });
  if (!/^\d{4,8}$/.test(code)) return routeJson(400, { ok: false, message: '验证码应为 4–8 位数字' });
  const cfg: YspConfig = { phone, device: (config() as any)?.device ?? DEFAULT_DEVICE };
  return newLogin(cfg, code).then((r) => {
    if (!r.ok || !r.tokens) return routeJson(400, { ok: false, message: r.message });
    writeState({ tokens: r.tokens, phone, loggedAt: new Date().toISOString() });
    return routeJson(200, { ok: true, message: r.message, vuid: r.tokens.vuserid });
  });
});

register_route(WEB_API + '/logout', 'POST', () => {
  const st = readState();
  writeState({ ...st, tokens: undefined });
  return routeJson(200, { ok: true, message: '已退出' });
});

register_route(WEB_API + '/tasks', 'GET', () => {
  const t = needTokens();
  return pointTotal(t).then(async (total) => {
    const r = await listTasks(t);
    if (!r.ok) return routeJson(400, { ok: false, message: r.message });
    const lines = [`当前积分：${total ?? '?'}`].concat(
      r.tasks.map((x) => `id=${x.id} ${x.name} +${x.point}分 status=${x.status} 完成 ${x.completedCount ?? 0}/${x.maxCompleteCount ?? '?'}`),
    );
    return routeJson(200, { ok: true, lines, points: total });
  });
});

register_route(WEB_API + '/do-tasks', 'POST', (req: any) => {
  const body = parseBody(req);
  return doTasksCore({ likeFirst: !!body?.likeFirst }).then((r) => routeJson(200, {
    ok: true,
    message: `任务结算 ${r.ok} 新完成 / ${r.skip} 已结算` + (r.failed ? ` / ${r.failed} 失败` : '')
      + `；当前积分 ${r.points ?? '?'}`,
    lines: r.lines,
    points: r.points,
  }));
}, { budget_ms: 600000 });

register_route(WEB_API + '/cookies', 'GET', () => {
  const t = needTokens();
  const exp = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const pairs: Array<[string, string]> = [
    ['guid', t.guid], ['openid', t.openid], ['vuserid', t.vuserid],
    ['access_token', t.access_token], ['refresh_token', t.refresh_token],
    ['vusession', t.vusession], ['vplatform', '5'], ['ysptokenappid', '1400227916'],
  ];
  const netscape = ['# Netscape HTTP Cookie File']
    .concat(pairs.map(([k, v]) => `.yangshipin.cn\tTRUE\t/\tFALSE\t${exp}\t${k}\t${v}`))
    .join('\n');
  return routeJson(200, { ok: true, netscape, json: pairs.map(([name, value]) => ({ name, value, domain: '.yangshipin.cn', path: '/', secure: true })) });
});

register_nav({ label: '央视频', icon: '📺' });

/* ============================================================
 * 定时任务：每天早 5 点 + 晚 5 点，各带 ±1 小时抖动，一次跑完
 *
 * **一次执行做完今天所有能做的**：先查一次状态，只给「还差次数」的任务发包
 * （观看/关注各 3 个包，点赞/分享/签到各 1 个，最多 15 个），间隔按预算自适应，
 * 全程 6–8 分钟，稳在面板 10 分钟 budget 内。
 *
 * 为什么两次：任务额度按自然日 0 点重置，早上 5 点那次通常就把当天做满了，
 * 所以晚 5 点多半是「0 个包、1 秒结束」。它的价值是**兜底** —— 早上那次
 * 网络失败 / 会话过期 / 机器没开机，晚上还有一次机会；真有剩余额度也能补上。
 *
 * `~1h` 是面板 cron 的抖动后缀（host-api §1.2.8）：实际触发落在
 * [04:00, 06:00] 与 [16:00, 18:00] 之间随机，固定时刻是脚本指纹。
 * 只往后偏就换成 `+1h`。
 * ============================================================ */
// 一次任务跑 6–8 分钟（最多 15 个包 × 30–65 秒），远超普通任务预期：
// 声明独占线程，免得同线程的其它插件被我们一起拖住（host-api §1.2.5 要求）。
worker_hint('exclusive');

register_cron('每日任务', '0 5,17 * * * ~1h', async () => {
  start('央视频每日任务');
  const st = readState();
  if (!st.tokens?.jce_token) {
    log('warn', '没有登录态，跳过本次 —— 到插件页「添加账号」登录一次即可');
    return;
  }
  const r = await doTasksCore({ onLine: (s) => log(s.startsWith('✗') ? 'warn' : 'info', '  ' + s) });
  const summary = `每日任务：${r.ok} 新完成 / ${r.skip} 已满` + (r.failed ? ` / ${r.failed} 失败` : '')
    + `；${r.collect}；当前积分 ${r.points ?? '?'}`;
  if (r.failed && !r.ok && !r.skip) throw new Error(summary);
  log(r.failed ? 'warn' : 'info', summary);
}, { summary: '每天早 5 点 / 晚 5 点（各 ±1 小时抖动），一次做完当天所有任务并领取积分', budget_ms: 600000 });

log('info', 'yangshipin 插件已加载（面板 ' + (typeof panel !== 'undefined' ? panel.version() : '?') + '；三个引擎全功能）');
