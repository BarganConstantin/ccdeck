// The manifest over HTTP: served on a port somebody chose, withdrawn otherwise.
//
// installable-app.test.ts pins the file and the rule; this one boots the real
// server twice and asks it. Both halves are worth the boot:
//
//   * the 404 half is the one that protects users. An installed app is pinned
//     to an origin, an origin includes the port, and a deck that fell back to a
//     random 4318–4400 draws a new number every start. Somebody who installed
//     from one of those would collect a dead tile per boot.
//   * the 200 half is the one that rots silently. Served as the wrong type — the
//     MIME fallback is application/octet-stream — the browser fetches the file,
//     declines to parse it and offers no install, with nothing in the console
//     that names the reason. A test that only read the file on disk would pass
//     through that forever.
import { describe, it, expect, afterAll } from "vitest";
import { rmTempDir } from "./rm-temp-dir";
import { mkdtempSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { get } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "ccdeck-installable-"));
const prevEnv = { ...process.env };
process.env.HOME = DIR;
process.env.USERPROFILE = DIR;
process.env.CLAUDE_CONFIG_DIR = join(DIR, "claude");
process.env.CODEX_HOME = join(DIR, "codex");

// @ts-expect-error — .mjs server module, no types
const { startServer } = await import("../../server/index.mjs");

interface Answer { status: number; type: string; body: string }

function fetchPath(port: number, path: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = get({ host: "127.0.0.1", port, path }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", c => { body += c; });
      res.on("end", () => resolve({
        status: res.statusCode ?? 0,
        type: String(res.headers["content-type"] ?? ""),
        body,
      }));
    });
    req.on("error", reject);
    req.setTimeout(5_000, () => req.destroy(new Error(`no answer for ${path}`)));
  });
}

/** A port nothing is on, found by binding one and letting it go. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(err => (err ? reject(err) : resolve(port)));
    });
  });
}

const stop = (s: { close: (cb: () => void) => void }) =>
  new Promise<void>(done => s.close(() => done()));

afterAll(() => {
  for (const k of ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
    if (prevEnv[k] === undefined) delete process.env[k];
    else process.env[k] = prevEnv[k] as string;
  }
  rmTempDir(DIR);
});

describe("a deck on the port it asked for", () => {
  it("serves the manifest, as a manifest", async () => {
    const want = await freePort();
    const server = await startServer({ port: want, host: "127.0.0.1", persist: null, codex: false });
    try {
      expect((server.address() as AddressInfo).port,
        "the probe's port was taken again between closing it and asking for it").toBe(want);
      const answer = await fetchPath(want, "/manifest.webmanifest");
      expect(answer.status).toBe(200);
      // The type is the whole of how a browser recognises this file.
      expect(answer.type).toMatch(/^application\/manifest\+json/);
      const manifest = JSON.parse(answer.body);
      expect(manifest.name).toBe("ccdeck");
      // And the icons it names are really there, as images. A manifest whose
      // icons 404 is an install Chrome refuses without saying so.
      for (const icon of manifest.icons) {
        const asset = await fetchPath(want, `/${icon.src}`);
        expect(asset.status, `${icon.src} is named by the manifest`).toBe(200);
        expect(asset.type).toBe(icon.type);
      }
    } finally {
      await stop(server);
    }
  });
});

describe("a deck on a port nobody chose", () => {
  it("withdraws the manifest rather than promising an origin it will not keep", async () => {
    // `port: 0` is the ephemeral case in its purest form, and it is also how
    // every in-process test in this suite boots: the request and the candidate
    // agree at 0 while the deck listens on a number that differs every run.
    const server = await startServer({ port: 0, host: "127.0.0.1", persist: null, codex: false });
    try {
      const port = (server.address() as AddressInfo).port;
      expect(port).not.toBe(0);
      const answer = await fetchPath(port, "/manifest.webmanifest");
      expect(answer.status).toBe(404);
      // A 404, not a shell: serveStatic falls back to index.html for a path it
      // cannot find, and an install control that appeared and then parsed HTML
      // is worse than one that never appeared.
      expect(answer.type).not.toMatch(/text\/html/);
      // The deck itself is unaffected — this withdraws an icon, not a feature.
      expect((await fetchPath(port, "/")).status).toBe(200);
    } finally {
      await stop(server);
    }
  });
});
