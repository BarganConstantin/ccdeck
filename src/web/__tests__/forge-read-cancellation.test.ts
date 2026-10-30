import { expect, it, vi } from "vitest";
import { mount, flush } from "./fake-react";
import { keepRead, keptRead, forgeReadPath } from "../forge-panel";
import type { ForgePagesState } from "../use-forge-read";
vi.mock("react", async () => (await import("./fake-react")).react);
const { useForgePages, useForgeRead } = await import("../use-forge-read");
let serial = 0;
function setup() {
  const scope = `gitlab:cancel-${++serial}`;
  for (const repo of ["one", "two"]) keepRead(`${scope}\n${forgeReadPath("issues", { repo })}`, { data: { items: [repo], next: "next", total: 2 }, loadedAt: Date.now(), error: null });
  let resolve!: (response: Response) => void;
  const api = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(yes => { resolve = yes; }));
  let state!: ForgePagesState<string>;
  const view = mount(({ repo }: { repo: string }) => { state = useForgePages<string>(api, scope, "issues", { repo }); return null; }, { repo: "one" });
  return { view, api, scope, get state() { return state; }, finish: () => resolve(new Response(JSON.stringify({ ok: true, data: { items: ["old-page"], next: null, total: 2 } }))) };
}
it("aborts a page when its panel unmounts", () => {
  const h = setup(); h.state.loadMore();
  const signal = h.api.mock.calls[0][1]?.signal;
  h.view.unmount();
  expect(signal?.aborted).toBe(true);
});
it("rejects late old pages after switching projects, even if transport ignores abort", async () => {
  const h = setup(); h.state.loadMore();
  const signal = h.api.mock.calls[0][1]?.signal;
  h.view.rerender({ repo: "two" });
  h.finish(); await flush();
  expect(signal?.aborted).toBe(true);
  expect(h.state.data?.items).toEqual(["two"]);
  expect(keptRead(`${h.scope}\n${forgeReadPath("issues", { repo: "one" })}\nmore`).data).toBeNull();
  h.view.unmount();
});
it("still appends and caches a page while the same project stays open", async () => {
  const h = setup(); h.state.loadMore(); h.finish(); await flush();
  expect(h.state.data?.items).toEqual(["one", "old-page"]);
  expect(h.state.loadingMore).toBe(false);
  h.view.unmount();
});

it("does not cache a first-page response after its read was cancelled", async () => {
  const scope = `gitlab:late-${++serial}`;
  let resolve!: (response: Response) => void;
  const api = vi.fn((_path: string, _init?: RequestInit) => new Promise<Response>(yes => { resolve = yes; }));
  const view = mount(() => useForgeRead(api, scope, "issues"), {});
  view.unmount();
  resolve(new Response(JSON.stringify({ ok: true, data: { items: ["late"], next: null } })));
  await flush();
  expect(api.mock.calls[0][1]?.signal?.aborted).toBe(true);
  expect(keptRead(`${scope}\nissues`).data).toBeNull();
});
