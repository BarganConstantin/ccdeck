import type { AccountsData } from "./claude-accounts";

const record = (v: unknown): v is Record<string, unknown> => v != null && typeof v === "object" && !Array.isArray(v);
const nullableText = (v: unknown) => v == null || typeof v === "string";
const stamp = (v: unknown) => v == null || typeof v === "number" && Number.isFinite(v) && v >= 0 && Number.isFinite(new Date(v).getTime());

/** Runtime guard at the local API boundary. Unknown extra metadata is allowed;
 * malformed required data cannot replace the last usable roster. */
export function isAccountsData(value: unknown): value is AccountsData {
  if (!record(value) || typeof value.ok !== "boolean") return false;
  if (!value.ok) return nullableText(value.reason) && nullableText(value.hint);
  if (!Array.isArray(value.accounts)) return false;
  const slots = new Set<number>();
  return value.accounts.every(a => {
    if (!record(a) || typeof a.num !== "number" || !Number.isInteger(a.num) || (a.num as number) < 1 || slots.has(a.num as number)) return false;
    slots.add(a.num as number);
    if (![a.email, a.alias, a.org, a.orgUuid, a.error].every(nullableText)
      || ![a.active, a.disabled, a.stale].every(v => typeof v === "boolean")
      || !stamp(a.fetchedAt) || !stamp(a.nextAt) || !Array.isArray(a.lanes)) return false;
    const windows = new Set<string>();
    return a.lanes.every(l => {
      if (!record(l) || typeof l.id !== "string" || !l.id || windows.has(l.id) || typeof l.label !== "string"
        || typeof l.pct !== "number" || !Number.isFinite(l.pct) || l.pct < 0 || l.pct > 100
        || !stamp(l.resetAt == null ? null : typeof l.resetAt === "number" ? l.resetAt * 1000 : NaN)) return false;
      windows.add(l.id);
      return true;
    });
  });
}
