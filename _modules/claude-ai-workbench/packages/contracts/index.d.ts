export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export type ProfileProtocol = "anthropic-compatible" | "openai-compatible" | string;
export type AgentId = "claude-code" | "codex" | "opencode" | "zcode";
export type EffortLevel = "low" | "medium" | "high" | "max";

export interface AgentCapabilities {
  thinking: boolean;
  permissions: boolean;
  toolStream: boolean;
  images: boolean;
  resume: true;
  modelOverride: boolean;
  generationParams: readonly string[];
}

export interface AgentDefinition {
  id: AgentId;
  label: string;
  transport: string;
  authModes: readonly string[];
  capabilities: AgentCapabilities;
}

export interface AgentStatus extends AgentDefinition {
  capabilities: { generationParams: string[] } & Omit<AgentCapabilities, "generationParams">;
  available: boolean;
  version: string | null;
}

export interface Project {
  id: string;
  name: string;
  rootPath: string;
  createdAt: string;
  updatedAt: string;
  defaultAiProfileId?: string | null;
  defaultModel?: string | null;
  defaultAgentId?: AgentId;
}

export interface ProjectInput {
  name: string;
  rootPath: string;
  defaultAiProfileId?: string | null;
  defaultModel?: string | null;
  defaultAgentId?: AgentId;
}

export type ProjectPatch = Partial<Omit<ProjectInput, "rootPath">>;

export interface ModelListEntry {
  id: string;
  openaiId?: string;
  label: string;
  tags: string[];
}

export interface WorkbenchContext {
  contextId: string;
  contextType?: string;
  displayName?: string;
  workspaceRef?: string;
  aiProfileId?: string | null;
  model?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AiProfileModels {
  default: string;
  fast?: string;
  reasoning?: string;
  coding?: string;
  largeContext?: string;
  list?: ModelListEntry[];
  [role: string]: string | undefined | ModelListEntry[];
}

export interface AiProfileInput {
  id: string;
  name?: string;
  provider: string;
  protocol?: ProfileProtocol;
  runtime?: "claude-code";
  baseUrl: string;
  openaiBaseUrl?: string;
  credentialRef?: string;
  models: AiProfileModels;
  contextWindow?: number;
  timeoutMs?: number;
  permissionMode?: PermissionMode;
  systemPrompt?: Record<string, unknown> | string;
  enabled?: boolean;
}

export interface AiProfile extends AiProfileInput {
  name: string;
  protocol: ProfileProtocol;
  runtime: "claude-code";
  credentialRef: string;
  contextWindow: number;
  timeoutMs: number;
  permissionMode: PermissionMode;
  systemPrompt: Record<string, unknown>;
  enabled: boolean;
  credentialConfigured?: boolean;
  credentialMasked?: string;
}

export interface CredentialInput { secret: string; }

export interface ProfileTestResult {
  ok: true;
  runtime: "claude-code";
  runtimeVerified: true;
  profileId: string;
  model: string;
  firstEventMs: number;
  durationMs: number;
  resultPreview: string;
}

export interface HealthResult {
  status: "ok";
  version: string;
  apiVersion: string;
  activeProcesses: number;
  sessions: number;
  time: string;
}

export interface RuntimeInfo {
  runtime: "claude-code";
  available: boolean;
  executable: string | null;
  transport: string;
}

export interface SessionSummary {
  sessionId: string;
  contextId: string;
  projectId: string;
  agentId: AgentId;
  title: string;
  active: boolean;
  state: string;
  model: string | null;
  aiProfileId: string | null;
  providerName?: string | null;
  authSource?: "profile-injected" | "agent-owned";
  selectedModel?: string | null;
  permissionMode: PermissionMode;
  archived: boolean;
  turns: number;
  startedAt: string;
  updatedAt: string;
  connectionState: string;
}

export interface WorkbenchEvent {
  type: string;
  sessionId: string;
  contextId: string;
  sequence: number;
  at: string;
  [key: string]: unknown;
}

export interface ImageAttachmentInput {
  id?: string;
  name: string;
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mediaType: ImageAttachmentInput["mediaType"];
  size: number;
  width?: number;
  height?: number;
  url: string;
}

export interface TextAttachmentInput {
  id?: string;
  name: string;
  mediaType: "text/plain" | "text/markdown" | "application/json" | "text/csv";
  data: string;
  size?: number;
}

export type AttachmentInput = ImageAttachmentInput | TextAttachmentInput;
export interface TextAttachment {
  id: string;
  name: string;
  mediaType: TextAttachmentInput["mediaType"];
  size: number;
  url: string;
}
export type Attachment = ImageAttachment | TextAttachment;

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  aliases?: string[];
  source?: string;
}

export interface SessionSnapshot {
  session: SessionSummary;
  events: WorkbenchEvent[];
  permission: Record<string, unknown> | null;
  permissionMode: PermissionMode;
  tokenUsage: Record<string, unknown>;
}

export declare const API_VERSION: "v1";
export declare const DEFAULT_API_PREFIX: "/api/claude-workbench/v1";
export declare const RUNTIME: "claude-code";
export declare const DEFAULT_AGENT: AgentId;
export declare const AGENT_IDS: readonly AgentId[];
export declare const EFFORT_LEVELS: readonly EffortLevel[];
export declare const AGENTS: Record<AgentId, AgentDefinition>;
export declare const PERMISSION_MODES: readonly PermissionMode[];
export declare const IMAGE_MEDIA_TYPES: readonly ImageAttachmentInput["mediaType"][];
export declare const TEXT_MEDIA_TYPES: readonly TextAttachmentInput["mediaType"][];
export declare const TEXT_FILE_TYPES: Readonly<Record<string, TextAttachmentInput["mediaType"]>>;
export declare const MAX_IMAGE_BYTES: number;
export declare const MAX_IMAGES_PER_MESSAGE: number;
export declare const MAX_IMAGE_MESSAGE_BYTES: number;
export declare const MAX_TEXT_BYTES: number;
export declare const MAX_ATTACHMENTS_PER_MESSAGE: number;
export declare const MAX_ATTACHMENT_MESSAGE_BYTES: number;
export declare const EVENT_TYPES: readonly string[];
export declare function cleanId(value: unknown, field?: string): string;
export declare function normalizeContext(input: unknown): WorkbenchContext;
export declare function normalizeProfile(input: unknown, idOverride?: string): AiProfile;
export declare function normalizeProject(input: unknown, idOverride?: string): Project;
export declare function normalizeAgentId(value: unknown): AgentId;
export declare function normalizeEffort(value: unknown): EffortLevel | undefined;
export declare function normalizeModelEntries(input: unknown): ModelListEntry[];
export declare function normalizeImageAttachments(input: unknown): Array<ImageAttachmentInput & { size: number }>;
export declare function normalizeAttachments(input: unknown): Array<AttachmentInput & { size: number }>;
export declare function appendTextAttachments(text: string, attachments?: AttachmentInput[]): string;
export declare function resolveOpenAIBaseUrl(profile?: Partial<AiProfileInput>): string;
export declare function resolveOpenAIModel(profile?: Partial<AiProfileInput> & { mainModel?: string }, model?: string): string;
export declare function positiveInt(value: unknown, fallback: number): number;
