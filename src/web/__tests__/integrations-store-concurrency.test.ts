import { describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pause after a real read has obtained its bytes. The store's parsing,
// quarantine, atomic writes and public operations remain production code.
const fault = vi.hoisted(() => ({
  pauseRead: null as null | ((path: string) => (() => Promise<void>) | undefined),
}));
vi.mock("node:fs/promises", async original => {
  const fs = await original<typeof import("node:fs/promises")>();
  return { ...fs, readFile: async (...args: unknown[]) => {
    const pause = fault.pauseRead?.(String(args[0]));
    const bytes = await Reflect.apply(fs.readFile, fs, args);
    await pause?.();
    return bytes;
  } };
});

// @ts-expect-error — plain .mjs server module, no types
import { createIntegrationsStore, META_FILE, SECRETS_FILE } from "../../server/integrations/store.mjs";

function gate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  return { promise, open };
}
const fields = { kind: "jira", name: "Fixture", baseUrl: "https://tracker.example.test" };

describe("integration reads overlapping a save", () => {
  it("never quarantines freshly saved metadata using a concurrent list's stale damaged bytes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-integrations-concurrency-"));
    const warnings: string[] = [];
    const store = createIntegrationsStore({ dir: () => dir, warn: (msg: string) => warnings.push(msg) });
    const writerEntered = gate(), writerRelease = gate(), readerEntered = gate(), readerRelease = gate();
    let writing: Promise<{ id: string }> | undefined, reading: Promise<unknown> | undefined;
    try {
      await store.create(fields, "synthetic-original-credential");
      const metaPath = join(dir, META_FILE);
      const damaged = Buffer.concat([readFileSync(metaPath), Buffer.from("trailing damage")]);
      writeFileSync(metaPath, damaged);
      let reads = 0;
      fault.pauseRead = path => {
        if (path !== metaPath) return;
        const read = ++reads;
        if (read === 1) return async () => { writerEntered.open(); await writerRelease.promise; };
        if (read === 2) return async () => { readerEntered.open(); await readerRelease.promise; };
      };

      writing = store.create(fields, "synthetic-fresh-credential");
      await writerEntered.promise;
      reading = store.list();
      // An unguarded list enters readFile synchronously. If it entered, ensure
      // it has really read the old bytes before letting the writer finish.
      // A serialized list has not entered and will see the completed save.
      if (reads === 2) await readerEntered.promise;
      writerRelease.open();
      const created = await writing;
      const fresh = readFileSync(metaPath);
      expect(JSON.parse(fresh.toString()).connections.map((c: { id: string }) => c.id)).toEqual([created.id]);
      expect(JSON.parse(readFileSync(join(dir, SECRETS_FILE), "utf8")).secrets[created.id]).toBe("synthetic-fresh-credential");

      readerRelease.open();
      await reading;
      const metadataRetained = existsSync(metaPath) && readFileSync(metaPath).equals(fresh);
      const backups = readdirSync(dir).filter(name => name.startsWith(`${META_FILE}.corrupt-`));
      const freshMetadataQuarantined = backups.some(name => readFileSync(join(dir, name)).equals(fresh));
      const second = await store.create(fields, "synthetic-second-credential");
      const freshCredentialRetained = JSON.parse(readFileSync(join(dir, SECRETS_FILE), "utf8")).secrets[created.id] === "synthetic-fresh-credential";

      expect({ metadataRetained, freshMetadataQuarantined, freshCredentialRetained }).toEqual({
        metadataRetained: true, freshMetadataQuarantined: false, freshCredentialRetained: true,
      });
      expect(await store.list()).toHaveLength(2);
      expect(await store.get(created.id)).toMatchObject({ id: created.id, tokenSaved: true });
      expect(await store.secret(created.id)).toBe("synthetic-fresh-credential");
      expect(await store.secret(second.id)).toBe("synthetic-second-credential");
      expect(backups).toHaveLength(1);
      expect(readFileSync(join(dir, backups[0])).equals(damaged)).toBe(true);
      expect(warnings).toHaveLength(1);
      expect(warnings.join(" ")).not.toContain("synthetic-");

      // Subsequent transactions must still finish and preserve their public
      // read contracts; an accidentally nested queue would deadlock here.
      await store.update(created.id, { name: "Renamed fixture" });
      expect(await store.get(created.id)).toMatchObject({ name: "Renamed fixture", tokenSaved: true });
      expect(await store.secret(created.id)).toBe("synthetic-fresh-credential");
      await store.update(created.id, {}, "synthetic-rotated-credential");
      expect(await store.secret(created.id)).toBe("synthetic-rotated-credential");
      expect(await store.remove(created.id)).toBe(true);
      expect(await store.get(created.id)).toBeNull();
      expect(await store.secret(created.id)).toBeNull();
      expect((await store.list()).map((conn: { id: string }) => conn.id)).toEqual([second.id]);
    } finally {
      writerRelease.open();
      readerRelease.open();
      await Promise.allSettled([writing, reading]);
      fault.pauseRead = null;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
