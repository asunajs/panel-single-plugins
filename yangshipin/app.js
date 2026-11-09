'use strict';

// 央视频插件页：账号 / 运行两块。
// 账号走短信登录；凭证只在插件数据目录，页面从不接触 token。
const API = '/plugins/yangshipin/api';
const $ = (id) => document.getElementById(id);

const S = {
  accounts: [],
  engine: '',
  sending: false,
  sendTimer: null,
  sendPhone: '',
};

function mask(v, head, tail) {
  const s = String(v || '');
  if (!s) return '';
  if (s.length <= head + tail) return s;
  return s.slice(0, head) + '***' + s.slice(-tail);
}

function setState(kind, text) {
  const el = $('state');
  el.className = 'badge ' + kind;
  el.textContent = text;
}

function show(text) {
  $('out').textContent = text;
}

function showLines(lines) {
  show(Array.isArray(lines) ? lines.join('\n') : String(lines || ''));
}

function setHint(id, kind, text) {
  const el = $(id);
  el.className = 'hint' + (kind === 'error' ? ' err-text' : '');
  el.textContent = text || '';
}

async function call(path, opts) {
  const options = opts || {};
  const method = options.method || 'GET';
  const headers = {};
  if (method !== 'GET') headers['x-panel'] = '1';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(API + path, {
    method: method,
    headers: headers,
    credentials: 'same-origin',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const raw = await res.text();
  let data;
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch (e) {
    throw new Error('HTTP ' + res.status + '（响应不是 JSON）：' + raw.slice(0, 200));
  }
  if (!res.ok) throw new Error(data.error || data.message || ('HTTP ' + res.status));
  if (data.ok === false) {
    const err = new Error(data.message || data.error || '操作失败');
    if (data.lines) err.lines = data.lines;
    throw err;
  }
  return data;
}

async function withBusy(btn, fn) {
  const old = btn.textContent;
  btn.disabled = true;
  btn.textContent = '执行中…';
  try {
    await fn();
  } catch (e) {
    showLines(e.lines || ('失败：' + e.message));
    setState('failed', '有失败');
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}

/* ---------------- 账号 ---------------- */

function accountName(acc, index) {
  const nick = String((acc && acc.nickname) || '').trim();
  if (nick) return nick;
  const vuid = String((acc && acc.vuid) || '');
  return vuid ? ('央视频-' + vuid.slice(-4)) : ('账号 ' + (index + 1));
}

function renderAccounts() {
  const list = $('account-list');
  const accounts = Array.isArray(S.accounts) ? S.accounts : [];
  list.textContent = '';

  $('account-summary').textContent = accounts.length
    ? accounts.length + ' 个账号' + (S.engine ? ' · 引擎 ' + S.engine : '')
    : '还没有账号';
  $('account-empty').hidden = accounts.length > 0;

  accounts.forEach((acc, index) => {
    const li = document.createElement('li');
    li.className = 'account-item';

    const main = document.createElement('div');
    main.className = 'account-main';

    const title = document.createElement('div');
    title.className = 'account-title';
    const name = document.createElement('strong');
    name.textContent = accountName(acc, index);
    title.appendChild(name);

    const badge = document.createElement('span');
    badge.className = 'badge ' + (acc.expired ? 'failed' : 'success');
    badge.textContent = acc.expired ? '会话过期' : '已登录';
    title.appendChild(badge);

    main.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'account-meta';
    meta.textContent = [
      acc.phone ? ('手机号 ' + mask(acc.phone, 3, 4)) : '手机号未知',
      acc.vuid ? ('vuid ' + acc.vuid) : 'vuid 未解析',
    ].join(' · ');
    main.appendChild(meta);

    const sub = document.createElement('div');
    sub.className = 'account-sub';
    const parts = [];
    parts.push(acc.points === null || acc.points === undefined
      ? '积分未读取'
      : ('积分 ' + acc.points));
    if (acc.completed !== undefined && acc.total !== undefined) {
      parts.push('今日任务 ' + acc.completed + '/' + acc.total);
    }
    if (acc.loggedAt) {
      parts.push('登录于 ' + new Date(acc.loggedAt).toLocaleString());
    }
    sub.textContent = parts.join(' · ');
    main.appendChild(sub);

    const actions = document.createElement('div');
    actions.className = 'account-actions';

    const tasks = document.createElement('button');
    tasks.className = 'btn btn-sm';
    tasks.type = 'button';
    tasks.textContent = '任务';
    tasks.addEventListener('click', () => withBusy(tasks, async () => {
      const data = await call('/tasks');
      showLines(data.lines);
      setState('success', '已连接');
      await loadAccounts(true);
    }));
    actions.appendChild(tasks);

    const run = document.createElement('button');
    run.className = 'btn btn-sm';
    run.type = 'button';
    run.textContent = '做任务';
    run.addEventListener('click', () => withBusy(run, async () => {
      show('正在结算今天的任务（后台执行，关掉这个页面不会中断）。\n观看类同一任务两次之间隔 35–50 秒（任务要求看 30 秒），\n点赞/分享/签到之间只隔几秒，整轮约 5 分钟。\n\n结果会写进面板日志；想在这里看就稍后回来刷新。');
      const data = await call('/do-tasks', { method: 'POST', body: { likeFirst: true } });
      showLines((data.lines || []).concat([data.message || '']));
      setState('success', '已完成');
      await loadAccounts(true);
    }));
    actions.appendChild(run);

    const signin = document.createElement('button');
    signin.className = 'btn btn-sm';
    signin.type = 'button';
    signin.textContent = '签到';
    signin.addEventListener('click', () => withBusy(signin, async () => {
      show('正在做兑吧签到（连续 7 天一个周期，1-6 天各 5 分，第 7 天 20 分）…');
      const data = await call('/signin', { method: 'POST', body: {} });
      setLines([data.message || '已签到']);
      setState('success', '已签到');
      await loadAccounts(true);
    }));
    actions.appendChild(signin);

    const cookies = document.createElement('button');
    cookies.className = 'btn btn-sm';
    cookies.type = 'button';
    cookies.textContent = 'cookie';
    cookies.addEventListener('click', () => withBusy(cookies, async () => {
      const data = await call('/cookies');
      show(data.netscape);
    }));
    actions.appendChild(cookies);

    const remove = document.createElement('button');
    remove.className = 'btn btn-sm danger-text';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => removeAccount());
    actions.appendChild(remove);

    li.appendChild(main);
    li.appendChild(actions);
    list.appendChild(li);
  });
}

async function loadAccounts(quiet) {
  if (!quiet) setState('idle', '读取中…');
  try {
    const data = await call('/status');
    S.accounts = Array.isArray(data.accounts) ? data.accounts : [];
    S.engine = data.engine || '';
    renderAccounts();
    const expired = S.accounts.some((a) => a.expired);
    if (!S.accounts.length) setState('idle', '未登录');
    else if (expired) setState('failed', '会话过期');
    else setState('success', '已连接');
  } catch (e) {
    setState('failed', '读取失败');
    showLines('读取账号失败：' + e.message);
  }
}

async function removeAccount() {
  if (!confirm('确定删除这个账号？本地保存的登录凭证会被清除。')) return;
  try {
    await call('/logout', { method: 'POST' });
    show('已删除账号');
    await loadAccounts();
  } catch (e) {
    showLines('删除失败：' + e.message);
  }
}

/* ---------------- 登录弹窗 ---------------- */

function setSendButton(text, disabled) {
  const btn = $('send-code');
  btn.textContent = text;
  btn.disabled = !!disabled;
}

function clearSendTimer() {
  if (S.sendTimer) {
    clearInterval(S.sendTimer);
    S.sendTimer = null;
  }
}

function openLoginDialog() {
  clearSendTimer();
  S.sending = false;
  S.sendPhone = '';
  $('login-phone').value = '';
  $('login-code').value = '';
  setSendButton('发送验证码', false);
  setHint('login-hint', '', '');
  $('login-dialog').hidden = false;
  $('login-phone').focus();
}

function closeLoginDialog() {
  $('login-dialog').hidden = true;
  clearSendTimer();
  S.sending = false;
  S.sendPhone = '';
  setSendButton('发送验证码', false);
}

async function sendCode() {
  if (S.sending) return;
  const phone = ($('login-phone').value || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    setHint('login-hint', 'error', '先填 11 位手机号');
    return;
  }
  S.sending = true;
  setSendButton('发送中…', true);
  setHint('login-hint', '', '正在请求验证码…');
  try {
    const data = await call('/login/send', { method: 'POST', body: { phone: phone } });
    setHint('login-hint', '', data.message || '验证码已发送，请查收短信');
    $('login-code').focus();
    S.sendPhone = phone;
    let left = 60;
    setSendButton('重发（' + left + 's）', true);
    clearSendTimer();
    S.sendTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearSendTimer();
        S.sendPhone = '';
        setSendButton('发送验证码', false);
      } else {
        setSendButton('重发（' + left + 's）', true);
      }
    }, 1000);
  } catch (e) {
    setSendButton('发送验证码', false);
    setHint('login-hint', 'error', e.message);
  } finally {
    S.sending = false;
  }
}

async function doLogin() {
  const phone = ($('login-phone').value || '').trim();
  const code = ($('login-code').value || '').trim();
  if (!/^1[3-9]\d{9}$/.test(phone)) {
    setHint('login-hint', 'error', '先填 11 位手机号');
    return;
  }
  if (!/^\d{4,8}$/.test(code)) {
    setHint('login-hint', 'error', '验证码是 4–8 位数字');
    return;
  }
  const btn = $('login');
  btn.disabled = true;
  btn.textContent = '登录中…';
  setHint('login-hint', '', '正在登录…');
  try {
    const data = await call('/login/verify', { method: 'POST', body: { phone: phone, code: code } });
    setHint('login-hint', '', data.message || '登录成功');
    closeLoginDialog();
    show('登录成功：vuid ' + (data.vuid || '?'));
    await loadAccounts();
  } catch (e) {
    setHint('login-hint', 'error', e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录并保存';
  }
}

/* ---------------- 事件 ---------------- */

$('refresh').addEventListener('click', () => loadAccounts());
$('add-account').addEventListener('click', openLoginDialog);
$('login-close').addEventListener('click', closeLoginDialog);
$('login-cancel').addEventListener('click', closeLoginDialog);
$('send-code').addEventListener('click', sendCode);
$('login').addEventListener('click', doLogin);

$('login-dialog').addEventListener('click', (e) => {
  if (e.target === $('login-dialog')) closeLoginDialog();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('login-dialog').hidden) closeLoginDialog();
});

$('status').addEventListener('click', () => withBusy($('status'), async () => {
  const data = await call('/tasks');
  showLines(data.lines);
  setState('success', '已连接');
  await loadAccounts(true);
}));

$('run').addEventListener('click', () => withBusy($('run'), async () => {
  show('正在结算今天的任务（后台执行，关掉这个页面不会中断）。\n观看类同一任务两次之间隔 35–50 秒（任务要求看 30 秒），\n点赞/分享/签到之间只隔几秒，整轮约 5 分钟。\n\n结果会写进面板日志；想在这里看就稍后回来刷新。');
  const data = await call('/do-tasks', { method: 'POST', body: { likeFirst: true } });
  showLines((data.lines || []).concat([data.message || '']));
  setState('success', '已完成');
  await loadAccounts(true);
}));

$('cookies').addEventListener('click', () => withBusy($('cookies'), async () => {
  const data = await call('/cookies');
  show(data.netscape);
}));

loadAccounts();
