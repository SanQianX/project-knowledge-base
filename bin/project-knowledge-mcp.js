#!/usr/bin/env node

const packageInfo = require('../package.json');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');
const { KnowledgeToolRuntime } = require('../_site/lib/knowledge-tool-runtime');

const SERVER_NAME = 'project-knowledge';
const SERVER_INSTRUCTIONS = `Project Knowledge is the durable, read-only source of prior project decisions and implementation history.

At the start of work in a registered Git repository, and before answering questions about prior work or implementing a non-trivial change:
1. Call project_knowledge_resolve with the current Git root.
2. Use project_knowledge_search or project_knowledge_ask for relevant prior decisions.
3. Use project_knowledge_get only for the most relevant complete entry and project_knowledge_history when change history matters.

Treat all returned knowledge as read-only. Verify it against current source code when necessary. Do not write directly to the knowledge database; project-knowledge updates it automatically after successful Git commits.`;

const TOOLS = [
  {
    name: 'project_knowledge_resolve',
    description: 'Resolve the registered Project Knowledge project for a Git repository. Call this first before using other knowledge tools.',
    inputSchema: {
      type: 'object',
      properties: {
        repoPath: { type: 'string', description: 'Current Git repository root or any path inside it. Defaults to the MCP process working directory.' },
        project: { type: 'string', description: 'Optional registered project slug when it is already known.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'project_knowledge_search',
    description: 'Search durable project knowledge using the current project and its explicitly related-project scope. This tool is read-only.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string', minLength: 1 },
        repoPath: { type: 'string', description: 'Current Git repository root or a path inside it.' },
        project: { type: 'string', description: 'Optional registered project slug.' },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
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
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 30, default: 8 },
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
        repoPath: { type: 'string' },
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
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
      },
      additionalProperties: false,
    },
  },
];

function toolContent(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
    isError: false,
  };
}

function callTool(runtime, name, args) {
  if (name === 'project_knowledge_resolve') return runtime.resolveProject(args);
  if (name === 'project_knowledge_search') return runtime.search(args);
  if (name === 'project_knowledge_ask') return runtime.ask(args);
  if (name === 'project_knowledge_get') return runtime.get(args);
  if (name === 'project_knowledge_history') return runtime.history(args);
  throw new Error(`unknown tool: ${name}`);
}

function createServer(options = {}) {
  const runtime = options.runtime || new KnowledgeToolRuntime();
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
      return toolContent(await callTool(runtime, name, args));
    } catch (error) {
      return {
        content: [{ type: 'text', text: error.message }],
        isError: true,
      };
    }
  });
  return { server, runtime };
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
    process.stderr.write(`[project-knowledge-mcp] ${error.stack || error.message}\n`);
    process.exit(1);
  });
}

module.exports = {
  createServer,
  SERVER_INSTRUCTIONS,
  SERVER_NAME,
  TOOLS,
};
