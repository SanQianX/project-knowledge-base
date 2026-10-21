# 03 · 测试用例矩阵

共130个规格，初始全部NOT_RUN。它们不是130个已实现自动脚本。实际实现状态必须按 config/test-cases.json 更新独立的运行结果文件，不改规格来凑通过。

既有套件映射是候选覆盖，先读该测试实际断言。子集、Mock、原生客户端与真实模型层分别报告。

## NAV-001 · 六页导航

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：依次点击六个 data-view 导航按钮，再刷新每个 hash 页面。

断言：只有当前 view active。 标题、hash、选中导航一致。 没有额外业务写入。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-002 · 主题同步

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在浅/深主题间切换，再切换三个内嵌模块并刷新。

断言：外壳主题持久化。 已就绪 iframe 收到 kb:theme。 不能因主题切换重建任务。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-003 · 空项目

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用新数据目录，打开工作、检索、领域与项目。

断言：展示空状态。 不能将未知/读取失败当作空库。 不创建占位项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-004 · 失败保留旧数据

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已有项目后令登记查询失败，再恢复。

断言：错误可见。 旧列表不清空。 恢复后以新快照更新。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-005 · 项目快速切换

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：准备 A/B 两个独立项目，快速 A→B→A 并延迟旧响应。

断言：只展示当前项目。 迟到响应不跨项目覆盖。 实际 contextId 映射正确。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-006 · 可操作性

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：原生指针点击按钮；Tab/Enter 遍历主要表单，检查遮挡。

断言：命中测试通过。 输入焦点可见。 没有透明层拦截。 不使用 DOM.click 代替。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-007 · 分辨率矩阵

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在4个桌面视口、两种主题检查六页截图及 bounding rect。

断言：无非预期水平溢出、控件遮挡。 截图人工基线与像素检查分别报告。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## NAV-008 · 断网恢复

模块：产品外壳；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/index.html; ui/product.js:1-120,670-835`。候选已有套件：`smoke`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：数据加载后模拟浏览器 offline 再 online。

断言：关闭旧流，恢复快照及新流。 不重复订阅。 内容不伪装实时。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-001 · 领域创建

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：领域与项目→创建领域→输入名称→明确提交→刷新。

断言：领域存在并持久化。 空名称拒绝。 不创建新的 Git 项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-002 · 导入完整预检

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：新 Git fixture→填写代码/知识路径→确认导入。

断言：预检通过才启用确认。 四模块分别报状态。 源码HEAD不变、历史不分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-003 · 缺知识根返回表单

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：未配知识根时填写导入，点击设置知识根，保存再返回。

断言：原输入和导入ID保留。 不会误建两个项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-004 · 中文空格路径

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用中文及空格路径的 Git 仓库导入并重启。

断言：路径标准化正确。 Hook可运行。 绝对知识路径一致。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-005 · 重复导入

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：同一个路径导入两次，再用路径大小写/分隔符别名试一次。

断言：拒绝重复登记。 不破坏已有项目数据。 别名按平台合同判断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-006 · Hook竞态冲突

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：预检通过后在测试仓库写第三方Hook，再点击确认。

断言：HOOK_CONFLICT。 第三方字节保持。 UI operationId能查真实失败日志。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-007 · 部分模块离线

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：四模块均返回503时导入，再只恢复一个模块并修复接线。

断言：登记保留，真实模块状态仍失败。 仅补失败模块，不重复登记。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-008 · Git初始化确认

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：选择不是Git的测试目录，分别不勾选与勾选初始化。

断言：未明确勾选不得 git init。 初始化只发生在用户选中fixture。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-009 · 解绑写入保护

模块：项目与领域；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：准备排队任务和正在写入任务，分别请求解绑。

断言：排队任务按合同取消。 活动writer阻断解绑。 保留磁盘代码、知识、会话。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-010 · 解绑迟到读

模块：项目与领域；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：让登记GET挂起，解绑完成后再返回旧GET。

断言：旧响应不能复活项目。 刷新后仍解绑。 其他项目不受影响。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-011 · 领域变更

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：变更项目所属领域后发起项目/领域检索。

断言：作用范围随登记更新。 知识文件绝对路径不移动。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## PRJ-012 · 导入失败重试

模块：项目与领域；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:580-835; _site/_test/product-import-ui-test.js`。候选已有套件：`project`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入成功但刷新失败，与导入本身失败分别注入。

断言：前者不能再建项目。 后者保留错误和opID并允许受控重试。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-001 · 首次导入基线

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入有多条历史提交的仓库，观察后台任务与文件。

断言：只建基线。 不分析历史、不生成伪知识、不改源码。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-002 · 真实Hook闭环

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入fixture→新增真实git commit→等待journal→claim→晋升→查询。

断言：按完整SHA绑定证据。 Markdown与检索引用一致。 不能直接API造任务替代Hook验收。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-003 · 空仓首提交

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：导入空仓后作第一次提交。

断言：第一次后续提交可处理。 无HEAD阶段不假装已有分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-004 · 重复事件

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：同一SHA重复通知、多次journal消费与启动对账。

断言：只产生一次有效分析/晋升。 重复接收日志不等于重复执行。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-005 · 单项目顺序

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：连续提交A/B/C，令B失败。

断言：A成功、B失败、C等待。 不能越过B宣告分析到C。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-006 · 跨项目并发

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：两个或更多fixture提交并观察调度。

断言：按当前实际并发上限排队。 项目之间无文件串写。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-007 · 离线提交补偿

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：仅停测试服务，Git提交成功后再启动。

断言：Git不被Hook故障阻塞。 启动对账补漏。 已完成SHA不重跑。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-008 · staging越界

模块：知识引擎与Git维护；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：让测试Agent产物包含../、绝对路径、非允许类型。

断言：晋升拒绝。 最终知识与源码哈希不变。 失败证据保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-009 · 晋升中断恢复

模块：知识引擎与Git维护；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在许可的故障注入点中断测试writer，再重启。

断言：journal恢复一致。 不留下半晋升的假成功。 pointer顺序正确。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-010 · 索引独立失败

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Markdown晋升成功后令向量服务失败。

断言：知识已更新/索引待修复分开。 不回滚Markdown、不重复付费分析。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-011 · 故障重试

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：UI点击指定run重试，连续双击与网络响应丢失分别测试。

断言：同一意图不会重复派发。 活动状态正确。 请求结果未知先查询。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## ENG-012 · 分析来源排除

模块：知识引擎与Git维护；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/lib/server-app.js:1-45; README.md运行合同；对应原生测试需本地阅读全文`。候选已有套件：`engine`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：内部维护任务与真实用户任务使用不同origin，读取采集事件。

断言：维护/委派不能自动成为人类长期偏好。 C01未定项不得自动删除实现。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-001 · 源码版本匹配

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对本地模块package、锁文件、runtime manifest和源码commit。

断言：每一文件所有权可追溯。 不匹配则BLOCKED_SOURCE_MATCH。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-002 · 独立宿主

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：使用0.13.6真实最小宿主配置模型并对话，再在宿主中重复。

断言：模块不依赖知识库业务对象才能工作。 集成上下文单独验证。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-003 · 真实模型抽测

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：配置订阅模型并发送唯一随机事实问题，记录请求及回答。

断言：模型返回的确是MiniMax-M3.1-Flash。 无替身。 响应与本轮关联。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-004 · 连续回复次序

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Q1结束后立即Q2，注入Q1迟到结果。

断言：Q1正文不重复在Q2后出现。 不能把Q2错误标idle。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-005 · 草稿隔离

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A输入1111，B输入2222，切换/刷新/重启测试服务。

断言：草稿分别恢复。 附件按当前会话生命周期，不跨项目泄漏。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-006 · 权限拒绝

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：要求测试Agent执行受保护操作，选择Deny。

断言：真实工具未执行。 UI错误与拒绝回执一致。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-007 · 用户问题选择

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：触发单选/多选/自定义问题，先不提交再提交。

断言：必须由真实选择确认。 bypass工具权限不能代选、空答或放行。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-008 · 中止隔离

模块：Workbench真实对话；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A/B同时执行，只中止B。

断言：B按协议终止，A继续。 不得停止未知服务/进程。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-009 · 流式重连

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：输出中断网，恢复后先取快照再续游标。

断言：无重复正文/遗漏。 不能重发已接受输入。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-010 · 长历史阅读

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：生成长对话后向上滚动，同时持续输出。

断言：不强制跳到底。 合理DOM/内存增长。 焦点不丢失。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-011 · 主回复与后台

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：主回复结束但两个子任务仍运行时继续输入。

断言：按当前合同主输入可用。 后台卡片仍真实运行，不能仅从文字猜启动。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## WB-012 · 停止服务恢复

模块：Workbench真实对话；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`宿主锁定0.13.6；独立默认分支0.3.0不得充当同版本源码；ui/product.js iframe合同`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在测试进程停启后恢复会话历史。

断言：会话ID、事件序号、任务历史归属正确。 真实会话状态非端口在线推断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-001 · 右上角显示隐藏

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：按当前实现定位右上角显示/隐藏按钮，循环切换。

断言：不改变会话和任务。 按钮实际可点。 缺实现先标需求差异。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-002 · 标签生命周期

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：打开两个不同标签，切换、关闭一个，再打开。

断言：状态按panelId隔离。 关闭释放监听器。 不关闭主会话。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-003 · 知识被动刷新

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：Dock关闭时让知识缓存更新。

断言：不得自动开标签或展开Dock。 只有用户导航才打开。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-004 · 知识重新注册

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：重载Workbench iframe后再打开知识引用。

断言：重新完成panel/register握手。 过期panelId不可误送。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-005 · 知识项目快速切换

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A引用加载期间切换B并返回A。

断言：epoch和projectId匹配。 知识文本不串项目。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-006 · 子代理控制台

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：启动真实子任务，显示控制台与完成历史。

断言：显示真实事件。 失效请求可只读重试，不重复委派。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-007 · 标签异常和恢复

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：面板超时/断网后恢复，关闭再打开。

断言：错误可见，主聊天继续。 销毁超时回调。 不持续重建iframe。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-008 · 来源安全

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：从未知iframe或错误origin发送kb:panel消息。

断言：被拒绝。 不能注册任意URL/访问宿主私密上下文。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-009 · 浏览器与代码审查

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：查0.13.6注册清单，再按实际实现操作面板。

断言：仅有源码证据才纳入必测已实现项。 规划功能标PLANNED非Bug。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## DOCK-010 · 多标签压力

模块：右侧工作区；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:14-120,684-708；模块运行包同版本源码待匹配`。候选已有套件：`workbench`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：在设计上限内反复开关面板并记录监听器/内存。

断言：关闭后的资源释放。 真实浏览器连接限制单独验收。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-001 · 文本检索

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：植入带唯一事实的已晋升测试Markdown，通过知识检索输入查询。

断言：命中正文和真实引用。 不能把模板占位当事实。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-002 · 真实向量

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：配置真实embedding，构造不共享关键词的语义查询。

断言：检查非空向量与真实通道证据。 文本回退不算向量PASS。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-003 · 作用域隔离

模块：知识检索与范围；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：A/B项目、同/不同领域设计互斥事实，切scope。

断言：项目/领域/brain返回集合符合授权范围。 未知项目不借别人的上下文。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-004 · 引用定位

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：点击结果引用，读取正文并复制引用。

断言：相对条目和完整提交来源对应当前结果。 不可路径越界。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-005 · 模型停用

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：停用embedding再查询。

断言：真实Markdown回退可见。 不删知识、不称向量成功。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-006 · 索引根切换

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：修改全局知识根，在旧索引有写入时执行。

断言：旧数据保留、排空旧writer、后续新根重建。 项目知识不被搬移。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-007 · 新提交检索一致

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：真实提交分析后在下一轮会话检索该事实。

断言：完整SHA、项目、正文及索引链匹配。 不是只匹配SHA字符串。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## RET-008 · 检索负载

模块：知识检索与范围；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js iframe/scope合同；vector-hub固定1.0.8-rc.8`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：固定语料与查询集合进行基线/候选交替重复测量。

断言：语义召回与延迟同时评价。 不同语料/硬件不得比较为回归。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-001 · 手动添加

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：长期记忆→添加→内容/作用域/目标→确认。

断言：POST真实保存为confirmed。 刷新后保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-002 · 空白拒绝

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：输入纯空白或缺目标尝试确认。

断言：前后端均拒绝。 不出现空记忆。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-003 · 候选保留

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：编辑候选点击保存候选而不确认。

断言：仍为candidate。 不能注入长期任务偏好。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-004 · 确认目标

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：切换global/domain/project并更换目标后确认。

断言：scopeId与scopeType匹配。 只影响指定范围。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-005 · 忽略候选

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：点击忽略并刷新，检查原始来源记录。

断言：状态ignored。 来源冻结记录不篡改。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-006 · 同步失败

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：confirmed保存后注入写文件失败。

断言：sync pending真实显示。 未同步内容不注入任务。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-007 · 真实注入

模块：长期记忆；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：新增唯一约定，在下一真实模型任务检查引用和采用。

断言：区分prepared、output、delivery、actual use四层证据。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## MEM-008 · 来源边界

模块：长期记忆；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:670-780`。候选已有套件：`retrieval`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：委派Agent指令/系统维护输出诱发记忆候选。

断言：不得自动当作人类长期偏好。 C01未解决项明确阻断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-001 · 三能力独立

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：检查Knowledge Integration、Automatic Context、Development Capture。

断言：检测到命令不等于已安装。 三能力分别真实验证。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-002 · 原生Claude采集

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：隔离客户端HOME安装托管Hook，重开会话后外部开发。

断言：仅新会话事件按真实Git目录归属。 不补捏历史。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-003 · 原生Codex采集

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：隔离Codex配置与notify链，执行开发并检查记录。

断言：保留第三方notify和用户信任。 拒绝自动写trust。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-004 · 原生OpenCode

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对真实插件入口，在fixture发消息和提交。

断言：只报告实际支持能力。 不可声称自动注入已通过。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-005 · 原生ZCode

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：按同版本真实入口接入，检查采集与上下文区别。

断言：没有证据不报MCP成功。 保留第三方配置。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-006 · 修复幂等

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：连续两次接入/修复同一客户端。

断言：不叠加Hook、不重复notify wrapper。 operationId可追踪。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-007 · 移除保留

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：移除采集集成后查看配置diff和历史文件。

断言：只撤托管项。 第三方及历史记录保留。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-008 · 跨仓隔离

模块：外部Agent集成；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：相同basename不同真实路径A/B开发会话并行。

断言：以canonical身份隔离，不串对话/Commit。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-009 · 配置自动修复

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已接入客户端配置损坏后重启隔离服务。

断言：仅修复曾授权托管部分。 未知命令冲突则阻断而非覆盖。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## CAP-010 · 真实送达

模块：外部Agent集成；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:480-560; plugins/project-knowledge; 外部客户端逐项现场验证`。候选已有套件：`capture`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已确认上下文注入后，模型引用任务事实并实际使用。

断言：单凭Hook日志或output事件不足以声明送达。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-001 · 活动分页

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：生成多页知识run，切页并打开详情再更新。

断言：按游标稳定分页。 打开详情不被刷新重置。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-002 · 失败重试状态

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：制造quota耗尽/前序失败/索引pending等状态。

断言：文案区分真实原因。 状态不能都显示已成功。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-003 · 日志查询

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：系统状态→诊断，输入唯一operationId，选择当前项目。

断言：GET返回与UI一致。 不含其他项目敏感信息。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-004 · 日志实时续接

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：无搜索时订阅流，查询+订阅交界插入日志。

断言：streamCursor无缝续接，不丢失或重复。 关闭弹窗断开流。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-005 · 日志上限

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：持续写入超过100条可见日志。

断言：当前界面保持有界节点。 历史仍可查询而非静默永久丢失。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-006 · 导出脱敏

模块：活动与诊断；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：写入假密钥到嵌套error/context字段，导出诊断。

断言：写/查/导出均脱敏。 不能在测试报告保存原真密钥。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-007 · 高级过滤核对

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：分别核对API日志级别、时间、component字段与当前UI控件。

断言：API支持不等于UI已提供控件。 README与DOM差异记录而不造按钮。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## LOG-008 · 网络失败反馈

模块：活动与诊断；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`ui/product.js:535-580,710-745; logging API原生tests`。候选已有套件：`logging`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：查询超时和导出失败分别触发。

断言：UI显示失败。 不能生成空文件冒充成功导出。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-001 · 四模块健康

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：启动隔离实例，分别观察外壳及四模块ready。

断言：端口在线不等于全部模块就绪。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-002 · 维护默认模型

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：保存后台默认后临时切聊天模型，再启动维护。

断言：后台默认不随临时聊天选择变化。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-003 · 凭据留空

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：已有embedding凭据后留空保存，再读取mask元数据。

断言：留空不覆盖。 响应、日志不泄露secret。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-004 · 知识根路径

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：修改全局root再导入新项目，比较已有项目knowledgePath。

断言：新导入使用新root。 旧项目固定路径不改变。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-005 · 端口冲突

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：占用默认端口再CLI启动隔离实例。

断言：按实际协议选择/报错。 Hook使用记录端点非写死端口。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-006 · 停止指定实例

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：两个独立数据目录启动，停止其中一个。

断言：只停验证过的目标。 独立模块/其他实例保持。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-007 · Origin防护

模块：设置与生命周期；优先级：P0；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：对隔离实例发错误Origin及非回环未认证请求。

断言：拒绝不允许来源。 不得为了E2E改成通配CORS。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-008 · 请求边界

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：测试无效JSON、超长输入、路径越界。

断言：返回确定错误、不崩溃。 不写入非目标目录。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-009 · Windows恢复

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：服务/浏览器/控制器重启后对照持久化和PID身份。

断言：不得按旧PID误杀重用进程。 失去归属证明先阻断。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## SYS-010 · 桌面范围

模块：设置与生命周期；优先级：P1；层级：SOURCE_GUIDED_PROCEDURE；状态：NOT_RUN。

来源：`_site/server.js; _site/lib/server-app.js:1-180; ui/product.js:580-835`。候选已有套件：`lifecycle`。

前置：使用独立测试数据和受管实例；冻结source/module/fixture身份；不得复用用户HOME与生产凭据。

操作：核对当前桌面package依赖和发布合同，仅测仍支持功能。

断言：不把历史桌面功能恢复当本轮必做。 网页候选不冒充桌面发布。

证据：实际命令与退出码；UI/接口/磁盘对应证据；源HEAD/文件哈希/测试夹具ID。清理：先停止并核对自有测试进程；保留首失败证据；仅清理已过保留期且PASSED的拥有标记目录。

## QTA-001 · 账户识别

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：核对订阅Key、CLI地区、实际模型行及周权益。

断言：不能把PAYG余额当五小时额度；保护旧套餐权益。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-002 · usage字段歧义

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：回放只有usage_count的响应，再回放带明确百分比响应。

断言：无语义证据时UNKNOWN；明确百分比优先。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-003 · 低额度停止

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：80→19→9配额注入，分别尝试派发任务与单次请求。

断言：19不派新任务；9不转发新模型调用；保护在途请求。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-004 · 额度恢复

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：暂停后两次新鲜80%样本，恢复原任务检查点。

断言：恢复只执行未完成动作；不是睡固定5小时。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-005 · 查询故障

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：模拟401、429、503和超时。

断言：分别分类，UNKNOWN拒绝新调用；不切PAYG或自动买积分。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-006 · 共享消耗

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：另一客户端快速消耗同一订阅，观察采样陈旧性。

断言：安全裕量不足提前暂停；承认单次在途调用无法保证永不耗尽。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-007 · 进程重启

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：停止控制器，保留checkpoint+journal，再启动。

断言：校验journal链；活动worker/Git操作状态未知时先对账不重发。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## QTA-008 · 绕过防护

模块：额度与恢复；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：worker尝试读真实订阅/Git/npm凭据、改控制合同或直接连上游。

断言：真实OS ACL/网络策略拒绝；布尔配置和提示词不算隔离证据。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-001 · 原始改动保护

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：原工作区有未提交或本地领先远程提交时执行baseline。

断言：只报告并阻断；不reset、stash、覆盖或假称已冻结未提交改动。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-002 · 基准远程验证

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：独立clone后创建非v基准tag与QA分支并核对ls-remote。

断言：tag解引用与分支均为完整基准SHA；不能把操作命令成功当远程完成。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-003 · 测试凭证失效

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：测试后修改一个源码字节或合同，再试提交。

断言：fingerprint/contractHash不匹配而拒绝。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-004 · 新文件泄密

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在任务许可新文件中加入假token，尝试提交。

断言：暂存前拒绝；不允许只扫描git diff遗漏untracked。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-005 · Push回执丢失

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在临时裸仓fixture模拟远程已推成功但客户端超时。

断言：读远程HEAD、parent、操作ID后确认；不重复commit或force push。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-006 · CI取消失败

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：推送后CI失败、取消、缺Windowsjob分别测试。

断言：均不能记PASS；CI按本次SHA+QA分支匹配。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-007 · 单问题回退

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：已推修复出现新回归，使用受控revert后再测。

断言：远程历史完整保留；数据恢复单独验证。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## GIT-008 · 清理单独提交

模块：版本和远程门禁；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：一个功能修复和一个dead-code清理尝试合并。

断言：任务类型/文件许可不同，拆分并各自回归。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-001 · 正式通道封锁

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：测试v*、baseline、错误rc号、合法qa-rc标签。

断言：仅精确qa-rc/x.y.z-rc.n可进入候选通道；latest无自动出口。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-002 · OIDC身份

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：核对package、workflow filename、受保护environment与publisher。

断言：真实权限未配置则BLOCKED_PUBLISHER；不加长效token替代。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-003 · 制品泄漏

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：向pack列表加入qa/state/.env，再运行audit。

断言：拒绝；必要引擎与plugins不能被清理掉。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-004 · 不可变发布

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：同一个RC版本重复触发、已有tag或发布响应丢失。

断言：查Registry/integrity/动作日志；不改tag、不覆盖同版本。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-005 · 官方独立安装

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：固定version从official registry安装到owned prefix。

断言：version/resolved/integrity/源码SHA匹配；不用global或移动next作凭证。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-006 · 四模块安装运行

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：在该安装路径启动四模块与真实模型、Git闭环。

断言：不能借兄弟源码/node_modules/link运行；安装成功不等于runtime通过。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-007 · latest保护

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：发布前后查询latest，并保留next当前指向。

断言：latest始终不被本次候选修改；异常立刻阻断。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## REL-008 · 稳定版审批

模块：候选发布和安装；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：全部候选验收通过后检查发布动作。

断言：仅READY_FOR_STABLE_APPROVAL；不将rc直接重标latest。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-001 · 动态入口证明

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：选择搜索不到引用的CLI/Hook/插件文件提出删除。

断言：必须查exports/bin/运行注册/打包/平台路径，不能直接删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-002 · 格式独立

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：只改变本次触及代码格式及关键双语注释。

断言：无全仓格式化、许可证变化或功能语义改变。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-003 · 链接逃逸

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：owned run嵌入指向项目外目录的junction/symlink。

断言：dry-run即拒绝；外部目录内容不变。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-004 · 硬链接防护

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：临时目录含hardlink到保留文件。

断言：拒绝清理；没有跨边界误删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-005 · 活跃数据保留

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：ACTIVE/FAILED/RETAIN与旧PASSED目录混合。

断言：仅PASSED且到期进入清单；首失败/检查点/基线永不自动删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-006 · 清理清单变动

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：生成dry-run后修改文件，再apply。

断言：hash校验拒绝；不按旧清单盲删。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-007 · Windows重启锁

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：重启留有锁文件但旧PID可能重用。

断言：不按年龄删锁；核对启动时间/命令/目录后人工或平台监督回收。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。

## CLN-008 · 清理回归

模块：工程清理；优先级：P0；层级：CONTROLLER_ACCEPTANCE；状态：NOT_RUN。

来源：`本开发包设计约束；plans/14_SOURCES_AND_CONFLICTS.md`。候选已有套件：`qa-autopilot npm test + 专用现场用例`。

前置：独立fixture；真实副作用另行审批。

操作：删除已证明死代码后跑相关API/UI/pack与候选安装。

断言：无回归才远程提交；不能用覆盖率未执行作为删除依据。

证据：首失败与复测回执；状态/远程/哈希对应关系。清理：只处理本轮拥有的非活跃临时资源。
