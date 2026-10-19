import { describe, expect, it } from "vitest";
import { attributes, fieldEvidence, projectEvidence, recordPriority, promptPreview, PROMPT_FIELDS } from "../telemetry-highlights";

describe("telemetry content evidence", () => {
  it("previews actual prompt text, skips redacted duplicates, and bounds long content", () => {
    const payload = (values: string[]) => ({ resourceLogs: [{ scopeLogs: [{ logRecords: values.map(value => ({ attributes: [{ key: "prompt", value: { stringValue: value } }] })) }] }] });
    expect(promptPreview(payload(["[REDACTED]"]))).toBe("Prompt redacted");
    expect(promptPreview(payload(["[REDACTED]", "Please\n inspect   this project"]))).toBe("Please inspect this project");
    expect(promptPreview(payload(["x".repeat(300)]))).toBe("x".repeat(180) + "…");
    expect(promptPreview({})).toBeNull();
  });
  it("distinguishes absent, redacted and actual prompt content and prefers a readable alias", () => {
    expect(fieldEvidence({ prompt_length: 42 }, PROMPT_FIELDS).state).toBe("absent");
    expect(fieldEvidence({ prompt: "[REDACTED]" }, PROMPT_FIELDS).state).toBe("redacted");
    expect(fieldEvidence({ prompt_text: "[REDACTED]", user_prompt: "The actual exported prompt" }, PROMPT_FIELDS)).toMatchObject({ state: "included", key: "user_prompt", value: "The actual exported prompt" });
    expect(fieldEvidence({ prompt: "Discuss the word redacted" }, PROMPT_FIELDS).state).toBe("included");
  });
  it("uses exported project context ahead of matching local metadata", () => {
    expect(projectEvidence({ cwd: "/captured/project", "session.id": "s" }, [{ id: "s", label: "other", workspace: "/local/other" }])).toMatchObject({ source: "export", directory: { value: "/captured/project" } });
  });
  it("labels a local directory as local only when the captured session ID matches exactly", () => {
    const sessions = [{ id: "s", label: "ccdeck", workspace: "/work/ccdeck" }];
    expect(projectEvidence({ "session.id": "s" }, sessions)).toMatchObject({ source: "local", directory: { value: "/work/ccdeck" } });
    expect(projectEvidence({ "session.id": "s" }, [{ ...sessions[0], label: "Inspect telemetry", project: "ccdeck" }])).toMatchObject({ project: { value: "ccdeck" } });
    expect(projectEvidence({ "session.id": "unknown" }, sessions).source).toBe("absent");
    expect(projectEvidence({}, sessions).source).toBe("absent");
    expect(projectEvidence({ "session.id": "s" }, [...sessions, { id: "s", label: "different", workspace: "/different" }]).source).toBe("absent");
  });
  it("preserves typed values and ranks content above background events", () => {
    const attrs = [{ key: "success", value: { boolValue: false } }, { key: "input_tokens", value: { intValue: "0" } }];
    expect(attributes(attrs)).toEqual({ success: false, input_tokens: "0" });
    expect(recordPriority({ attributes: attrs })).toBeLessThan(recordPriority({ attributes: [{ key: "plugin.name", value: { stringValue: "background" } }] }));
    expect(recordPriority({ body: { stringValue: "Plugin lifecycle message" }, attributes: [{ key: "event.name", value: { stringValue: "plugin_loaded" } }] })).toBe(4);
    expect(recordPriority({ body: { stringValue: "Important unclassified log" } })).toBe(3);
    expect(recordPriority({ attributes: [{ key: "prompt", value: { stringValue: "[REDACTED]" } }] })).toBe(1);
  });
});
