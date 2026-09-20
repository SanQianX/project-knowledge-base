import type {
  ImageAttachmentInput,
  PermissionMode,
  SessionSummary,
  SlashCommand,
  WorkbenchContext,
  WorkbenchEvent,
} from "@claude-ai-workbench/contracts";

export interface TerminalLine {
  id: string;
  at: string;
  kind: string;
  text?: string;
  name?: string;
  input?: Record<string, unknown>;
  result?: string | null;
  status?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface TerminalState {
  context: WorkbenchContext | null;
  contextGeneration: number;
  sessionId: string;
  sessions: SessionSummary[];
  session: Partial<SessionSummary> & { state: string; connectionState: string; model: string | null; aiProfileId: string | null; turns: number };
  lines: TerminalLine[];
  commands: SlashCommand[];
  commandError?: string;
  permission: Record<string, unknown> | null;
  permissionMode: PermissionMode;
  tokenUsage: { used: number; total: number; hasUsage: boolean };
  requestPending: boolean;
  turnRunning: boolean;
  lastSequence: number;
  error: string | null;
}

export interface TerminalAdapter {
  listSessions(context: WorkbenchContext, options?: Record<string, unknown>): Promise<SessionSummary[]>;
  startSession(context: WorkbenchContext, options?: Record<string, unknown>): Promise<SessionSummary>;
  loadSession(id: string, options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  listCommands?(id: string, options?: Record<string, unknown>): Promise<SlashCommand[]>;
  subscribe(id: string, onEvent: (event: WorkbenchEvent) => void, onError?: (error: Error) => void, options?: Record<string, unknown>): () => void;
  send(args: Record<string, unknown>): Promise<unknown>;
  resolvePermission(args: Record<string, unknown>): Promise<unknown>;
  abort(args: Record<string, unknown>): Promise<unknown>;
  setPermissionMode(args: Record<string, unknown>): Promise<unknown>;
  destroy?(): void;
}

export interface TerminalController {
  readonly state: TerminalState;
  setContext(context: WorkbenchContext | null): Promise<void>;
  newSession(): Promise<SessionSummary>;
  restoreSession(sessionId: string): Promise<void>;
  send(text: string, options?: {attachments?: ImageAttachmentInput[]; [key: string]: unknown}): Promise<unknown>;
  resolvePermission(allow: boolean, message?: string): Promise<unknown>;
  abort(): Promise<unknown>;
  setPermissionMode(mode: PermissionMode): Promise<unknown>;
  setAdapter(adapter: TerminalAdapter | null): void;
  handleEvent(event: WorkbenchEvent): void;
  subscribeState(listener: (state: TerminalState) => void): () => void;
  destroy(): void;
}

export declare function createState(): TerminalState;
export declare function reduceEvent(state: TerminalState, event: WorkbenchEvent): boolean;
export declare function createController(options?: {
  state?: TerminalState;
  adapter?: TerminalAdapter | null;
  onChange?: (state: TerminalState) => void;
  destroyAdapter?: boolean;
}): TerminalController;
