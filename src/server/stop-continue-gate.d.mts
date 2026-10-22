import type { StopFacts } from "./stop-failure.mjs";
export interface LoginEvidence { ok: boolean; at: number; room: boolean | null }
export type GateReason = "no-login" | "before-stop" | "no-room";
export interface Gate { ready: boolean; reason: GateReason | null }
export const CONTINUE_PROMPT: string;
export const REPEAT_HOLD_MS: number;
export function loginEvidence(reading: unknown): LoginEvidence | null;
export function continueGate(stop: Pick<StopFacts, "kind" | "at"> | null | undefined, login: LoginEvidence | null | undefined): Gate;
