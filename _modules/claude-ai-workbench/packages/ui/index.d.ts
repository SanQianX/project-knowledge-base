import type { ClaudeWorkbenchClient } from "@claude-ai-workbench/client";
import type { WorkbenchContext } from "@claude-ai-workbench/contracts";

export interface ClaudeWorkbenchPaneElement extends HTMLElement {
  client: ClaudeWorkbenchClient | null;
  adapter: ClaudeWorkbenchClient | null;
  context: WorkbenchContext | null;
  readonly controller: unknown;
  destroy(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "claude-workbench-pane": ClaudeWorkbenchPaneElement;
  }
}

export {};
