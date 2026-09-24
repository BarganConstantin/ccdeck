import { describe, expect, it } from "vitest";
// @ts-expect-error plain JS module
import { cachedExportReadable, exportVerdictOk, storedCopyAlive } from "../../server/account-health.mjs";
// @ts-expect-error plain JS module
import { cachedVerdictFor } from "../../server/claude-accounts.mjs";

describe("account health for LAN sync", () => {
  it.each(["no_credentials", "relogin_required", "foreign_credential"])("treats %s as a lost stored copy", verdict => {
    expect(storedCopyAlive(true, verdict)).toBe(false);
    expect(cachedExportReadable(verdict)).toBe(false);
  });

  it.each(["keychain_unavailable", "token_expired"])("preserves the stored copy while %s prevents a reliable check", verdict => {
    expect(storedCopyAlive(false, verdict)).toBe(true);
    expect(cachedExportReadable(verdict)).toBe(false);
  });

  it("requires an explicit positive verdict for an actual export", () => {
    expect(exportVerdictOk("ok")).toBe(true);
    for (const status of [null, undefined, "", "unknown_status", "unavailable", "api_key", "foreign_credential", "token_expired", "keychain_unavailable"]) {
      expect(exportVerdictOk(status), String(status)).toBe(false);
    }
    expect(cachedExportReadable(null)).toBe(true); // old collector; checked again at export
    expect(storedCopyAlive(true, null)).toBe(true);
  });

  it("refuses the active account without a fresh verdict, because its export is the live login", () => {
    expect(cachedExportReadable(null, { active: true })).toBe(false);
    expect(cachedExportReadable(undefined, { active: true })).toBe(false);
    expect(cachedExportReadable("ok", { active: true })).toBe(true);
    expect(cachedExportReadable(null, { active: false })).toBe(true);
  });

  it("never attaches a slot's old verdict to its replacement or another organization", () => {
    const cache = { at: 1_000, byNum: { 5: "ok" }, identities: { 5: "old@example.test@@org-1" } };
    expect(cachedVerdictFor(cache, 5, 1_001, "old@example.test", "org-1")).toBe("ok");
    expect(cachedVerdictFor(cache, 5, 1_001, "new@example.test", "org-1")).toBeNull();
    expect(cachedVerdictFor(cache, 5, 1_001, "old@example.test", "org-2")).toBeNull();
    expect(cachedVerdictFor(cache, 5, 1_000 + 11 * 60_000, "old@example.test", "org-1")).toBeNull();
  });
});
