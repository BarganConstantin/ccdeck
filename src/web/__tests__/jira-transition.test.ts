import { describe, expect, it, vi } from "vitest";
import { createJiraTransition, jiraTransitions } from "../../server/integrations/jira-transition.mjs";

const rest = "https://jira.example.com/rest/api/2";
const data = { transitions: [
  { id: "11", name: "Start", to: { name: "In Progress" }, fields: {} },
  { id: "12", name: "Resolve", hasScreen: true, fields: { resolution: { required: true } } },
] };
const reader = () => ({ json: async () => data });
function rig(status = 204) {
  const fetchImpl = vi.fn(async () => new Response(null, { status }));
  const invalidate = vi.fn();
  const transition = createJiraTransition({ secret: "secret", origins: () => ["https://jira.example.com"], sign: () => ({}), authCheck: () => null, fetchImpl, reader, rest, invalidate });
  return { transition, fetchImpl, invalidate };
}
describe("Jira workflow transitions", () => {
  it("returns Jira's choices and marks screens as requiring Jira", async () => {
    expect(await jiraTransitions(reader(), rest, "MOCK-1")).toEqual([
      { id: "11", name: "Start", to: "In Progress", requiresScreen: false },
      { id: "12", name: "Resolve", to: "", requiresScreen: true },
    ]);
  });
  it("posts only a currently available screenless transition", async () => {
    const r = rig();
    expect((await r.transition("MOCK-1", { transitionId: "11" })).body).toEqual({ ok: true, issueKey: "MOCK-1" });
    expect(r.fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = r.fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${rest}/issue/MOCK-1/transitions`);
    expect(JSON.parse(options.body as string)).toEqual({ transition: { id: "11" } });
    expect(options.redirect).toBe("manual");
    expect(r.invalidate).toHaveBeenCalledOnce();
  });
  it.each([{ transitionId: "12" }, { transitionId: "13" }, { transitionId: "11", fields: {} }, { transitionId: "../11" }])("rejects unsupported input without a write", async body => {
    const r = rig();
    await expect(r.transition("MOCK-1", body)).rejects.toThrow();
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not follow redirects or claim they succeeded", async () => {
    const r = rig(302);
    await expect(r.transition("MOCK-1", { transitionId: "11" })).rejects.toThrow(/redirected/);
    expect(r.fetchImpl).toHaveBeenCalledOnce();
    expect(r.invalidate).toHaveBeenCalledOnce();
  });
});

it("routes a transition write only to the named issue operation", async () => {
  const { jiraRoutes } = await import("../../server/integrations/jira.mjs");
  const transitionIssue = vi.fn(async (key: string, body: unknown) => ({ status: 200, body: { ok: true, issueKey: key, body } }));
  const client = { transitionIssue };
  const result = await jiraRoutes(client, "POST", "issue/MOCK-1/transitions", new URLSearchParams(), null, { moveBody: { transitionId: "11" } });
  expect(result.status).toBe(200);
  expect(transitionIssue).toHaveBeenCalledWith("MOCK-1", { transitionId: "11" }, undefined);
  const refused = await jiraRoutes(client, "POST", "issue/MOCK-1/transitions", new URLSearchParams("other=1"), null, { moveBody: { transitionId: "11" } });
  expect(refused.status).toBe(400);
  expect(transitionIssue).toHaveBeenCalledOnce();
});
