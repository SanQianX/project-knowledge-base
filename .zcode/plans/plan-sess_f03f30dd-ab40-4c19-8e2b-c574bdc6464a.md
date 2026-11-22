# 皮肤系统 · 首期（①配色预设 ＋ ②自定义颜色与皮肤包）

## Context

外壳全部颜色由 `ui/product.css` 的两组 CSS 变量驱动（浅色 [ui/product.css:1](ui/product.css#L1)、深色 [ui/product.css:9](ui/product.css#L9)），现行是统一的冷蓝灰「钢青」系（暗色底 `#171a1f`、浅色底 `#f3f5f7`、强调色 `#516f89` 饱和度约 26%），用户观感「不是纯黑纯白、颜色怪」。目标：本期落地皮肤系统前两级——①内置「纯净黑白 / OLED 纯黑 / 钢青」三预设（**纯净黑白为默认**）；②自定义取色 + 皮肤 JSON 导入导出 + 服务端持久化。壁纸/视频/GitHub 导入（③④）与 iframe 颜色同步（⑤）为后续阶段，本期只做格式预留。桌面薄壳加载同一 Web UI，自动生效。

## Step 0 · 交互预览（先看效果，再动代码）

在会话可视化目录（非项目内）生成可交互外壳 mockup：可切换 配色预设 × 5 种内置壁纸 × 遮罩浓度 × 卡片实度 × 毛玻璃 × 强调色，含弹窗半透明示例，演示「壁纸只铺页面背景+侧栏两个大面、卡片弹窗半透明实色（毛玻璃可开）」的分层设计。默认组合：纯净黑白 · 深色 · 星穹夜 · 毛玻璃开。视觉方向确认后进入代码实施；预览可按反馈先迭代。

## Step 1 · ① 三套预设（默认纯净黑白）

- `ui/product.css`：token 定义重构为按 `html[data-skin]` × `[data-theme]` 组合的三预设块——`pure`（中性纯白 `#fff`/纯黑系，默认）、`oled`（dark 时 `#000` 纯黑，light 同 pure）、`steel`（现值原样保留为可选预设）。无 `data-skin` 时回退 `pure`。
- `ui/index.html`：`<html>` 加 `data-skin="pure"` 初始值（启动时由 JS 按服务端 appearance 覆盖）。
- `ui/product.js`：新增 `applyAppearance()`——设 `data-skin` 并按当前主题应用 token 覆盖；主题切换（[ui/product.js:714](ui/product.js#L714)）与 `kb:theme` iframe 广播逻辑不动，切换主题时重套覆盖值。

## Step 2 · ② 服务端持久化

- `_site/lib/settings-store.js`：`defaultSettings()` 增加 `appearance: { preset: 'pure', overrides: { light: {}, dark: {} } }`；`validateSettings` 白名单校验——preset ∈ {pure, oled, steel}，token 名限现有 15 个 CSS 变量，颜色值 `#rrggbb` 正则，结构深度固定（参考现有 brain/logging 校验风格）。
- `_site/lib/server-app.js`：在 `/api/brain`（约 :935）旁新增 `GET/PATCH /api/appearance`，PATCH 走 `settingsStore.updatePatch({ appearance })`；`registryEvents` 发布正则（:873）加入 `appearance$`，与 brain/settings 写入行为一致。
- 皮肤包格式定为 `kb-skin/v1`：`{ name, preset, tokens: { light, dark } }`（name ≤100 字符；预留未来 `background` 字段位，本期不实现）。

## Step 3 · ② 设置 UI + 皮肤导入导出

- `ui/index.html`：系统抽屉新增「外观与皮肤」section——预设 select、明/暗两档取色器（核心 4 色：页面底色/卡片/文字/强调色；「更多」展开 line/muted/good/bad）、改色即时预览、「恢复默认」。
- `ui/product.js`：启动时 `GET /api/appearance` 应用；保存 `PATCH`；「导出皮肤」下载 `kb-skin/v1` JSON；「导入皮肤」本地文件解析后仅提交 tokens/preset 由服务端校验落库（客户端不执行任何皮肤内代码）。安全边界：不接受任意 CSS，只收白名单颜色字段。

## Step 4 · 回归测试

- 新增 `_site/_test/appearance-settings-test.js`：settings-store 校验（合法/未知 preset、非法 token 名、非法 hex、结构注入拒绝）+ `/api/appearance` GET/PATCH 路由行为，复用现有测试基建风格（参考 `server-security-test.js`）。
- `npm test` 全量回归（`_site/_test/run-all-tests.js`）。

## 本期不做（已定决策记录）

- ③ 壁纸图片/GIF/视频与 WE 创意工坊扫描、④ GitHub URL 导入与皮肤库——皮肤格式已预留扩展位。
- ③ 落地时**毛玻璃默认开**（用户已确认），壁纸只铺「页面背景 + 侧栏」，卡片弹窗半透明实色。
- ⑤ iframe token 同步——`kb:theme` 二值协议本期不动，四个内嵌模块不受影响。

## Verification

1. `npm test` 全量通过（含新增 appearance 测试）。
2. `npm start` 手动验证：默认纯净黑白；三预设切换；明暗切换后自定义颜色仍正确套用；取色→保存→刷新浏览器配置保留；皮肤导出→清空→导入还原；弹窗/抽屉/Toast 颜色跟随；四个 iframe 模块（工作台/检索/会话/引擎）明暗跟随正常。
3. 桌面薄壳打开同 URL 验证皮肤生效。