# 隔离实证 · 开发知识库 vs QA 测试实例

- 日期：2026-10-21
- 场景：开发知识库（桌面客户端托盘常驻，持有 5757/5760/5790/8787/8790）运行期间，执行完整 QA 套件
- 收据：`artifacts/test-all-1792592987036/receipt.json`（副本 `artifacts/scan-with-dev-kb-20261021.json`）

## 1. QA 侧结果

| 项 | 值 |
|---|---|
| 状态 | **PASS**，退出码 **0** |
| 执行文件数 | 156 |
| PASS / 跳过 / 超时 / flaky | 156 / **0** / false / false |
| 源码未变 | true |
| 端口冲突场景 | 被实际覆盖：`bin-cli-test.js` 的端口回退用例在 5757 被占用下自动选到 5757–5776 内的空闲端口并通过 |

**与开发库上线之前的那次全量扫描（同样 156/156 PASS，exit 0）逐项一致** —— 说明开发库占用 5757 未对 QA 造成任何影响。

## 2. 开发库侧：运行前后逐项对比

| 指标 | 运行前 | 运行后 | 判定 |
|---|---|---|---|
| 项目注册数 | 7 | 7 | **保持** |
| knowledge-engine runs | 323 | 323 | 未减少 |
| 记忆（memories） | 49 | 49 | 未减少 |
| 知识根 Markdown | 467 | 467 | 未减少 |
| `events/journal/events.jsonl` 字节 | 396,955 | **396,955** | **字节完全一致** |
| `events.jsonl` mtime | 2026-10-21T14:14:02.014Z | 2026-10-21T14:14:02.014Z | **未被触碰** |
| 知识根 | 存在 | 存在 | 保持 |
| v5 数据目录 | 存在 | 存在 | 保持 |

> `events.jsonl` 字节数与 mtime **完全没变**，是最强证据：QA 全量运行没有向开发库的采集日志写入任何一个字节。

## 3. 旧版 v4 遗留数据

| 指标 | 运行前 | 运行后 |
|---|---|---|
| `~/.project-knowledge` mtime | 2026-10-09 03:46:30 | **2026-10-09 03:46:30**（未变） |
| 体积 | 1.3 G | 1.3 G |

## 4. 运行中与运行后的健康检查

`node tools/protected-dev-kb.cjs health` —— **10/10 通过**，运行中与运行后各一次：

```
OK  backend_listening         port 5757 pid 32544
OK  endpoint_stable           observed 5757/32544 vs registered 5757/32544
OK  backend_process_alive     pid 32544
OK  backend_health_ok         {"ok":true,"schema":"server-health/v2",...,"projects":7}
OK  project_count_preserved   observed 7 vs registered 7
OK  knowledge_engine_alive    port 5790 pid 39088
OK  knowledge_engine_ok       version 0.2.7-rc.10 dataDir …\.project-knowledge-v5\knowledge-engine
OK  exists:…\.project-knowledge-v5
OK  exists:D:\SanQian.Xu\knowledge
OK  legacy_v4_dir_present     C:\Users\SanQian\.project-knowledge
```

## 5. 隔离机制逐条对应

| 验收条件 | 落实方式 | 证据 |
|---|---|---|
| QA 使用独立 Git Clone | `.runtime/workspaces/repair`（基线 `c7d5b2b`）、`.runtime/workspaces/baseline-source` | clone 与源仓库 `--no-hardlinks` 隔离；`sourceMatchesRemote` 独立判定 |
| 独立数据目录 | `KB_DATA_DIR` → 每次运行独立目录 | `lib/safety.cjs` `isolatedEnv`；`bin-cli-test.js` 另用 `mkdtemp` 的 `kb-bin-cli-*` |
| 独立知识根 | `KB_KNOWLEDGE_DATA_DIR` → 独立目录；隔离数据目录无 settings → 知识根解析 409 拒绝 | `getKnowledgeRootPath()` 抛 `INVALID_ARGUMENT`，**不可能落到 `D:\SanQian.Xu\knowledge`** |
| 独立浏览器 profile | 每次新建 profile 目录 | `cdp-browser.js` `profileDir`；真实用户 profile 不被读写 |
| 独立测试端口 | 测试一律显式端口；产品 5757 被占时自动回退 | `_site/_test/helpers/` 零处引用 5757；`server-app.js` `DEFAULT_PORT` + 回退逻辑 |
| 独立向量根 | 隔离时回退到 `<dataDir>/vectorhub` | `getVectorRootPath()` |
| 模拟对话/测试提交/故障注入与开发记录隔离 | QA 全程只在隔离数据目录与临时目录内产生事件 | 开发库 `events.jsonl` 字节未变 |

## 6. 5757 交叉污染的逐处排除

| 出现位置 | 性质 | 风险 |
|---|---|---|
| `bin-cli-test.js:118` | 对 `--help` 文本的断言 | 无 |
| `bin-cli-test.js:169/172/209/210` | 端口回退循环，**显式跳过已占用端口** | 无（且本次已实测在 5757 被占下通过） |
| `bridge-consumer-service-test.js:82/84` | `notifyUrl` 只写入 consumer meta；`bridge-consumer-service.js` 全文无 `fetch`/`http.request` | 无 |
| `module-dynamic-port-test.js:97` | 注释 | 无 |
| `runtime-endpoint-test.js:49/57` | 向隔离数据目录写**假**端点（`pid: 2147483646`） | 无 |

## 7. 结论

**隔离成立。** 在开发知识库常驻托盘、占用 5757/5760/5790/8787/8790 的条件下：

- QA 全量套件 **156/156 PASS，退出码 0**，端口冲突场景被真实覆盖并通过
- 开发库的**项目、知识、记忆、采集日志逐项零变化**（`events.jsonl` 字节与 mtime 完全未变）
- 旧版 v4 遗留目录零变化
- 开发库健康检查 10/10 全绿

满足授权条款 5、6、10、11 的全部要求：**QA 测试的重启、端口冲突与故障注入均不影响开发知识库**。
