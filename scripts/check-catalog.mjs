#!/usr/bin/env node
// 货架体检：catalog.json 里写的版本 / 资产名 / sha256 跟各插件仓的**最新 release** 对不对得上。
//
// 为什么要有它（第 275 轮，用户报「发版又没更新商店数据」）：
// 面板发版和插件发版是两条线，而货架（`panel-single-plugins/catalog.json`）是第三条 ——
// 它不跟着任何一边自动走。于是会出现「插件出了 0.7.8，商店里还写着 0.7.6」，
// 用户点更新装回来的还是旧的。这种事**只能靠人记得**，而人一定会忘。
//
//   node scripts/check-catalog.mjs            # 体检，有过期就红
//   node scripts/check-catalog.mjs --json     # 机器可读
//   node scripts/check-catalog.mjs --fix      # 就地更新 catalog.json（版本/资产/sha/updated_at）
//
// 判据（按条目 type 分）：
//   release → 读 `<repo>` 的最新 release，资产名要与仓库里的 zip 对得上；
//   url     → 读目录里那条 url 指向的 release 资产（货架仓自己的）；
//   file    → 单文件，校验 path 指向的文件存在且 sha256 对得上（不联网）。
//
// 网络来源只走 GitHub（用 gh CLI：它自带鉴权与重试，比手写 fetch 稳）。
// 拿不到就说拿不到 —— **不猜**，也不把「查不到」当成「没问题」。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CATALOG = path.join(ROOT, 'catalog.json');
const FIX = process.argv.includes('--fix');
const JSON_OUT = process.argv.includes('--json');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function gh(args) {
  return execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }).trim();
}

/** 从 tag 里抽版本号：`v0.8.1` / `shop-0.3.3` / `yangshipin-0.4.4` → `0.8.1` 等。 */
function semverOf(tag) {
  const m = String(tag).match(/(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/);
  return m ? m[1] : String(tag).replace(/^v/, '');
}

/**
 * 某个 release：`{tag, assets:[{name,url}]}`。拿不到返回 null。
 *
 * `tag` 给了就取那一个，不给取最新 —— 货架仓里有多个 release
 * （`yangshipin-0.4.4` / `shop-0.3.3`），只取「最新」会把别的条目全判成过期。
 */
function latestRelease(repo, tag) {
  try {
    const args = ['release', 'view', '--repo', repo, '--json', 'tagName,assets'];
    if (tag) args.splice(2, 0, tag);
    const raw = gh(args);
    const j = JSON.parse(raw);
    return {
      tag: j.tagName,
      assets: (j.assets || []).map((a) => ({ name: a.name, url: a.url })),
    };
  } catch (e) {
    return null;
  }
}

/** 下载一个资产并算 sha256。用 gh（走鉴权，私有仓也认）。 */
function fetchSha(url) {
  try {
    const buf = execFileSync('gh', ['api', url.replace('https://api.github.com/', ''), '-H', 'Accept: application/octet-stream'], {
      maxBuffer: 256 * 1024 * 1024,
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { sha: sha256(buf), bytes: buf.length };
  } catch (e) {
    return null;
  }
}

/** 目录里写的版本 vs 实际：只有 release/url 条目需要联网比。 */
const rows = [];
const cat = JSON.parse(readFileSync(CATALOG, 'utf8'));

for (const e of cat.plugins || []) {
  const row = { id: e.id, type: e.type, declared: e.version || '', actual: '', ok: false, why: '' };
  if (e.type === 'file') {
    // 单文件：只看本地那份在不在、sha 对不对（不联网）
    const p = path.join(ROOT, e.path || '');
    if (!existsSync(p)) {
      row.why = `缺文件 ${e.path}`;
    } else {
      const got = sha256(readFileSync(p));
      row.actual = e.version || '(无版本字段)';
      row.ok = got === e.sha256;
      row.why = row.ok ? '' : `sha256 不符：目录写 ${String(e.sha256).slice(0, 12)}…，实际 ${got.slice(0, 12)}…`;
    }
    rows.push(row);
    continue;
  }

  // release / url：都要找到「实际发出去的那个资产」
  let repo = e.repo;
  let assetName = e.asset || '';
  let wantTag = '';
  if (e.type === 'url') {
    // url 形如 https://github.com/<owner>/<repo>/releases/download/<tag>/<asset>
    const m = String(e.url || '').match(/github\.com\/([^/]+\/[^/]+)\/releases\/download\/([^/]+)\/(.+)$/);
    if (!m) {
      row.why = 'url 不是 releases/download 形状，跳不过校验';
      rows.push(row);
      continue;
    }
    repo = m[1];
    wantTag = m[2];
    assetName = m[3];
  }
  const rel = latestRelease(repo, wantTag);
  if (!rel) {
    row.why = `查不到 ${repo} 的 release`;
    rows.push(row);
    continue;
  }
  let asset = rel.assets.find((a) => a.name === assetName);
  if (!asset) {
    row.why = `最新 release ${rel.tag} 里没有 ${assetName}（有的是 ${rel.assets.map((a) => a.name).join('、') || '空'}）`;
    // 资产名对不上时，若只有一个 zip，就把它当成该换成的那个 —— **并且照样算 sha**，
    // 否则 `--fix` 只会改版本号、留下一个错的 sha（第一版就是这个毛病：
    // 改完版本对上了、sha 还是旧的，再跑一次还是红）。
    const zips = rel.assets.filter((a) => a.name.endsWith('.zip'));
    if (zips.length === 1) {
      row.suggestAsset = zips[0].name;
      asset = zips[0];
    }
    row.suggestTag = rel.tag;
  }
  if (!asset) {
    rows.push(row);
    continue;
  }
  const got = fetchSha(asset.url);
  if (!got) {
    row.why = `下载 ${asset.name} 失败（拿不到 sha）`;
    rows.push(row);
    continue;
  }
  row.actual = semverOf(rel.tag);
  row.ok = got.sha === e.sha256 && row.actual === String(e.version || '') && !row.suggestAsset;
  if (!row.ok) {
    row.why = [
      got.sha !== e.sha256 ? `sha256 不符（目录 ${String(e.sha256).slice(0, 12)}… / 实际 ${got.sha.slice(0, 12)}…）` : '',
      row.actual !== String(e.version || '') ? `版本不符（目录 ${e.version} / 实际 ${row.actual}）` : '',
    ].filter(Boolean).join('；');
  }
  row.newSha = got.sha;
  rows.push(row);
}

if (JSON_OUT) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  for (const r of rows) {
    const mark = r.ok ? '\u2713' : '\u2717';
    console.log(`  ${mark} ${r.id.padEnd(12)} 目录 ${String(r.declared || '-').padEnd(10)} 实际 ${String(r.actual || '-').padEnd(10)} ${r.why}`);
  }
}

const bad = rows.filter((r) => !r.ok);
if (bad.length === 0) {
  if (!JSON_OUT) console.log(`\nok: 货架 ${rows.length} 条全部对得上`);
  process.exit(0);
}

if (FIX) {
  // 就地改：版本、资产名、sha、updated_at。只改**对得上的那些字段**，不动别的。
  for (const e of cat.plugins || []) {
    const r = rows.find((x) => x.id === e.id);
    if (!r || r.ok) continue;
    if (r.newSha) e.sha256 = r.newSha;
    if (r.actual) e.version = r.actual;
    if (r.suggestAsset) {
      if (e.type === 'release') e.asset = r.suggestAsset;
      else if (e.type === 'url') {
        e.url = e.url.replace(/\/download\/[^/]+\/[^/]+$/, `/download/${r.suggestTag}/${r.suggestAsset}`);
      }
    }
  }
  cat.updated_at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  writeFileSync(CATALOG, JSON.stringify(cat, null, 2) + '\n');
  console.log(`\n已更新 catalog.json（${bad.map((r) => r.id).join('、')}）；请再跑一次确认`);
  process.exit(0);
}

if (!JSON_OUT) {
  console.log(`\n红: ${bad.length} 条对不上（${bad.map((r) => r.id).join('、')}）—— 跑 --fix 更新，或手改 catalog.json`);
}
process.exit(1);
