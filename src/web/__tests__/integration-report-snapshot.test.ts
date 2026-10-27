import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";
// @ts-expect-error — plain JS server module, no types
import { createIntegrationsStore, META_FILE } from "../../server/integrations/store.mjs";

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
      expect(JSON.stringify(providers)).not.toContain("private");
      expect(JSON.stringify(providers)).not.toContain("token");
    } finally {
      rmTempDir(dir);
    }
  });

  it("distinguishes no connections from unreadable metadata", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ccdeck-no-providers-"));
    try {
      const store = createIntegrationsStore({ dir: () => dir });
      expect(await store.connectedKinds()).toEqual([]);
      writeFileSync(join(dir, META_FILE), "{not-json");
      expect(await store.connectedKinds()).toBeNull();
      writeFileSync(join(dir, META_FILE), JSON.stringify({ version: 1, connections: [] }));
      expect(await store.connectedKinds()).toEqual([]);
    } finally {
      rmTempDir(dir);
    }
  });
});
