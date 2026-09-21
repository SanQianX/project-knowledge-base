# UI_VISUAL_ACCEPTANCE.md

## Authority

Reference: `project-knowledge-base-faithful-repair-ui-v10.html` supplied by the user, plus v13 product decisions. The HTML is a structural/visual baseline, not a mandate to copy demo/technical wording.

## Mandatory viewports

- Desktop: 1920×1080, 1440×900, 1366×768.
- Mobile: 390×844.
- Narrow desktop/tablet: 820×900 (or closest deterministic browser viewport used by test harness).
- Run light and dark mode where applicable.

## Required screenshots / rendered states

1. Main Control Center shell with project sidebar.
2. Claude Workbench with user/assistant/tool card and composer.
3. Import project default and validation/empty state.
4. Settings default AI model page.
5. Settings → Knowledge storage / relations.
6. Settings → 开发对话: normal, long Prompt/Reply, empty date, no active project fallback.
7. Settings → 日志: 200+ mixed rows, warn/error/fatal, detail expanded, scrolled-up + new-record banner.
8. Mobile Settings nav and conversation/log pages.
9. Project delete modal / client controls that remain supported.

## Development Conversation contract

Visible controls at the top are **exactly**:
- 项目: one project only, default current project; no 全部项目.
- 日期: one day, default today.

Must NOT exist:
- 来源 / 全部来源 / Claude/Codex/OpenCode filter.
- Session sidebar/filter/ID.
- Search.
- 时间线/Commit 视角 switch.
- Bridge/provider/schema/debug badges or technical explanatory blocks.
- Duplicate entry in main desktop nav, mobile main nav, or Desktop Client settings.

Default rows show time, user Prompt, AI reply and restrained commit label: 已提交 / 关联提交 / 未提交 + short SHA. Internal source/session/turn/binding enum may exist in DOM data only if not visible and required by accessibility/testing.

### Conversation bounding-box checks

For every viewport:
- Turn card body is within Settings content rectangle.
- Long unbroken paths/URLs/code wrap without horizontal page scrollbar.
- Project/date toolbar does not overflow; on mobile both remain usable without a second Session/sidebar column.
- Footer commit labels do not cover message text.
- List owns its inner scrolling when content exceeds available height.

## Logs mature product contract

Toolbar: date, project, record scope, display limit, search, export. No live badge, no Level column, no INFO:/DEBUG:/TRACE: prefixes, no severity dot/icon/bar, no autoscroll switch, no retention/path/capacity cards.

Colors:
- trace/debug/info neutral; trace/debug may be muted.
- WARN: entire row text including message/meta/time amber/yellow.
- ERROR/FATAL: entire row text including message/meta/time red; message may be slightly bolder.
- Do not use high-saturation row background as severity carrier.

Geometry:
- Desktop row grid: `minmax(0,1fr) 88px`, gap ~18px.
- Mobile: `minmax(0,1fr) 76px`, gap ~12px.
- Main/meta have min-width:0/overflow protection; time is nowrap.
- Automated `getBoundingClientRect()` must assert `body.right + gap <= time.left` for 200+ rows including pathological long project/component/message text.

Height/scroll:
- Drawer → settings-content → active logs section → logs card → record shell forms a flex/min-height:0 chain.
- No hard `max-height:520px`.
- Drawer/header/toolbar/footer remain structural; only record list gets vertical scroll in logs view.
- At 768 and 1080 viewport heights, record shell reaches Settings content bottom (minus padding) and there is no double vertical scrollbar.
- When user scrolls away from bottom, new SSE rows append without forcing scroll; a restrained “有 N 条新记录” action returns to bottom.

## Full shell regression

Production may restore v4.1.22 structure only; APIs/storage/security remain current/v13. Ensure:
- Sidebar project selection, Workbench, Import, Settings reachable.
- No standalone logs-only application shell.
- No manual Hook/analysis buttons.
- AI Profile/model, Knowledge Root, relations, supported desktop/client controls remain.
- Do not copy preview technical text such as “Backend-driven project supervision console” or “统一对话事件流” unless the final product copy independently justifies it; prefer concise user-facing copy.

## Visual gate execution

For each UI commit:
1. Start a deterministic local test server/fixture.
2. Capture reference states and implementation states at identical viewport/theme/data.
3. Run DOM contract assertions.
4. Run bounding-box/scroll assertions.
5. Review screenshots for spacing, density, hierarchy, clipping, z-index, unexpected scrollbar, debug-style leftovers.
6. Any material mismatch from v13 contract blocks commit. Pixel-perfect matching is not required where the preview uses mock content; product hierarchy/behavior is required.
