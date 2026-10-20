# 05 · 真实UI、视觉、性能、负载与故障测试

## 分层证据，不替换概念

L1函数/后端合同：原生suite。L2真实浏览器外壳＋可控模块故障：本包browser-shell。L3四模块真实集成、真实模型/embedding与原生客户端：必须现场适配。L4安装制品上的同样链路：固定RC验收。通过L2不能表示L3/L4通过。

`browser-shell.cjs`使用CDP Input.dispatchMouseEvent、Input.insertText，先滚动并elementFromPoint验证目标未遮挡；不是document.click。会在4视口×2主题×6页保存截图，并以真实Git/登记/Hook验证导入，但四模块503为故障替身。原生Windows文件夹对话框、真实模型和所有Dock内部控件未由此脚本覆盖。

## 视觉基线

批准前冻结：OS/浏览器完整版本、字体渲染环境、viewport、deviceScaleFactor、真实浏览器缩放（不要把CSS zoom当等价）、主题、locale/timezone、fixture和source版本。字体/动画/时间字段漂移先消除原因；对合理动态区域只允许小范围、列明原因的掩码，禁止遮住全部输出获得绿图。

流程：源版本截图→人工检查和批准→保存SHA及环境ID→候选同环境截图→像素差异图＋DOM几何/点击/焦点测试→审查。初始基线可能已经含Bug，像素相同只说明没变，不说明好用。意图明确的UI修复通过验收后才能独立批准新基线，绝不自动update-snapshots。

本包零依赖PNG比较支持8位RGB/RGBA、非隔行。其它格式会拒绝，不擅自低质转换。
```powershell
node tools/visual-compare.cjs baselines/approved.png artifacts/current.png baselines/approved.json 'win-chrome-verified-env' artifacts/visual-diff
```
approved.json必须包含approved、environmentId、图片sha256、channelTolerance、maxChangedRatio，阈值由人工定。输出diff.png/comparison.json只是单图比较，不是全产品视觉PASS。

## 性能基线和统计

先定义每个场景的fixture规模、冷/热启动、缓存策略、采样点、并发、持续时间、预热和资源背景。基线与候选交替运行至少5个独立重复样本，保存原始数据、环境及时间；P95/P99需足够请求量，小样本不能用P99讲精度。长任务延迟把模型外部服务、服务排队、后端处理和UI渲染分别计时。

基线不能成为“当前本来很慢也算正常”的借口：同时定义可接受的绝对体验目标和相对回归阈值，标明谁确认。未批准阈值时只报MEASURED_NOT_ACCEPTED。关键场景：首页可交互、项目切换、长会话滚动、Dock开关、日志分页、检索、后台维护前台响应、静置网络请求数。

本包performance工具只做**有界loopback只读HTTP测量**，允许health和aggregated、20–2000样本、1–8并发。不能把它当成完整压力/内存泄漏测试：
```powershell
node tools/performance.cjs config/performance.local.json artifacts/performance-run.json
```
config需由控制端验证实例PID/startTime/dataDir/source SHA，填写ownedInstanceVerified、identityReceipt、environmentId、fixtureHash、route、count、concurrency。单纯布尔字段不等于身份校验。服务root和fixture仅属于本轮。

## 长时/负载扩展

现场增加独立脚本采样所属PID树的CPU/RSS/heap、event-loop延迟、handle/socket/listener计数、UI DOM数量，按启动/预热/稳态/结束/空闲恢复分阶段记录。浏览器多标签要真实创建，例如1→2→4→8；Node WebSocket连接数不能替代浏览器同源行为验收。

工作负载分开：项目数/日志数/知识文档量/Commit事件率/会话与面板数；不同时增加多个变量。系统设计并发2不代表收到第3个任务就是Bug，应检查正确排队、背压、内存有界和退出恢复。大规模模型负载使用协议一致的可控替身，真实模型另设明确调用预算。不得用测试流量打外部服务做压力。

Soak先做有界短批确认无严重问题，再延长至批准窗口；磁盘可用空间、内存、外部调用成本触发熔断。每轮测试时间预算与额度管理是两回事。

## 故障矩阵

针对真实生命周期注入：导入预检和登记之间Hook变化；commit通知丢失；持久claim前后进程中断；staging校验失败；晋升日志落盘前后中断；索引失败；SSE游标重复/缺口/失效；模块端口变更；权限拒绝；UI离线；控制器/Agent中途退出。

每项写清注入点、预期安全状态、恢复步骤、不得变化的哈希与资源释放。仅允许故障注入fixture服务。不能强杀来源不明PID，不能对生产磁盘制造写满，也不能为了重现而破坏第三方配置。

完整性能、soak、原生客户端/四模块E2E属于T06/T10现场实施及验收；本包没有假造这些场景的通过报告。
