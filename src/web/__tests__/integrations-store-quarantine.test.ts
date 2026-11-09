import { describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const race = vi.hoisted(() => ({ removeBeforeRename: null as string | null }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rename: async (from: string, to: string) => {
    if (from === race.removeBeforeRename) {
      race.removeBeforeRename = null;
      await fs.unlink(from);
    }
    return fs.rename(from, to);
  } };
});

// @ts-expect-error — plain .mjs server module, no types
import { createIntegrationsStore, META_FILE, SECRETS_FILE } from "../../server/integrations/store.mjs";

const permissionChecks = process.platform !== "win32" && process.getuid?.() !== 0;
const fields = { kind: "jira", name: "Fixture", baseUrl: "https://tracker.example.test" };

describe("integration files that cannot be quarantined", () => {
  it.skipIf(!permissionChecks).each([META_FILE, SECRETS_FILE])("refuses to replace %s and preserves both files until quarantine can succeed", async (damagedFile) => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-integrations-quarantine-"));
    const warnings: string[] = [];
    const store = createIntegrationsStore({ dir: () => dir, warn: (msg: string) => warnings.push(msg) });
    try {
      await store.create(fields, "synthetic-original-credential");
      const damagedPath = join(dir, damagedFile);
      writeFileSync(damagedPath, Buffer.concat([readFileSync(damagedPath), Buffer.from("trailing damage")]));
      const originalMeta = readFileSync(join(dir, META_FILE));
      const originalSecrets = readFileSync(join(dir, SECRETS_FILE));
      chmodSync(dir, 0o500);

      await expect(store.create(fields, "synthetic-new-credential")).rejects.toMatchObject({ code: "EACCES" });
      expect(readFileSync(join(dir, META_FILE)).equals(originalMeta)).toBe(true);
      expect(readFileSync(join(dir, SECRETS_FILE)).equals(originalSecrets)).toBe(true);
      expect(readdirSync(dir).sort()).toEqual([META_FILE, SECRETS_FILE].sort());
      expect(warnings).toEqual([]);

      chmodSync(dir, 0o700);
      const created = await store.create(fields, "synthetic-new-credential");
      expect(created.tokenSaved).toBe(true);
      expect(await store.secret(created.id)).toBe("synthetic-new-credential");
      const backups = readdirSync(dir).filter(name => name.startsWith(`${damagedFile}.corrupt-`));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0])).equals(damagedFile === META_FILE ? originalMeta : originalSecrets)).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("was moved aside");
      expect(warnings.join(" ")).not.toContain("synthetic-");
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([META_FILE, SECRETS_FILE])("preserves damaged %s in a private backup before allowing a fresh save", async (damagedFile) => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-integrations-backup-"));
    const warnings: string[] = [];
    const store = createIntegrationsStore({ dir: () => dir, warn: (msg: string) => warnings.push(msg) });
    try {
      await store.create(fields, "synthetic-original-credential");
      const path = join(dir, damagedFile);
      const damaged = Buffer.concat([readFileSync(path), Buffer.from("trailing damage")]);
      writeFileSync(path, damaged);
      const created = await store.create(fields, "synthetic-new-credential");
      expect(await store.secret(created.id)).toBe("synthetic-new-credential");
      const backups = readdirSync(dir).filter(name => name.startsWith(`${damagedFile}.corrupt-`));
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0])).equals(damaged)).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(join(dir, backups[0]));
      expect(warnings.join(" ")).not.toContain("synthetic-");
      expect(JSON.stringify(await store.list())).not.toContain("synthetic-");
      if (process.platform !== "win32") {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        for (const name of [META_FILE, SECRETS_FILE, backups[0]]) {
          expect(statSync(join(dir, name)).mode & 0o777).toBe(0o600);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("allows a file removed by another reader without claiming that this reader backed it up", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-integrations-quarantine-race-"));
    const warnings: string[] = [];
    const store = createIntegrationsStore({ dir: () => dir, warn: (msg: string) => warnings.push(msg) });
    try {
      writeFileSync(join(dir, META_FILE), "damaged fixture", { mode: 0o600 });
      race.removeBeforeRename = join(dir, META_FILE);
      const created = await store.create(fields, "synthetic-new-credential");
      expect(await store.get(created.id)).toMatchObject({ id: created.id, tokenSaved: true });
      expect(warnings).toEqual([]);
      expect(readdirSync(dir).sort()).toEqual([META_FILE, SECRETS_FILE].sort());
    } finally {
      race.removeBeforeRename = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
