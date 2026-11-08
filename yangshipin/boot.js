// 启动时同步主题，必须赶在第一帧之前。
//
// 插件页在面板的 iframe 里是另一个 document：面板挂在 <html> 上的
// data-theme 不会自动传进来，而 /css/theme.css 是按
// :root[data-theme='light'] 选浅色变量的。不自己同步，面板切浅色后
// 插件页会一直停在深色。
//
// 面板把主题存在同源 localStorage 的 panel-theme-v2 里；iframe 和面板
// 共享 localStorage。父页面修改这个键时，本文档会收到 storage 事件，
// 所以不用轮询，也不用面板额外发消息。
(() => {
  'use strict';

  const THEME_KEY = 'panel-theme-v2';

  function readTheme() {
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved === 'light' || saved === 'dark') return saved;
    } catch (e) { /* 隐私模式/存储被禁 */ }

    // 兜底：同源 iframe 可以直接看父页面的 data-theme。
    try {
      const parentTheme = window.parent.document.documentElement.getAttribute('data-theme');
      if (parentTheme === 'light' || parentTheme === 'dark') return parentTheme;
    } catch (e) { /* 跨域或父页面还没挂载 */ }

    // 面板没存过主题时默认 dark。
    return 'dark';
  }

  function applyTheme() {
    document.documentElement.dataset.theme = readTheme();
  }

  applyTheme();

  // 面板切主题 -> localStorage 变化 -> 本文档即时跟随。
  window.addEventListener('storage', (e) => {
    if (!e.key || e.key === THEME_KEY) applyTheme();
  });

  // 有些面板实现只改父页面 data-theme、不一定写 localStorage；
  // 同源时再观察一下，作为第二道兜底。
  try {
    const parentRoot = window.parent.document.documentElement;
    new MutationObserver(applyTheme).observe(parentRoot, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
  } catch (e) { /* 跨域时忽略 */ }

  if (new URLSearchParams(window.location.search).get('embed') === '1') {
    document.documentElement.dataset.embed = '1';
  }
})();
