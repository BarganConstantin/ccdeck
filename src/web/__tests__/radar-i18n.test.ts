// Radar is translated (area "radar"): every key a component builds at run time
// exists, the server's English sentences map to a key, and the helpers answer
// in the language they are given.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { en } from "../i18n/en";
import { catalogFor } from "../i18n/catalogs";
import { translate } from "../i18n/translate";
import { serverText } from "../radar-server-text";
import { outcomeLabel } from "../components/TelemetryCapture";
import { telemetryLine, switchedTelemetry } from "../org-telemetry";
import { configuredState, configuredKind } from "../telemetry-inspection";
import { radarMonitorState } from "../radar-monitor-state";

const tIn = (lang: string) => (key: string, vars?: Record<string, string | number>) => translate(lang, catalogFor(lang), key, vars);
const LANGS = ["zh-TW", "zh-CN", "de", "ja"];

describe("radar keys built at run time", () => {
  const dynamic = [
    ...["unconfirmed", "accepted", "partial", "rejected", "unknown", "reset"].map(k => `radar.outcome.${k}`),
    ...["accepted", "unconfirmed", "partial", "rejected", "unknown"].map(k => `radar.receipt.${k}`),
    ...["logs", "metrics", "traces"].map(k => `radar.insp.decoded.${k}`),
    ...["encrypted", "joined_midstream", "capture_gap", "decode_failed", "payload_limit", "stream_limit", "connection_limit", "unsupported_compression", "unsupported_link", "unsupported_network", "fragmented", "unknown_export", "connection_closed", "idle_connection"].map(k => `radar.issue.${k}`),
    ...["error", "prompt", "response", "project", "directory", "repository", "branch", "tool", "toolInput", "toolResult", "model", "inputTokens", "outputTokens", "cacheRead", "cacheCreation", "cost", "duration", "ttft", "success", "stopReason", "tokenType"].map(k => `radar.field.${k}`),
  ];
  it("all exist in English and in every language", () => {
    for (const key of dynamic) {
      expect(en[key], key).toBeTypeOf("string");
      for (const lang of LANGS) expect(catalogFor(lang)[key], `${lang} ${key}`).toBeTypeOf("string");
    }
  });
  it("every radar key is translated in every language", () => {
    const plain = (k: string) => k.replace(/\.(one|other)$/, "");
    for (const lang of LANGS) {
      const have = new Set(Object.keys(catalogFor(lang)).map(plain));
      const missing = Object.keys(en).filter(k => k.startsWith("radar.") && !have.has(plain(k)));
      expect(missing, lang).toEqual([]);
    }
  });
  it("every radar component reads its text from t()", () => {
    for (const file of ["TelemetryCapture", "TrafficRadar", "TelemetryFile", "JsonInspector", "RadarSplitter", "RadarPromptPreview", "RadarSettings", "WatchRadar"]) {
      expect(readFileSync(new URL(`../components/${file}.tsx`, import.meta.url), "utf8"), file).toMatch(/useT\(\)/);
    }
  });
});

describe("the server's English sentences", () => {
  it("map to the language on show and pass anything else through", () => {
    const de = tIn("de");
    expect(serverText("Nobody answered the password prompt.", de)).toBe("Die Passwortabfrage wurde nicht beantwortet.");
    expect(serverText("Enabled", de)).toBe("Aktiviert");
    expect(serverText("macOS refused: the setup did not finish.", de)).toBe("macOS hat abgelehnt: the setup did not finish.");
    expect(serverText("Process launch environment · PID 12 and 2 more", de)).toBe("Startumgebung des Prozesses · PID 12 und 2 weitere");
    expect(serverText("tcpdump: eth0: No such device", de)).toBe("tcpdump: eth0: No such device");
    expect(serverText(null, de)).toBe("");
  });
  it("every mapped sentence has a key in English", () => {
    const source = readFileSync(new URL("../radar-server-text.ts", import.meta.url), "utf8");
    for (const m of source.matchAll(/: "(radar\.[\w.]+)"/g)) expect(en[m[1]], m[1]).toBeTypeOf("string");
  });
});

describe("helpers answer in the language they are given", () => {
  it("outcome, monitor state and configured state", () => {
    expect(outcomeLabel({ outcome: "accepted" } as never, tIn("ja"))).toBe("コレクターが受理");
    expect(radarMonitorState(null, true, tIn("zh-TW")).title).toBe("與監控的連線已中斷");
    const vars = [{ key: "CLAUDE_CODE_ENABLE_TELEMETRY", value: "Enabled", source: "User settings" }];
    expect(configuredState(vars, tIn("de"))).toBe("In den Einstellungen aktiviert");
    expect(configuredKind(vars)).toBe("enabled");
  });
  it("the organization's telemetry line", () => {
    const org = { level: "content" as const, content: ["OTEL_LOG_USER_PROMPTS", "OTEL_LOG_TOOL_DETAILS"], destinations: ["a.example"], orgName: "Acme", seenAt: 0 } as never;
    const line = telemetryLine(org, 60, { tr: tIn("de") });
    expect(line?.text).toBe("Telemetrie · Prompts, Tool-Details");
    expect(switchedTelemetry(org, tIn("zh-CN"))).toContain("Acme 的遥测");
  });
});
