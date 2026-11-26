// The deck's half of a picture pasted into Chat (chat-image.mjs): what it
// takes as a picture, where and how it keeps one, and how the folder is kept
// small. The route in front of it is in terminal-routes.test.ts.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { rmTempDir } from "./rm-temp-dir";

// @ts-expect-error — plain .mjs server module, no types
const mod = await import("../../server/chat-image.mjs");
const {
  CHAT_IMAGE_KEEP_COUNT, CHAT_IMAGE_KEEP_MS, CHAT_IMAGE_MAX_BYTES,
  chatImageDir, chatImageKind, pruneChatImages, saveChatImage,
} = mod;

const ROOT = mkdtempSync(join(tmpdir(), "ccdeck-chat-image-"));
afterAll(() => rmTempDir(ROOT));
let n = 0;
const fresh = () => join(ROOT, `case-${++n}`, "chat-images");

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const GIF = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

describe("what the deck takes as a picture", () => {
  it("knows PNG, JPEG, GIF and WebP by their first bytes", () => {
    expect([PNG, JPEG, GIF, WEBP].map(chatImageKind)).toEqual(["png", "jpg", "gif", "webp"]);
    expect(chatImageKind(Buffer.from("GIF87a", "latin1"))).toBe("gif");
  });

  it("refuses anything else, whatever it says it is", () => {
    for (const bytes of [Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), Buffer.from("II*\0"), Buffer.alloc(0),
      PNG.subarray(0, 7), Buffer.from("RIFF\0\0\0\0WAVE"), Buffer.from("#!/bin/sh\n")]) {
      expect(chatImageKind(bytes)).toBeNull();
    }
    expect(chatImageKind("\x89PNG\r\n\x1a\n")).toBeNull();
    expect(chatImageKind(null)).toBeNull();
  });
});

describe("keeping a picture", () => {
  it("in the deck's data folder, under a random name its bytes earned, and answers the path", async () => {
    expect(chatImageDir("/data/ccdeck")).toBe(join("/data/ccdeck", "chat-images"));
    const dir = fresh();
    const one = await saveChatImage(PNG, { dir });
    const two = await saveChatImage(JPEG, { dir });
    expect(one.ok && two.ok).toBe(true);
    expect(dirname(one.path)).toBe(dir);
    expect(one.path).toMatch(/[\\/][0-9a-f]{32}\.png$/);
    expect(two.path).toMatch(/[\\/][0-9a-f]{32}\.jpg$/);
    expect(one.path).not.toBe(two.path);
    expect(readFileSync(one.path).equals(PNG)).toBe(true);
    expect(readFileSync(two.path).equals(JPEG)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("in a folder only this user reads, each file the same", async () => {
    const dir = fresh();
    const saved = await saveChatImage(GIF, { dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(saved.path).mode & 0o777).toBe(0o600);
  });

  it("refuses what is not a picture, or is over the cap, and writes nothing", async () => {
    const dir = fresh();
    expect(await saveChatImage(Buffer.from("hello"), { dir })).toEqual({ ok: false, code: "not-image" });
    const big = Buffer.concat([PNG, Buffer.alloc(CHAT_IMAGE_MAX_BYTES)]);
    expect(await saveChatImage(big, { dir })).toEqual({ ok: false, code: "too-large" });
    expect(() => readdirSync(dir)).toThrow();
  });

  it("says failed, and never throws, where the folder cannot be made", async () => {
    const file = join(ROOT, "a-file");
    writeFileSync(file, "x");
    expect(await saveChatImage(PNG, { dir: join(file, "chat-images") })).toEqual({ ok: false, code: "failed" });
  });
});

describe("the folder is kept small", () => {
  const name = (i: number) => `${i.toString(16).padStart(32, "0")}.png`;

  it("removes pictures older than a week, and keeps the newer ones", async () => {
    const dir = fresh();
    await saveChatImage(PNG, { dir });
    const now = Date.now();
    const old = join(dir, name(1));
    const recent = join(dir, name(2));
    writeFileSync(old, PNG);
    writeFileSync(recent, PNG);
    utimesSync(old, new Date(now - CHAT_IMAGE_KEEP_MS - 60_000), new Date(now - CHAT_IMAGE_KEEP_MS - 60_000));
    utimesSync(recent, new Date(now - 60_000), new Date(now - 60_000));
    await pruneChatImages(dir, now);
    expect(readdirSync(dir)).not.toContain(name(1));
    expect(readdirSync(dir)).toContain(name(2));
  });

  it("keeps no more than the newest hundred once a new one is added", async () => {
    const dir = fresh();
    await saveChatImage(PNG, { dir });
    const now = Date.now();
    for (let i = 1; i <= CHAT_IMAGE_KEEP_COUNT + 5; i++) {
      const path = join(dir, name(i));
      writeFileSync(path, PNG);
      utimesSync(path, new Date(now - i * 1000), new Date(now - i * 1000));
    }
    const saved = await saveChatImage(PNG, { dir, now });
    const left = readdirSync(dir);
    expect(left).toHaveLength(CHAT_IMAGE_KEEP_COUNT);
    expect(left).toContain(saved.path.split(/[\\/]/).pop());
    expect(left, "the newest stay").toContain(name(1));
    expect(left, "the oldest go").not.toContain(name(CHAT_IMAGE_KEEP_COUNT + 5));
  });

  it("removes only the names it gives, and never what a link points at", async () => {
    const dir = fresh();
    await saveChatImage(PNG, { dir });
    const long = new Date(Date.now() - CHAT_IMAGE_KEEP_MS * 2);
    const foreign = join(dir, "notes.png");
    writeFileSync(foreign, PNG);
    utimesSync(foreign, long, long);
    const target = join(ROOT, `kept-${n}.png`);
    writeFileSync(target, PNG);
    utimesSync(target, long, long);
    let linked = false;
    try { symlinkSync(target, join(dir, name(7))); linked = true; } catch { /* no symlinks here (Windows without the right) */ }
    await pruneChatImages(dir, Date.now());
    expect(readdirSync(dir)).toContain("notes.png");
    expect(readFileSync(target).equals(PNG)).toBe(true);
    if (linked) expect(readdirSync(dir)).toContain(name(7));
  });
});
