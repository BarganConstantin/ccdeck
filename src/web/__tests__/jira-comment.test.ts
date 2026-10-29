import { describe, expect, it, vi } from "vitest";
import { commentBody, createJiraComment } from "../../server/integrations/jira-comment.mjs";
const rest = "https://jira.example.com/rest/api/2";
function rig(status = 201, cloud = false) {
  const fetchImpl = vi.fn(async (_url: string, _options: RequestInit) => new Response(null, { status }));
  const invalidate = vi.fn();
  const comment = createJiraComment({ secret: "secret", origins: () => ["https://jira.example.com"], sign: () => ({}), authCheck: () => null, fetchImpl, rest, cloud, invalidate });
  return { comment, fetchImpl, invalidate };
}
describe("Jira comments", () => {
  it("uses the right comment representation for Cloud and Server", () => {
    expect(commentBody("First\n\nLast", false)).toBe("First\n\nLast");
    expect(commentBody("First\n\nLast", true)).toEqual({ type: "doc", version: 1, content: [
      { type: "paragraph", content: [{ type: "text", text: "First" }] }, { type: "paragraph" }, { type: "paragraph", content: [{ type: "text", text: "Last" }] },
    ] });
  });
  it("posts only the requested text and invalidates the cache", async () => {
    const r = rig();
    expect((await r.comment("MOCK-1", { text: "Hello" })).body).toEqual({ ok: true, issueKey: "MOCK-1" });
    const [url, options] = r.fetchImpl.mock.calls[0];
    expect(url).toBe(`${rest}/issue/MOCK-1/comment`);
    expect(JSON.parse(options.body as string)).toEqual({ body: "Hello" });
    expect(options.redirect).toBe("manual");
    expect(r.invalidate).toHaveBeenCalledOnce();
  });
  it.each([{ text: " " }, { text: "a".repeat(10001) }, { text: "hello", visibility: {} }, { text: 1 }])("rejects invalid bodies without writes", async body => {
    const r = rig();
    await expect(r.comment("MOCK-1", body)).rejects.toThrow();
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });
  it("does not replay a redirect and warns of uncertainty", async () => {
    const r = rig(302);
    await expect(r.comment("MOCK-1", { text: "Hello" })).rejects.toThrow(/Refresh/);
    expect(r.fetchImpl).toHaveBeenCalledOnce();
  });
  it("does not claim success on a server error", async () => {
    const r = rig(500);
    await expect(r.comment("MOCK-1", { text: "Hello" })).rejects.toThrow(/could not be confirmed/);
    expect(r.invalidate).toHaveBeenCalledOnce();
  });
});
