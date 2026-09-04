// The artifact name is the one part of the uv bootstrap that cannot be checked
// on the machine running the tests: a wrong name is a 404 on someone else's
// Windows box and nothing here. Every expected value below was taken from the
// asset list of an actual astral-sh/uv release.
import { describe, it, expect } from "vitest";
// @ts-expect-error — .mjs server module, no types
import { assetName, detectLibc } from "../../server/uv-bootstrap.mjs";

describe("uv release artifact names", () => {
  it("matches what astral-sh/uv actually publishes", () => {
    expect(assetName("darwin", "arm64")).toBe("uv-aarch64-apple-darwin.tar.gz");
    expect(assetName("darwin", "x64")).toBe("uv-x86_64-apple-darwin.tar.gz");
    expect(assetName("win32", "x64")).toBe("uv-x86_64-pc-windows-msvc.zip");
    expect(assetName("win32", "arm64")).toBe("uv-aarch64-pc-windows-msvc.zip");
    expect(assetName("win32", "ia32")).toBe("uv-i686-pc-windows-msvc.zip");
    // The libc is spelled out: the default reads THIS machine's, and a Mac has
    // no glibc field for the same reason a musl box does not.
    expect(assetName("linux", "x64", "glibc")).toBe("uv-x86_64-unknown-linux-gnu.tar.gz");
    expect(assetName("linux", "arm64", "glibc")).toBe("uv-aarch64-unknown-linux-gnu.tar.gz");
  });

  it("uses .zip on Windows and .tar.gz elsewhere — the two are unpacked differently", () => {
    expect(assetName("win32", "x64")!.endsWith(".zip")).toBe(true);
    expect(assetName("darwin", "arm64")!.endsWith(".tar.gz")).toBe(true);
    expect(assetName("linux", "x64")!.endsWith(".tar.gz")).toBe(true);
  });

  it("returns null rather than a guess where no build exists", () => {
    expect(assetName("darwin", "ia32")).toBeNull();      // Apple never shipped one
    expect(assetName("linux", "mips" as never)).toBeNull();
    expect(assetName("aix", "x64")).toBeNull();
  });
});

describe("the C library, which is a target and not a detail", () => {
  it("asks for the musl build on a musl machine", () => {
    // Alpine — including every `node:alpine` image. The glibc ELF interpreter
    // is absent there, so the gnu binary cannot start at all: `bootstrapUv`
    // returns `does_not_run`, and because ensureCswap runs whenever
    // cswapVersion() is null the 35 MB archive is fetched, hashed and extracted
    // again on EVERY launch, with the accounts panel permanently unavailable.
    expect(assetName("linux", "x64", "musl")).toBe("uv-x86_64-unknown-linux-musl.tar.gz");
    expect(assetName("linux", "arm64", "musl")).toBe("uv-aarch64-unknown-linux-musl.tar.gz");
    expect(assetName("linux", "x64", "glibc")).toBe("uv-x86_64-unknown-linux-gnu.tar.gz");
  });

  it("reads musl as the absence of a glibc version in Node's own report", () => {
    const glibc = () => ({ header: { glibcVersionRuntime: "2.39" } });
    const musl = () => ({ header: { arch: "x64" } });
    expect(detectLibc("linux", glibc)).toBe("glibc");
    expect(detectLibc("linux", musl)).toBe("musl");
  });

  it("does not ask the question on platforms that have no glibc either", () => {
    // macOS and Windows have no such field, so reading its absence as musl
    // would answer "musl" for every Mac.
    const musl = () => ({ header: { arch: "arm64" } });
    expect(detectLibc("darwin", musl)).toBe("glibc");
    expect(detectLibc("win32", musl)).toBe("glibc");
  });

  it("falls back to glibc when the report cannot be read", () => {
    // The wrong guess there is exactly the state this code was already in, and
    // glibc is the overwhelmingly common case.
    expect(detectLibc("linux", () => { throw new Error("no report"); })).toBe("glibc");
    expect(detectLibc("linux", () => undefined)).toBe("glibc");
  });

  it("knows armv7, which uv publishes and a Raspberry Pi runs", () => {
    // `arm` is 32-bit ARM — the armhf Pi OS image. It used to get
    // `unsupported_platform` for a target that exists.
    expect(assetName("linux", "arm", "glibc")).toBe("uv-armv7-unknown-linux-gnu.tar.gz");
    expect(assetName("linux", "arm", "musl")).toBe("uv-armv7-unknown-linux-musl.tar.gz");
  });
});
