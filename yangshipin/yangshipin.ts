/**
 * 央视频（yangshipin）短信登录 + 积分任务 —— 单文件面板插件。
 *
 * 安装时由面板把 .ts 转成 .js（OXC / bun / node 均可），运行期只加载 JavaScript。
 * 一份文件跑三个引擎，能力差异在运行时探测：
 *
 *   Node / Bun 引擎：全功能。二进制信封走原生 fetch（吃 Uint8Array），
 *                    gzip 用 node:zlib —— 不需要宿主注入任何全局。
 *   QuickJS 引擎：  只能跑 H5 文本接口（whoami / 任务列表 / 领取 / cookie 导出）。
 *                    登录要发二进制信封 → 明确报错，不静默发坏包
 *                    （实测文本层会把 489 B 的包改成 703 B，服务端 500）。
 *
 * ⚠ 上面的引擎差异是**临时兼容**，根因在面板宿主（http_fetch 只收文本、QuickJS 无 zlib）。
 *   面板侧补齐清单见 PANEL-TODOS.md —— 补齐后本文件的 IS_NODE 分支可以整体删除。
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
  register_handler,
  start,
  success,
} from 'host-api';

// ======================================================================
// 引擎探测与小工具
// ======================================================================

type HttpResult = { status?: number; headers?: Record<string, string>; body?: Uint8Array; error?: string };
type HttpRequest = { method: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number };
type HttpClient = (url: string, req: HttpRequest) => HttpResult | Promise<HttpResult>;

function text(v: unknown): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

function errText(e: unknown): string {
  return text(e && typeof e === 'object' && 'message' in (e as any) ? (e as any).message : e);
}

const g: any = globalThis;
const IS_NODE = Boolean(g.process?.versions?.node || g.process?.versions?.bun);

// ======================================================================
// gzip（Node/Bun：node:zlib；QuickJS：本插件的二进制路径不可用，这里只为报错）
// ======================================================================

function gzipMember(data: Uint8Array): Uint8Array {
  if (IS_NODE) {
    // 动态 require 避免被非 Node 引擎加载时炸掉
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const zlib = (g.process as any).getBuiltinModule?.('node:zlib') ?? require('node:zlib');
    const out = zlib.gzipSync(Buffer.from(data), { mtime: 0 });
    return new Uint8Array(out);
  }
  throw new Error('当前引擎（QuickJS）没有 zlib，无法发二进制信封；请在面板把本插件切到 Node/Bun 引擎');
}

function gunzipMember(data: Uint8Array): Uint8Array {
  if (IS_NODE) {
    const zlib = (g.process as any).getBuiltinModule?.('node:zlib') ?? require('node:zlib');
    return new Uint8Array(zlib.gunzipSync(Buffer.from(data)));
  }
  throw new Error('当前引擎（QuickJS）没有 zlib');
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
  const c = g.crypto;
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
// 传输：Node/Bun 用原生 fetch（吃 Uint8Array）；QuickJS 明确报错
// ======================================================================

const nativeFetchHttp: HttpClient = async (url, req) => {
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

const quickJsUnsupported: HttpClient = () => ({
  status: 0,
  error: 'QuickJS 引擎的 http_fetch 只能收发文本，本插件要发二进制信封；请在面板把本插件切到 Node/Bun 引擎',
});

const binaryHttp: HttpClient = IS_NODE ? nativeFetchHttp : quickJsUnsupported;

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
};

type H5Http = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) =>
  Promise<{ status: number; json: any; text: string }>;

/** 文本 HTTP：QuickJS 用宿主 http_fetch；Node 用原生 fetch。 */
const h5Http: H5Http = async (url, init) => {
  if (IS_NODE) {
    try {
      const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
      const t = await res.text();
      let json: any = null;
      try { json = JSON.parse(t); } catch { json = null; }
      return { status: res.status, json, text: t };
    } catch (e) {
      return { status: 0, json: null, text: String(errText(e)) };
    }
  }
  // QuickJS：宿主 http_fetch 是同步的，这里包一层
  let raw: any;
  try {
    raw = http_fetch(url, { ...init, timeout_ms: 10000 });
  } catch (e) {
    return { status: 0, json: null, text: String(errText(e)) };
  }
  const t = text(raw?.body);
  let json: any = null;
  try { json = JSON.parse(t); } catch { json = null; }
  const st = Number(raw?.status) || 0;
  if (raw?.error && !st) return { status: 0, json: null, text: String(raw.error) };
  return { status: st, json, text: t };
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

function readConfig(): YspConfig {
  let cfg: any;
  try { cfg = config(); } catch (e) { throw new Error('读取插件配置失败：' + errText(e)); }
  cfg = cfg || {};
  const phone = text(cfg.phone);
  if (!phone) {
    throw new Error('还没有配置手机号。打开「插件列表 → 配置」，添加一项 phone（11 位手机号）。');
  }
  const device: DeviceProfile = { ...DEFAULT_DEVICE, ...(cfg.device || {}) };
  return { phone, device };
}

function fsMod(): any {
  if (IS_NODE) return (g.process as any).getBuiltinModule?.('node:fs') ?? require('node:fs');
  return g.fs; // QuickJS 面板扩展：相对路径围栏在插件数据目录
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
async function hDoTasks(): Promise<void> {
  start('央视频做任务');
  const cfg = readConfig();
  const t = needTokens();
  const TASK_IDS: Array<[number, string]> = [
    [14, '观看电视'], [17, '观看视频'], [13, '观看直播'],
    [37, '关注央视频号'], [42, '点赞视频'], [43, '分享'], [28, '每日签到'],
  ];
  let ok = 0; let skip = 0;
  for (const [id, name] of TASK_IDS) {
    try {
      const r = await completeTask(cfg, t, id);
      if (r.ok && r.message === 'success') { ok++; log('info', `  [${name}] ✓ ${r.message}`); }
      else if (r.ok) { skip++; log('info', `  [${name}] · ${r.message}`); }
      else { log('warn', `  [${name}] ✗ ${r.message}`); }
    } catch (e) {
      log('warn', `  [${name}] ✗ ${errText(e)}`);
    }
  }
  const c = await collectPoints(t);
  const total = await pointTotal(t);
  success(`任务结算 ${ok} 新完成 / ${skip} 已结算；${c.message}；当前积分 ${total ?? '?'}`);
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
  log('info', 'Netscape cookies.txt：\n' + netscape);
  log('info', 'JSON：\n' + JSON.stringify(
    pairs.map(([name, value]) => ({ name, value, domain: '.yangshipin.cn', path: '/', secure: true, sameSite: 'None' })),
    null, 2,
  ));
  success('cookie 已打印到日志（vplatform=5，iOS）');
}

register_handler('send-code', hSendCode, { summary: '发短信验证码（写操作）' });
register_handler('login', hLogin, { summary: '用 code 配置项登录并保存 token（写操作）' });
register_handler('session-check', hSessionCheck, { summary: 'App 侧会话验活（需 Node/Bun 引擎）' });
register_handler('h5-check', hH5Check, { summary: 'H5 会话自检（QuickJS 可跑）' });
register_handler('tasks', hTasks, { summary: '任务列表与积分（QuickJS 可跑）' });
register_handler('do-tasks', hDoTasks, { summary: '一键结算全部任务并领取积分（写操作，需 Node/Bun）' });
register_handler('like', hLike, { summary: '点赞一次（写操作，幂等）' });
register_handler('export-cookies', hExportCookies, { summary: '导出 H5 cookie（QuickJS 可跑）' });

log('info', 'yangshipin 插件已加载（引擎：' + (IS_NODE ? 'Node/Bun，全功能' : 'QuickJS，仅 H5 文本接口') + '）');
