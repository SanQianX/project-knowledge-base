'use strict';
/* 版本与模块（R2 简化版）——左上角商标悬停版本提示的取数脚本。
 *
 * 一次性读取 GET /api/system/version（当前 Project Knowledge 服务进程的
 * package 版本），填入 #brandVersion 显示「知识库 vX.Y.Z」。失败时诚实显示
 * 「知识库 版本未知」；不重试、不轮询、不阻塞页面其他部分，也不做任何
 * 模块聚合/桌面版本猜测。展示/隐藏完全由 version-info.css 的 hover/focus
 * 规则承担。 */
(function () {
  const label = document.getElementById('brandVersion');
  if (!label) return;
  fetch('/api/system/version', { headers: { Accept: 'application/json' } })
    .then(response => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    })
    .then(payload => {
      const version = payload && payload.core && payload.core.version;
      label.textContent = version ? `知识库 v${version}` : '知识库 版本未知';
    })
    .catch(() => {
      label.textContent = '知识库 版本未知';
    });
})();
