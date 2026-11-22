export type ProviderId = "claude" | "codex" | "opencode" | "copilot";
export type EventOnlyProvider = "opencode" | "copilot";
export const PROVIDERS: readonly ProviderId[];
export const EVENT_ONLY_PROVIDERS: readonly EventOnlyProvider[];
export function providerOf(name: unknown): ProviderId;
export function payloadProvider(raw: unknown): ProviderId;
export function isEventOnly(name: unknown): name is EventOnlyProvider;
