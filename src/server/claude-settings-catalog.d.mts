export type ClaudeSettingGroup = "sessions" | "model" | "memory" | "git" | "terminal" | "updates";
export type ClaudeSettingKind = "switch" | "choice" | "days" | "allowTool" | "attribution";

export interface ClaudeSettingOption {
  value: string | null;
  label: string;
}

export interface ClaudeSettingEntry {
  id: string;
  key: string;
  group: ClaudeSettingGroup;
  kind: ClaudeSettingKind;
  label: string;
  note: string;
  keywords: readonly string[];
  since?: string;
  strict?: boolean;
  unset?: boolean | number;
  tool?: string;
  options?: readonly (ClaudeSettingOption | number)[];
}

export const CLAUDE_SETTINGS_DOCS: string;
export const CLAUDE_SETTING_GROUPS: readonly { id: ClaudeSettingGroup; title: string }[];
export const CLAUDE_SETTINGS: readonly ClaudeSettingEntry[];
export function claudeSettingById(id: string): ClaudeSettingEntry | undefined;
export function daysLabel(days: number): string;
