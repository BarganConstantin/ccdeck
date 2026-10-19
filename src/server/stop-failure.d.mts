export type StopKind = "login" | "usage-limit" | "api-error";
export interface StopFacts { kind: StopKind; error: string; message: string; at: number }
export const STOP_FAILURE: "StopFailure";
export const STOP_FAILURE_SINCE: string;
export const STOP_MESSAGE_MAX: number;
export function stopKind(error: unknown): StopKind;
export function switchCanCure(kind: StopKind): boolean;
export function stopError(raw: unknown): string;
export function stopMessage(raw: unknown): string;
export function stopFailureOf(raw: unknown, at: number): StopFacts | null;
