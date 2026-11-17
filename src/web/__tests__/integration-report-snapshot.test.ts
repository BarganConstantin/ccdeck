import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// Every file the store opens while it counts, so the case below can say the
// secrets file was never one of them rather than only that it was not needed.
const opened = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async original => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    readFile: async (...args: unknown[]) => {
      opened.push(String(args[0]));
      return Reflect.apply(real.readFile, real, args);
    },
    open: async (...args: unknown[]) => {
      opened.push(String(args[0]));
      return Reflect.apply(real.open, real, args);
    },
  };
});

// @ts-expect-error — plain JS server module, no types
const { createIntegrationsStore, META_FILE, SECRETS_FILE, REPORTED_CONNECTIONS_MAX } = await import("../../server/integrations/store.mjs");

describe("minimal connection snapshots for usage reporting", () => {
  it("reads metadata only, never needs the secrets file or emits identities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-reported-providers-"));
    try {
      writeFileSync(join(dir, META_FILE), JSON.stringify({
        version: 1, connections: [
          { id: "1", kind: "jira", baseUrl: "https://private.example", name: "Secret project" },
          { id: "2", kind: "github", token: "not-a-real-token", account: { login: "private" } },
          { id: "3", kind: "jira" },
          { id: "4", kind: "custom-provider" },
        ],
      }));
      // No secrets file is written: that file must not be required by the reporter.
      const store = createIntegrationsStore({ dir: () => dir });
      const providers = await store.connectedKinds();
      expect(providers).toEqual(["jira", "github"]);
      const counts = await store.connectionCounts();
      expect(counts).toEqual({ jira: 2, github: 1, gitlab: 0 });
      for (const said of [providers, counts]) {
        expect(JSON.stringify(said)).not.toContain("private");
        expect(JSON.stringify(said)).not.toContain("token");
        expect(JSON.stringify(said)).not.toContain("Secret project");
      }
    } finally {
      rmTempDir(dir);
    }
  });

  it("never opens the secrets file to count, even when there is one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-reported-no-secrets-"));
    try {
      writeFileSync(join(dir, META_FILE), JSON.stringify({ version: 1, connections: [{ id: "1", kind: "gitlab" }] }));
      writeFileSync(join(dir, SECRETS_FILE), JSON.stringify({ version: 1, secrets: { "1": "not-a-real-token" } }));
      const store = createIntegrationsStore({ dir: () => dir });
      opened.length = 0;
      expect(await store.connectionCounts()).toEqual({ jira: 0, github: 0, gitlab: 1 });
      expect(await store.connectedKinds()).toEqual(["gitlab"]);
      expect(opened.length).toBeGreaterThan(0);
      expect(opened.every(path => path === join(dir, META_FILE)), opened.join(", ")).toBe(true);
    } finally {
      rmTempDir(dir);
    }
  });

  it("counts only the three providers' entries, and no more than the cap of one kind", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-reported-counts-"));
    try {
      expect(REPORTED_CONNECTIONS_MAX).toBe(50);
      writeFileSync(join(dir, META_FILE), JSON.stringify({
        version: 1, connections: [
          ...Array.from({ length: 60 }, (_, i) => ({ id: `j${i}`, kind: "jira" })),
          { id: "g1", kind: "github" }, { id: "g2", kind: "github" },
          { id: "x", kind: "youtrack" }, { id: "y", kind: "GitLab" }, { id: "z" }, { id: "n", kind: 3 },
          null, 7, "gitlab", ["gitlab"],
        ],
      }));
      const store = createIntegrationsStore({ dir: () => dir });
      expect(await store.connectionCounts()).toEqual({ jira: 50, github: 2, gitlab: 0 });
      expect(await store.connectedKinds()).toEqual(["jira", "github"]);
    } finally {
      rmTempDir(dir);
    }
  });

  it("distinguishes no connections from unreadable metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-no-providers-"));
    try {
      const store = createIntegrationsStore({ dir: () => dir });
      // No file yet: nothing saved, which is a reading, not a failure.
      expect(await store.connectedKinds()).toEqual([]);
      expect(await store.connectionCounts()).toEqual({ jira: 0, github: 0, gitlab: 0 });
      writeFileSync(join(dir, META_FILE), "{not-json");
      expect(await store.connectedKinds()).toBeNull();
      expect(await store.connectionCounts()).toBeNull();
      for (const doc of [{ version: 1 }, { version: 1, connections: { a: { kind: "jira" } } }, null, [{ kind: "jira" }]]) {
        writeFileSync(join(dir, META_FILE), JSON.stringify(doc));
        expect(await store.connectionCounts(), JSON.stringify(doc)).toBeNull();
        expect(await store.connectedKinds(), JSON.stringify(doc)).toBeNull();
      }
      writeFileSync(join(dir, META_FILE), JSON.stringify({ version: 1, connections: [] }));
      expect(await store.connectedKinds()).toEqual([]);
      expect(await store.connectionCounts()).toEqual({ jira: 0, github: 0, gitlab: 0 });
    } finally {
      rmTempDir(dir);
    }
  });
});
