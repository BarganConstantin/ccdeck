// #1732. Codex session ids are UUIDv7, and a UUIDv7 opens with the moment it was
// minted: 48 bits of Unix milliseconds, so its first four hex digits change only
// every 2^32 ms (about 49.7 days) and its first eight every 2^16 ms (about
// 65.5 s). Every place that told two sessions apart by the HEAD of the id —
// four characters on a cluster header and in the usage list's BY SESSION rows,
// eight in an export's file name — therefore gave two Codex sessions started a
// few days apart the same suffix, which is the "identical rows carrying
// different figures" the suffix exists to prevent. The unit tests used ids like
// `aaaa…` and `bbbb…`, so the collision never showed.
//
// The ids here are built the way Codex builds them: the timestamp hex-encoded
// into the first twelve digits, the version nibble 7, and a random tail.
import { describe, it, expect } from "vitest";
import { distinctSessionLabels } from "../usage-session-join";
import { clusterBounds, type ClusterNode } from "../cluster-bounds";
import { clusterHeader } from "../cluster-header";
import { exportFileName } from "../session-export";
import type { AgentNodeData } from "../types";

/** A UUIDv7 minted at `iso`, with `tail` (twenty hex digits) as its random bits. */
function uuidv7(iso: string, tail: string): string {
  const hex = Date.parse(iso).toString(16).padStart(12, "0") + "7" + tail.slice(0, 3) + "8" + tail.slice(3, 18);
  expect(hex).toHaveLength(32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Three days apart: the same first four digits, as every Codex session from late
// August to mid-October 2026 has.
const MON = uuidv7("2026-09-14T09:00:00.000Z", "3c1e9a07d2b54f6e81");
const THU = uuidv7("2026-09-17T15:30:00.000Z", "a4f0217c9e3d88b105");
// Thirty seconds apart, inside one 65.5 s bucket: the same first eight.
const T0 = uuidv7("2026-09-17T15:30:05.000Z", "5d2e8b40f19c3a7e62");
const T30 = uuidv7("2026-09-17T15:30:35.000Z", "e97b03c6a45d1f28b4");

// Two Claude ids, UUIDv4: random from the first character.
const V4A = "4efa1c2d-8b3e-4f10-9a7c-5d6e2f1b0a93";
const V4B = "9bd70e41-2c5a-4b8d-8e3f-7a1c6d0b4e25";

describe("the ids this is about", () => {
  it("share their heads, which is the whole defect", () => {
    expect(MON.slice(0, 4)).toBe(THU.slice(0, 4));
    expect(T0.slice(0, 8)).toBe(T30.slice(0, 8));
  });
});

describe("the usage list's BY SESSION rows", () => {
  const row = (sessionId: string, label: string) => ({ sessionId, label, cost: 1 });

  it("gives two Codex sessions in one folder two different labels", () => {
    const [a, b] = distinctSessionLabels([row(MON, "ccdeck"), row(THU, "ccdeck")]);
    expect(a.label).not.toBe(b.label);
  });

  it("still tells two Claude sessions apart", () => {
    const [a, b] = distinctSessionLabels([row(V4A, "ccdeck"), row(V4B, "ccdeck")]);
    expect(a.label).not.toBe(b.label);
  });

  it("grows the suffix when four characters are not enough", () => {
    // Two ids whose last four digits happen to agree, one time in 65,536.
    const x = "0190aaaa-0000-7000-8000-00000001beef";
    const y = "0190aaaa-0000-7000-8000-00000002beef";
    const [a, b] = distinctSessionLabels([row(x, "ccdeck"), row(y, "ccdeck")]);
    expect(a.label).not.toBe(b.label);
  });
});

describe("a cluster header's short id", () => {
  it("differs between two Codex sessions in one workspace", () => {
    expect(clusterHeader("ccdeck", undefined, MON, true).shortId)
      .not.toBe(clusterHeader("ccdeck", undefined, THU, true).shortId);
  });

  it("still differs between two Claude sessions", () => {
    expect(clusterHeader("ccdeck", undefined, V4A, true).shortId)
      .not.toBe(clusterHeader("ccdeck", undefined, V4B, true).shortId);
  });

  it("grows on the canvas until the colliding sessions differ", () => {
    const card = (sessionId: string, x: number): ClusterNode => ({
      type: "agent",
      position: { x, y: 0 },
      width: 276,
      height: 120,
      data: { sessionId, kind: "root", label: "ccdeck", state: "active" } as AgentNodeData,
    });
    const x = "0190aaaa-0000-7000-8000-00000001beef";
    const y = "0190aaaa-0000-7000-8000-00000002beef";
    const [a, b] = clusterBounds([card(x, 0), card(y, 900)]);
    expect(a.shortId).not.toBe(b.shortId);
  });
});

describe("an export's file name", () => {
  it("differs between two Codex sessions started thirty seconds apart", () => {
    expect(exportFileName("ccdeck", T0)).not.toBe(exportFileName("ccdeck", T30));
  });

  it("still differs between two Claude sessions", () => {
    expect(exportFileName("ccdeck", V4A)).not.toBe(exportFileName("ccdeck", V4B));
  });
});
