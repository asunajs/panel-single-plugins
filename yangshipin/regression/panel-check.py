#!/usr/bin/env python3
"""面板回归：央视频插件的**二进制信封**在 QuickJS 引擎下必须与抓包逐字节一致。

为什么要有这个脚本：这个插件的登录/发码/结算都走一条自造的二进制信封
（24B 头 + guid 段 + gzip 内层 + 尾字节 0x03）。历史上它坏过两次：

  1. 宿主把 Uint8Array 当文本发 → 489 字节变 703 字节，服务端 500；
  2. 单文件版漏了 writeStructEnd（只有调用没有定义）→ ReferenceError。

两次都不是「协议理解错」，而是「真上网的字节不对」。所以这里不看代码，
只**抓住真正发出去的字节**与 reference/packets 里的抓包对拍。

用法：
    python3 yangshipin/regression/panel-check.py [--panel BIN] [--packets DIR] [--live]

默认值：
    --panel    ../rust-plugin-panel/target/release/plugin-panel（或环境变量 PANEL_BIN）
    --packets  ../yangshipin/reference/packets（CLI 仓的抓包目录）

--live 会打真实服务器（h5-check / tasks 是只读的；send-code 会真的发短信，别乱跑）。
"""

import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
PLUGIN_TS = HERE.parent / 'yangshipin.ts'
TOKEN = 'regression-token'
# 与抓包里的号码等长（13 字符），但数字不同 —— 这样才能证明这个字段真的被写进去了
TEST_PHONE = '+8613900139000'
GOLDEN_PHONE = b'+8613800138000'
# 抓包里 requestId 在 [18]，request UUID 占 [180, 216)，其余字节必须完全一致
REQUEST_ID_AT = 18
UUID_WINDOW = (180, 216)

FAILS = []


def check(ok, label, detail=''):
    print(('  ✅ ' if ok else '  ❌ ') + label + ((' — ' + str(detail)) if detail and not ok else ''))
    if not ok:
        FAILS.append(label)
    return ok


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    p = s.getsockname()[1]
    s.close()
    return p


def transpile(src: Path, dst: Path) -> None:
    script = (
        "import { stripTypeScriptTypes } from 'node:module';"
        "import { readFileSync, writeFileSync } from 'node:fs';"
        "writeFileSync(process.argv[2], stripTypeScriptTypes(readFileSync(process.argv[1], 'utf8'), { mode: 'transform' }));"
    )
    subprocess.run(['node', '--input-type=module', '-e', script, str(src), str(dst)], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--panel', default=os.environ.get('PANEL_BIN', str(HERE.parent.parent.parent / 'rust-plugin-panel/target/release/plugin-panel')))
    ap.add_argument('--packets', default=os.environ.get('YSP_PACKETS', str(HERE.parent.parent.parent / 'yangshipin/reference/packets')))
    ap.add_argument('--live', action='store_true')
    args = ap.parse_args()

    panel = Path(args.panel)
    packets = Path(args.packets)
    if not panel.exists():
        print(f'❌ 面板二进制不存在：{panel}（用 --panel 指定）')
        return 2
    golden_outer = (packets / '24680_req_outer.bin').read_bytes()
    golden_inner = (packets / '24680_req_inner.bin').read_bytes()
    resp_outer = (packets / '24680_resp_outer.bin').read_bytes()

    tmp = Path(tempfile.mkdtemp(prefix='ysp-regression-'))
    plugin_js = tmp / 'yangshipin.js'
    transpile(PLUGIN_TS, plugin_js)

    # 抓到的请求：mock 服务器只记录，不解析
    got = {'body': b'', 'headers': {}}

    class Mock(BaseHTTPRequestHandler):
        def do_POST(self):
            got['body'] = self.rfile.read(int(self.headers.get('content-length') or 0))
            got['headers'] = {k.lower(): v for k, v in self.headers.items()}
            self.send_response(200)
            self.send_header('content-type', 'application/octet-stream')
            self.send_header('content-length', str(len(resp_outer)))
            self.end_headers()
            self.wfile.write(resp_outer)

        def log_message(self, *a):
            pass

    mock = ThreadingHTTPServer(('127.0.0.1', 0), Mock)
    threading.Thread(target=mock.serve_forever, daemon=True).start()
    mock_url = f'http://127.0.0.1:{mock.server_address[1]}/'

    # 只改 jacc 主机（其余与真实插件逐字相同）
    src = plugin_js.read_text()
    real_host = "const JACC_HOST = 'https://jacc.ysp.cctv.cn/';"
    if not args.live:
        assert real_host in src, '插件里找不到 JACC_HOST 常量'
        src = src.replace(real_host, f"const JACC_HOST = '{mock_url}';")
    (tmp / 'plugins/js').mkdir(parents=True)
    (tmp / 'plugins/js/yangshipin.js').write_text(src)
    (tmp / 'plugin-data/yangshipin').mkdir(parents=True)
    (tmp / 'plugin-data/yangshipin/config.json').write_text(json.dumps({'phone': TEST_PHONE}))

    port = free_port()
    env = {k: v for k, v in os.environ.items() if not k.startswith('PANEL_TOKEN')}
    env.update({
        'BIND_ADDR': f'127.0.0.1:{port}',
        'DB_PATH': str(tmp / 'panel.db'),
        'PLUGINS_DIR': str(tmp / 'plugins'),
        'PLUGIN_DATA_DIR': str(tmp / 'plugin-data'),
        'TASKS_DIR': str(tmp / 'tasks'),
        'PANEL_LOG_DIR': str(tmp / 'logs'),
        'PANEL_TOKEN': TOKEN,
        'PANEL_ALLOW_PLAIN_TOKEN': '1',
        'PANEL_JS_ENGINE': 'quickjs',
        'HOST_API_ALLOW_PRIVATE': '1',
    })
    log = open(tmp / 'panel.log', 'w')
    proc = subprocess.Popen([str(panel), 'serve'], stdout=log, stderr=subprocess.STDOUT, env=env, cwd=panel.parent)
    base = f'http://127.0.0.1:{port}'
    hdr = {'X-Panel-Token': TOKEN, 'x-panel': '1', 'content-type': 'application/json'}

    def call(path, method='GET', body=None, timeout=120):
        data = json.dumps(body).encode() if body is not None else (b'' if method == 'POST' else None)
        req = urllib.request.Request(base + path, data=data, method=method, headers=hdr)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.status, json.loads(r.read().decode() or '{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read().decode() or '{}')
        except Exception as e:
            return 0, {'error': str(e)}

    try:
        ready = False
        for _ in range(60):
            time.sleep(0.5)
            st, d = call('/api/state')
            if st == 200 and 'plugins' in d:
                ready = True
                break
        if not check(ready, '临时面板就绪'):
            print((tmp / 'panel.log').read_text()[-2000:])
            return 1

        _, d = call('/api/state')
        p = next((x for x in d.get('plugins', []) if x.get('name') == 'yangshipin'), {})
        if not check(not p.get('error'), '插件在 QuickJS 下加载（含 node:zlib / node:fs 的 import）', p.get('error')):
            print((tmp / 'panel.log').read_text()[-2000:])
            return 1
        check(p.get('engine') == 'quickjs', '引擎是 QuickJS（不切 Node）', p.get('engine'))

        handlers = ['send-code'] if not args.live else ['h5-check', 'tasks']
        for h in handlers:
            call('/api/jobs', 'POST', {'plugin': 'yangshipin', 'name': h, 'expr': '@every 6h'})
            st, d = call(f'/api/tasks/yangshipin/{h}/run', 'POST', timeout=300)
            check(d.get('ok') is True, f'handler {h} 成功', json.dumps(d, ensure_ascii=False)[:200])
        time.sleep(0.5)

        if args.live:
            return 0 if not FAILS else 1

        body = got['body']
        check(len(body) > 0, 'mock 收到了请求（说明字节真的出了网卡）')
        check(body[-1:] == b'\x03', '信封尾字节是 0x03', body[-1:].hex())
        gz = body.find(b'\x1f\x8b')
        check(gz == golden_outer.find(b'\x1f\x8b'), 'gzip 段起点与抓包一致', gz)
        inner = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(body[gz:]) if gz >= 0 else b''
        check(len(inner) == len(golden_inner), '内层长度与抓包一致', f'{len(inner)} vs {len(golden_inner)}')
        if len(inner) == len(golden_inner):
            diffs = [i for i in range(len(inner)) if inner[i] != golden_inner[i]]
            ph_at = golden_inner.find(GOLDEN_PHONE)
            allowed = {REQUEST_ID_AT} | set(range(*UUID_WINDOW)) | set(range(ph_at, ph_at + len(GOLDEN_PHONE)))
            stray = [i for i in diffs if i not in allowed]
            check(not stray, '除 requestId / UUID / 手机号外，内层逐字节等于抓包', f'多出差异位 {stray[:10]}')
            check(inner[ph_at:ph_at + len(GOLDEN_PHONE)] == TEST_PHONE.encode(),
                  '配置的手机号真的写进了信封', inner[ph_at:ph_at + 14])
            # 外层头（24B + guid 段）：只有总长度那个字段允许不同
            head = golden_outer.find(b'\x1f\x8b')
            head_diffs = [i for i in range(head) if body[i] != golden_outer[i]]
            check(len(head_diffs) <= 1, '外层头只有总长度字段不同', head_diffs)
        h = got['headers']
        check(h.get('content-type') == 'application/octet-stream', 'content-type 是二进制', h.get('content-type'))
        check(h.get('jcegodid') == '24680', 'jcegodid 是 GetCode(24680)', h.get('jcegodid'))
        check(bool(h.get('request-id')), 'request-id 头在', h.get('request-id'))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
        log.close()
        mock.shutdown()

    if FAILS:
        print(f'\n❌ {len(FAILS)} 项失败：{", ".join(FAILS)}')
        print('日志目录：' + str(tmp))
        return 1
    print('\n✅ 面板回归全部通过')
    return 0


if __name__ == '__main__':
    sys.exit(main())
