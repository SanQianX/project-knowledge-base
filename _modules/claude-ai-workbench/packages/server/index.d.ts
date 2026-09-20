import type { Server } from "node:http";
import type { AgentId, AgentStatus, AiProfile, AiProfileInput, AttachmentInput, EffortLevel, PermissionMode, Project, ProjectInput, ProjectPatch, SessionSummary, SlashCommand, WorkbenchContext } from "@claude-ai-workbench/contracts";

export interface WorkbenchRunner {
  startChatSession(options: Record<string, unknown>): {sessionId: string};
  listSessions(filter?: Record<string, unknown>): Record<string, unknown>[];
  getState(sessionId: string): Record<string, unknown> | null;
  getSession(sessionId: string): Record<string, unknown> | null;
  getSessionTokenUsage(sessionId: string): Record<string, unknown>;
  subscribe(sessionId: string, listener: (event: Record<string, unknown>) => void): () => void;
  sendInput(sessionId: string, text: string, profile: Record<string, unknown>, options?: Record<string, unknown>): Promise<unknown>;
  listSupportedCommands?(sessionId: string, profile: Record<string, unknown>): Promise<SlashCommand[]>;
  resolvePermission(sessionId: string, requestId: string, decision: Record<string, unknown>): unknown;
  abort(sessionId: string): void;
  deleteSession(sessionId: string): unknown;
  findClaudeExecutableForSdk(): unknown;
}

export interface WorkbenchServerOptions {
  dataDir?: string;
  workspaces?: Record<string, string>;
  runner?: WorkbenchRunner;
  profiles?: ProfileStore;
  attachments?: AttachmentStore;
  contexts?: ContextResolver;
  service?: WorkbenchService;
  projects?: ProjectStore;
  sessionArchive?: SessionArchiveStore;
  registry?: AgentRegistry;
  drivers?: Partial<Record<AgentId, WorkbenchRunner>>;
  agentDiscovery?: AgentDiscovery;
  modelContextWindows?: { resolveContextWindow(model: string): number | null };
  apiPrefix?: string;
  corsOrigin?: string;
  serveHost?: boolean;
  staticRoot?: string;
  profileSettingsRoot?: string;
  terminalHostRoot?: string;
  agentTerminalRoot?: string;
  createMissingWorkspaces?: boolean;
  version?: string;
  maxSessions?: number;
  maxConcurrentRuns?: number;
}

export interface WorkbenchServer {
  server: Server;
  service: WorkbenchService;
  profiles: ProfileStore;
  attachments: AttachmentStore;
  contexts: ContextResolver;
  projects: ProjectStore;
  sessionArchive: SessionArchiveStore;
  registry: AgentRegistry;
  agentDiscovery: AgentDiscovery;
  apiPrefix: string;
  dataDir: string;
}

export declare class ProfileStore {
  constructor(options: {dataDir: string; profileFile?: string; credentialFile?: string});
  list(): AiProfile[];
  get(id: string): AiProfile | null;
  save(input: AiProfileInput, idOverride?: string): AiProfile;
  delete(id: string): boolean;
  setCredential(id: string, credential: string | {secret: string}): void;
  runtimeProfile(id: string): Record<string, unknown>;
  runtimeDraft(input: AiProfileInput, credential?: string | {secret: string}): Record<string, unknown>;
}

export declare class ContextResolver {
  constructor(options?: {workspaces?: Record<string, string>; createMissing?: boolean});
  register(ref: string, target: string): void;
  unregister(ref: string): boolean;
  resolve(context: WorkbenchContext): {context: WorkbenchContext; workspacePath: string};
}

export declare class ProjectStore {
  constructor(options: {dataDir: string; projectFile?: string});
  list(): Project[];
  get(id: string): Project | null;
  create(input: ProjectInput): Project;
  rename(id: string, name: string): Project;
  update(id: string, patch: ProjectPatch): Project;
  remove(id: string): boolean;
  toWorkspaceMap(): Record<string, string>;
}

export declare class SessionArchiveStore {
  constructor(options: {dataDir: string; archiveFile?: string});
  isArchived(sessionId: string): boolean;
  archive(sessionId: string): {archivedAt: string};
  restore(sessionId: string): boolean;
  forget(sessionId: string): void;
}

export declare class AgentRegistry {
  constructor(options?: {drivers?: Partial<Record<AgentId, WorkbenchRunner>>});
  register(agentId: AgentId, driver: WorkbenchRunner): WorkbenchRunner;
  driverFor(agentId: AgentId): WorkbenchRunner;
  agentOf(sessionId: string): AgentId;
  asRunner(): WorkbenchRunner;
}

export interface AgentDiscovery {
  (): Record<AgentId, AgentStatus & {reason?: string}>;
  invalidate?(): void;
}

export interface CliDriverOptions {
  command?: string;
  spawn?: typeof import("node:child_process").spawn;
  ignoreUserConfig?: boolean;
}

export declare class AttachmentStore {
  constructor(options: {root: string});
  saveMany(sessionId: string, attachments: AttachmentInput[]): Record<string, unknown>[];
  save(sessionId: string, attachment: AttachmentInput): Record<string, unknown>;
  read(sessionId: string, attachmentId: string): {metadata: Record<string, unknown>; data: Buffer} | null;
}

export declare class WorkbenchService {
  readonly version: string;
  listProjects(): {projects: Project[]};
  getProject(id: string): Project;
  createProject(input: ProjectInput): Project;
  renameProject(id: string, input: ProjectPatch): Project;
  removeProject(id: string): boolean;
  listSessions(contextId: string, options?: {includeArchived?: boolean}): SessionSummary[];
  startSession(context: WorkbenchContext, aiProfileId?: string | null, options?: {agentId?: AgentId; model?: string | null; permissionMode?: PermissionMode; effort?: EffortLevel}): SessionSummary;
  listCommands(sessionId: string): Promise<{commands: SlashCommand[]}>;
  readAttachment(sessionId: string, attachmentId: string): {metadata: Record<string, unknown>; data: Buffer};
  send(sessionId: string, text?: string, options?: Record<string, unknown>, attachments?: AttachmentInput[]): Promise<Record<string, unknown>>;
  testProfile(profileId: string): Promise<Record<string, unknown>>;
  testProfileDraft(input: {profile: AiProfileInput; credential?: string}): Promise<Record<string, unknown>>;
  destroy(): void;
}

export declare function createWorkbenchServer(options?: WorkbenchServerOptions): WorkbenchServer;
export declare function createAgentDiscovery(options?: {claudeProbe?: () => {available: boolean; version?: string | null}}): AgentDiscovery;
export declare function createCodexDriver(options?: CliDriverOptions): WorkbenchRunner;
export declare function createOpenCodeDriver(options?: CliDriverOptions): WorkbenchRunner;
export declare function createZCodeDriver(): WorkbenchRunner;
export declare function createHttpHandler(service: WorkbenchService, options?: Record<string, unknown>): (request: unknown, response: unknown) => Promise<boolean>;
