import type {
  AgentId,
  AgentStatus,
  AiProfile,
  AiProfileInput,
  CredentialInput,
  EffortLevel,
  HealthResult,
  PermissionMode,
  ProfileTestResult,
  Project,
  ProjectInput,
  ProjectPatch,
  RuntimeInfo,
  AttachmentInput,
  SlashCommand,
  SessionSnapshot,
  SessionSummary,
  WorkbenchContext,
  WorkbenchEvent,
} from "@claude-ai-workbench/contracts";

export interface RequestOptions { signal?: AbortSignal; [key: string]: unknown; }
export interface StartSessionOptions extends RequestOptions {
  permissionMode?: PermissionMode;
  agentId?: AgentId;
  effort?: EffortLevel;
  aiProfileId?: string | null;
  model?: string | null;
}
export interface ListSessionsOptions extends RequestOptions { archived?: boolean; }
export interface SendOptions { permissionMode?: PermissionMode; [key: string]: unknown; }
export interface StreamHandlers {
  onEvent?: (event: WorkbenchEvent) => void;
  onError?: (error: Error) => void;
  onOpen?: () => void;
  afterSequence?: number;
}
export interface ClientResourceCounts { streams: number; requests: number; reconnects: number; }
export interface ClaudeWorkbenchClientOptions {
  apiBase?: string;
  fetch?: typeof fetch;
  EventSource?: typeof EventSource;
}

export interface ClaudeWorkbenchClient {
  health(): Promise<HealthResult>;
  runtime(): Promise<RuntimeInfo>;
  listAgents(): Promise<AgentStatus[]>;
  listProjects(): Promise<Project[]>;
  createProject(project: ProjectInput): Promise<Project>;
  getProject(id: string): Promise<Project>;
  renameProject(id: string, name: string): Promise<Project>;
  updateProject(id: string, patch: ProjectPatch): Promise<Project>;
  removeProject(id: string): Promise<void>;
  listProfiles(): Promise<AiProfile[]>;
  saveProfile(profile: AiProfileInput): Promise<AiProfile>;
  deleteProfile(id: string): Promise<void>;
  setCredential(id: string, credential: string | CredentialInput): Promise<void>;
  testProfile(id: string): Promise<ProfileTestResult>;
  testProfileDraft(profile: AiProfileInput, credential?: string): Promise<ProfileTestResult>;
  listSessions(context: WorkbenchContext | string, options?: ListSessionsOptions): Promise<SessionSummary[]>;
  startSession(context: WorkbenchContext, options?: StartSessionOptions): Promise<SessionSummary>;
  loadSession(id: string, options?: RequestOptions): Promise<SessionSnapshot>;
  listCommands(id: string, options?: RequestOptions): Promise<SlashCommand[]>;
  subscribe(id: string, handlers: StreamHandlers | ((event: WorkbenchEvent) => void), onError?: (error: Error) => void, options?: {afterSequence?: number}): () => void;
  send(sessionId: string, text: string, options?: SendOptions): Promise<unknown>;
  send(args: {sessionId: string; text?: string; attachments?: AttachmentInput[]; options?: SendOptions}): Promise<unknown>;
  resolvePermission(sessionId: string, requestId: string, allow: boolean, message?: string): Promise<unknown>;
  resolvePermission(args: {sessionId: string; requestId: string; allow: boolean; message?: string}): Promise<unknown>;
  abort(sessionId: string | {sessionId: string}): Promise<unknown>;
  setPermissionMode(sessionId: string, mode: PermissionMode): Promise<unknown>;
  setPermissionMode(args: {sessionId: string; mode: PermissionMode}): Promise<unknown>;
  archiveSession(sessionId: string | {sessionId: string}): Promise<{sessionId: string; archivedAt: string}>;
  restoreSession(sessionId: string | {sessionId: string}): Promise<void>;
  resourceCounts(): ClientResourceCounts;
  destroy(): void;
}

export declare const EVENT_TYPES: readonly string[];
export declare function createClaudeWorkbenchClient(options?: ClaudeWorkbenchClientOptions): ClaudeWorkbenchClient;
