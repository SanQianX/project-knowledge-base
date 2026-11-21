---
name: pk-team
description: Work with the AI-team task board. Use when the user asks to start, resume, check or hand off a development task ("开始任务", "继续任务", "任务状态", "提交审查"), or when beginning substantial implementation work that should be tracked with acceptance items.
---

# PK Team — AI 团队任务

独立工作流模块通过 MCP 工具管理跨项目业务任务。任务有验收项与固定工作流（目标 → 实现 → 程序检查 → 适用 Review → 整改 → 交付）；`done` 由服务端依据有效证据裁决，任何一方（包括你）说"完成了"都不算。

## 团队任务的会话内执行顺序

团队任务的计划项由当前对话亲自执行（服务端跟踪认领与交付）。

1. resume(taskId) 读 team.current —— 当前应执行的工作项（含执行成员与依赖）。
2. 认领：POST workflow-tasks/<taskId>/work-items/<itemId>/claim（requestId + claimedBy=成员ID）；依赖未交付会被拒——按顺序来。
3. 实现该工作项，然后 POST 同路径 /report（claimedBy + summary + testedWith + artifacts）。交付不等于验收。
4. 全部工作项 delivered 后 request_review(taskId) 做整任务最终验证，review_result 读裁决。
5. 用户问进展就 resume/status；只读，不重复认领。

## 团队直执行（仅当用户明确要求）

用户只发一条类似下面的指令时，start 传 executionMode:"team"（其余场合绝不传）：

> 用 pk-team 为这个复杂需求创建任务，给我 taskId，然后按项目团队配置直接执行。
> 需求：<实际需求和验收要求>

团队模式要求项目已启用并开启 autoDispatch。返回 taskId 后立即回报编号与验收，再继续服务端推进；用 resume/status 读取进展，不要代替服务端拆分或派发。降级（degraded:true）时如实告知原因并按普通任务继续。

## 何时建任务

- 用户明确要求开始/跟踪一项开发工作 → `project_workflow_start`。
- 用户在页面上建了任务并让你接续 → `project_workflow_resume <taskId>`。
- 普通问答、小改动、无验收诉求的对话 → 不建任务，不要把闲聊升级为正式任务。

## 工具

1. `project_workflow_start`（title 必填；goal 用用户原话；acceptance 给出可验证条目，自动项用 requiredEvidence 指明证据工具；传 client 与当前会话的 sessionId 建立会话绑定；超时重试带同一个 requestId 不会重复建卡）
   → 返回短任务合同（taskId、repoBinding、验收、下一步）。开始编码前把它读给用户确认验收。
2. `project_workflow_resume {taskId}` → 目标、已确认决策、已验证结果、剩余项、下一步；沿用任务，不重复建卡。
3. `project_workflow_status`（可按 projectId/status 过滤）→ 只读状态。
4. `project_workflow_checkpoint {taskId, kind, summary, decided, verifiedResults, remaining, nextAction}` → 记录进展。只有 `kind:"fact"` 才更新下一步；推断用 `kind:"candidate"`，不要把猜测写成事实。
5. `project_workflow_request_review {taskId}` → 保留一个审查作业（reviewJobId）并有界等待确定性检查：返回收据、整改清单与交付裁决，或如实的"pending"。
6. `project_workflow_review_result {taskId, reviewJobId?, waitMs?}` → 读取同一作业的收据、整改清单（file:line[rule]）与交付裁决；慢检查稍后再读同一个 reviewJobId。

## 交付前的固定顺序

```text
start / resume 同一 taskId
→ 实现，checkpoint 记录事实
→ request_review(taskId) 得到 reviewJobId 与第一轮收据
→ 按整改清单（file:line[rule]）修复
→ 再次 request_review（新快照、新作业）
→ 服务端依据收据与验收项裁决 done；不通过就继续整改或如实报告阻塞与可恢复的 taskId
```

- `done` 只由服务端依据有效证据裁决；你自称完成不构成验收。
- 自动验收项由具名工具的真实收据满足；人工/模型确认项在授权入口建立前保持待确认。

## 会话归属

- start 时传入真实的 client 会话 ID：事件观察按采集到的会话归因。同一原生会话切换任务必须重新 start/resume 绑定——不要把一个会话的事件永久算给第一个任务。
- 你自称完成不构成验收；程序检查、Review 与人工确认项由服务端裁决（人工项必须由用户确认）。

## 边界

- 任务/团队数据只在独立工作流模块；不要在仓库里另建任务文件，也不要修改知识库的记忆正文。
- 工作流服务不可达时继续正常开发（工具会返回结构化降级提示），恢复后补 checkpoint。
- 与知识工具的关系：先 `project_knowledge_resolve/search` 拿上下文，再 start 任务；两者互补，不互相替代。
