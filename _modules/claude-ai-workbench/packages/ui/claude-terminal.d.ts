import type { ClaudeWorkbenchClient } from "@claude-ai-workbench/client";
import type { ImageAttachmentInput, SlashCommand, WorkbenchContext } from "@claude-ai-workbench/contracts";
import type { TerminalAdapter, TerminalController, TerminalState } from "@claude-ai-workbench/core";

export declare class ClaudeWorkbenchPane extends HTMLElement {
  client: ClaudeWorkbenchClient | null;
  adapter: TerminalAdapter | null;
  context: WorkbenchContext | null;
  locale: "zh-CN" | "en" | string;
  readonly controller: TerminalController | null;
  newSession(): Promise<unknown>;
  restoreSession(sessionId: string): Promise<void>;
  focusInput(): void;
  destroy(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "claude-workbench-pane": ClaudeWorkbenchPane;
  }
  interface HTMLElementEventMap {
    "terminal-state-change": CustomEvent<TerminalState>;
    "workbench-state-change": CustomEvent<TerminalState>;
    "running-change": CustomEvent<{ running: boolean }>;
    "terminal-error": CustomEvent<Error>;
    "workbench-error": CustomEvent<Error>;
    "terminal-attach-request": CustomEvent<{ context: WorkbenchContext | null; addFiles(files: FileList | File[]): Promise<void> }>;
    "terminal-attachments-change": CustomEvent<{ attachments: ImageAttachmentInput[] }>;
    "terminal-command": CustomEvent<{ command: string; commandInfo?: SlashCommand; context: WorkbenchContext | null; state: TerminalState }>;
  }
}
