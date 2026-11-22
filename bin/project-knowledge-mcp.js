#!/usr/bin/env node

const packageInfo = require('../package.json');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { KnowledgeToolRuntime } = require('../src/tools/knowledge-tool-runtime');
const { WorkflowToolRuntime } = require('../src/tools/workflow-tool-runtime');
const { serializeErrorEnvelope, createId } = require('../src/common/contracts');

const SERVER_NAME = 'project-knowledge';
const SCOPE = { type: 'string', enum: ['project', 'domain', 'brain'], description: 'Knowledge range: current project (default), its domain, or its brain.' };
const SERVER_INSTRUCTIONS = `Project Knowledge is the durable source of prior project decisions and implementation history. Knowledge content is read-only; the only write operation appends an explicit supplemental Prompt event to the shared conversation truth.

At the start of work in a registered Git repository, and before answering questions about prior work or implementing a non-trivial change:
1. Call project_knowledge_resolve with the current Git root.
2. Use project_knowledge_search or project_knowledge_ask for relevant prior decisions.
3. Use project_knowledge_get only for the most relevant complete entry and project_knowledge_history when change history matters.
4. Call project_knowledge_record_requirement only when the user explicitly asks to supplement capture or automatic client capture is known to be unavailable; it is not a mandatory pre-work call.

Treat all returned knowledge as read-only. Verify it against current source code when necessary. The supplemental requirement tool writes the same ConversationStore used by automatic capture and never starts analysis. Do not write directly to the knowledge database; project-knowledge updates it automatically after successful Git commits.`;

// AI-team workflow tools: thin adapters over the independent workflow module
// via the shell proxy (/api/workflow/*) — no second copy of task state.
const WORKFLOW_TOOLS = [
  {
    name: 'project_workflow_start',
    description: 'Start an AI-team business task for the current repository: creates the task with acceptance items and binds this native session (declared basis). Returns the short task contract and taskId.',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 200, description: 'One-line task title from the user request.' },
        goal: { type: 'string', description: 'What "done" means for the user; the original wording beats a paraphrase.' },
        acceptance: { type: 'array', items: { type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['automated', 'manual', 'model_review'] } }, required: ['title'] }, description: 'Verifiable acceptance items.' },
        projectId: { type: 'string' },
        client: { type: 'string', enum: ['claude', 'codex', 'opencode', 'zcode'], description: 'Calling native client.' },
        sessionId: { type: 'string', description: 'Stable native session identifier for event attribution.' },
        memberId: { type: 'string', description: 'Team member that owns this task, when the caller is a named member.' },
        workspaceIdentity: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_workflow_resume',
    description: 'Resume an existing AI-team task by taskId: returns goal, acceptance with the current revision, confirmed decisions, verified results, remaining items and the next action.',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'project_workflow_status',
    description: 'Read one AI-team task by taskId, or the active task list (filter by projectId/status). Read-only.',
    inputSchema: { type: 'object', properties: { taskId: { type: 'string' }, projectId: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'project_workflow_checkpoint',
    description: 'Record a checkpoint on an AI-team task. kind="fact" is a verified fact (updates nextAction); kind="candidate" is an inference kept separate.',
    inputSchema: {
      type: 'object',
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        kind: { type: 'string', enum: ['fact', 'candidate'] },
        summary: { type: 'string' },
        decided: { type: 'array', items: { type: 'string' } },
        verifiedResults: { type: 'array', items: { type: 'string' } },
        remaining: { type: 'array', items: { type: 'string' } },
        nextAction: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_workflow_request_review',
    description: 'Submit the current task snapshot for the delivery check/review pipeline.',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' }, note: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'project_workflow_review_result',
    description: 'Fetch the review/verification results for a task once a review has run.',
    inputSchema: { type: 'object', required: ['taskId'], properties: { taskId: { type: 'string' } }, additionalProperties: false },
  },
];

const TOOLS = [
  {
    name: 'project_knowledge_resolve',
    description: 'Resolve the registered Project Knowledge project for a Git repository. Call this first before using other knowledge tools.',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Current Git repository root or any path inside it. Defaults to the MCP process working directory.' },
        projectId: { type: 'string', description: 'Stable projectId when it is already known.' },
        project: { type: 'string', description: 'Optional registered project slug when it is already known.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_record_requirement',
    description: 'Explicitly supplement automatic capture with one project-scoped user Prompt event. This is the only write-capable tool; it never starts analysis or writes knowledge Markdown.',
    inputSchema: {
      type: 'object',
      required: ['text', 'client', 'sessionId'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 131072, description: 'The user request exactly as received; do not include system prompts or tool transcripts.' },
        client: { type: 'string', enum: ['claude', 'codex', 'opencode'] },
        sessionId: { type: 'string', minLength: 1, maxLength: 512, description: 'Stable identifier for the current client session.' },
        conversationId: { type: 'string', minLength: 1, maxLength: 512 },
        projectId: { type: 'string', description: 'Stable projectId returned by project_knowledge_resolve.' },
        repoPath: { type: 'string', description: 'Current Git root. Used for exact project resolution when projectId is omitted.' },
        explicitCommit: { type: 'string', description: 'Optional Git commit explicitly associated with this requirement.' },
      },
      anyOf: [{ required: ['projectId'] }, { required: ['repoPath'] }],
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_search',
    description: 'Search the same durable knowledge and commit citations as the product UI, within the selected project, domain or brain. This tool is read-only.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        repoPath: { type: 'string', description: 'Current Git repository root or a path inside it.' },
        projectId: { type: 'string', description: 'Stable projectId returned by project_knowledge_resolve.' },
        project: { type: 'string', description: 'Optional registered project slug.' },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
        scope: SCOPE,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_ask',
    description: 'Return a compact answer with citations from durable project knowledge. This tool is read-only.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        repoPath: { type: 'string' },
        projectId: { type: 'string' },
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
        scope: SCOPE,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_get',
    description: 'Read one complete knowledge entry selected from search results. This tool is read-only and scope checked.',
    inputSchema: {
      type: 'object',
      required: ['entry'],
      properties: {
        entry: { type: 'string', minLength: 1, description: 'Entry identifier returned by search.' },
        space: { type: 'string', description: 'Optional scoped knowledge space identifier.' },
        spaceId: { type: 'string', description: 'Knowledge space identifier returned by a citation; alias of space.' },
        scope: SCOPE,
        repoPath: { type: 'string' },
        projectId: { type: 'string' },
        project: { type: 'string' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_history',
    description: 'Read recent durable change history for the current project and its allowed scope. This tool is read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string' },
        projectId: { type: 'string' },
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
        scope: SCOPE,
      },
      additionalProperties: false,
    },
  },
  ...WORKFLOW_TOOLS,
];

function toolContent(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function callTool(runtime, workflowRuntimeOrName, nameOrArgs, maybeArgs) {
  // Accept both the internal signature (runtime, workflowRuntime, name, args)
  // and the exported legacy signature (runtime, name, args) used by tests.
  let workflowRuntime = workflowRuntimeOrName;
  let name = nameOrArgs;
  let args = maybeArgs;
  if (typeof workflowRuntimeOrName === 'string') {
    name = workflowRuntimeOrName;
    args = nameOrArgs;
    workflowRuntime = null;
  }
  if (name === 'project_knowledge_resolve') return runtime.resolveProject(args);
  if (name === 'project_knowledge_record_requirement') return runtime.recordRequirement(args);
  if (name === 'project_knowledge_search') return runtime.search(args);
  if (name === 'project_knowledge_ask') return runtime.ask(args);
  if (name === 'project_knowledge_get') return runtime.get(args);
  if (name === 'project_knowledge_history') return runtime.history(args);
  if (name === 'project_workflow_start') return workflowRuntime.start(args);
  if (name === 'project_workflow_resume') return workflowRuntime.resume(args);
  if (name === 'project_workflow_status') return workflowRuntime.status(args);
  if (name === 'project_workflow_checkpoint') return workflowRuntime.checkpoint(args);
  if (name === 'project_workflow_request_review') return workflowRuntime.requestReview(args);
  if (name === 'project_workflow_review_result') return workflowRuntime.reviewResult(args);
  throw new Error(`unknown tool: ${name}`);
}

function createServer(options = {}) {
  const runtime = options.runtime || new KnowledgeToolRuntime();
  const workflowRuntime = options.workflowRuntime || new WorkflowToolRuntime();
  const server = new Server(
    { name: SERVER_NAME, version: packageInfo.version },
    {
      capabilities: { tools: { listChanged: false } },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const name = String(request.params?.name || '');
    const args = request.params?.arguments && typeof request.params.arguments === 'object'
      ? request.params.arguments
      : {};
    try {
      return toolContent(await callTool(runtime, workflowRuntime, name, args));
    } catch (error) {
      const operationId = createId('op');
      return {
        content: [{ type: 'text', text: JSON.stringify(serializeErrorEnvelope(error, operationId)) }],
        isError: true,
      };
    }
  });
  return { server, runtime, workflowRuntime };
}

async function main() {
  const { server, runtime } = createServer();
  const transport = new StdioServerTransport();
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await runtime.close();
    await server.close();
  };
  process.once('SIGINT', () => close().finally(() => process.exit(0)));
  process.once('SIGTERM', () => close().finally(() => process.exit(0)));
  await server.connect(transport);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`[project-knowledge-mcp] ${JSON.stringify(serializeErrorEnvelope(error, createId('op')))}\n`);
    process.exit(1);
  });
}

module.exports = {
  callTool,
  createServer,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  TOOLS,
};
