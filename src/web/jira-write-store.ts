import type { JiraGuardOperation } from "./integrations/client";

export type JiraWriteState = { busy: boolean; uncertain: boolean; error: string; draft: string; operation?: JiraGuardOperation; loading?: boolean };
export const states = new Map<string, JiraWriteState>();
export const listeners = new Map<string, Set<(state: JiraWriteState) => void>>();
export const revisions = new Map<string, number>();
