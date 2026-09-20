import type { AiProfile, AiProfileInput } from "@claude-ai-workbench/contracts";

export interface ProfileActionDetail {
  profile: AiProfileInput | AiProfile;
  credential: string;
}

export interface AiProfileListElement extends HTMLElement {
  profiles: AiProfile[];
  busy: boolean;
}

export interface AiProfileEditorElement extends HTMLElement {
  profile: AiProfileInput | AiProfile | null;
  busy: boolean;
  setStatus(message: string, tone?: "" | "good" | "bad"): void;
  setBusy(value: boolean, message?: string): void;
}

export interface AiProfileSettingsElement extends HTMLElement {
  profiles: AiProfile[];
  setStatus(message: string, tone?: "" | "good" | "bad"): void;
  setBusy(value: boolean, message?: string): void;
  openNew(): void;
  openEditor(profile: AiProfile): void;
  closeEditor(): void;
}

declare global {
  interface HTMLElementTagNameMap {
    "ai-profile-list": AiProfileListElement;
    "ai-profile-editor": AiProfileEditorElement;
    "ai-profile-settings": AiProfileSettingsElement;
  }

  interface GlobalEventHandlersEventMap {
    "profile-save": CustomEvent<ProfileActionDetail>;
    "profile-test": CustomEvent<ProfileActionDetail>;
    "profile-edit": CustomEvent<ProfileActionDetail>;
    "profile-delete": CustomEvent<ProfileActionDetail>;
    "profile-cancel": CustomEvent<void>;
  }
}

export {};
