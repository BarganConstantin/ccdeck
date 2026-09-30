// #1813: dismissing a Browser Watch finding dropped keyboard focus to the page.
//
// The × posts the dismissal and reads the snapshot again, and the server leaves
// dismissed episodes out of it, so the card goes — with the focused × inside
// it. Nothing handed focus on: it fell to <body> behind the modal, and the next
// Tab went back to the ↻ at the top of the dialog instead of the next finding.
// The rule is panel-press.ts's (#518): a control the update takes away hands
// focus to the nearest thing that outlived it, and only when focus fell with it.
//
// Run, not read. BrowserWatchFindings is called under a React of four hooks,
// and what it returns — the real JSX runtime's elements — is committed to a
// stand-in document: each element a node that can take focus, each ref handed
// its node the way React hands it, and focus dropped to <body> when the node
// holding it is not drawn again.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WatchEpisode, WatchSnapshot } from "../browser-watch-model";

interface Node {
  tagName: string;
  className: string;
  text: string;
  props: Record<string, any>;
  focus(): void;
}

const dom = vi.hoisted(() => {
  type Deps = readonly unknown[] | undefined;
  const BODY = { tagName: "BODY" };
  const page: { activeElement: { tagName: string } } = { activeElement: BODY };
  const moved = (a: Deps, b: Deps) => !a || !b || a.length !== b.length || a.some((d, k) => !Object.is(d, b[k]));

  let slots: unknown[] = [];
  let effects: Array<{ deps: Deps; cleanup: void | (() => void) }> = [];
  let queued: Array<{ index: number; run: () => void | (() => void); deps: Deps }> = [];
  let cursor = 0;
  let effectCursor = 0;
  let rerender: () => void = () => {};

  const react = {
    useState<T>(init: T | (() => T)) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof init === "function" ? (init as () => T)() : init;
      const set = (next: T | ((p: T) => T)) => {
        slots[i] = typeof next === "function" ? (next as (p: T) => T)(slots[i] as T) : next;
        rerender();
      };
      return [slots[i] as T, set] as const;
    },
    useMemo<T>(make: () => T, deps?: readonly unknown[]) {
      const i = cursor++;
      const prev = slots[i] as { value: T; deps: Deps } | undefined;
      if (prev && !moved(prev.deps, deps)) return prev.value;
      const value = make();
      slots[i] = { value, deps };
      return value;
    },
    useRef<T>(init: T) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = { current: init };
      return slots[i] as { current: T };
    },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const index = effectCursor++;
      const prev = effects[index];
      if (!prev || moved(prev.deps, deps)) queued.push({ index, run, deps });
    },
  };

  type El = { type: unknown; key: string | null; ref: unknown; props: Record<string, any> };
  const isEl = (x: unknown): x is El => !!x && typeof x === "object" && "props" in (x as object);
  const textOf = (x: unknown): string =>
    Array.isArray(x) ? x.map(textOf).join("")
      : typeof x === "string" || typeof x === "number" ? String(x)
      : isEl(x) ? textOf(x.props.children) : "";
  const setRef = (ref: unknown, node: unknown) => {
    if (typeof ref === "function") ref(node);
    else if (ref && typeof ref === "object") (ref as { current: unknown }).current = node;
  };

  let nodes = new Map<string, any>();
  let attached: unknown[] = [];

  /** Draw `tree`: keep the node of every element drawn again, make one for
   *  every new element, and drop the rest. */
  function commit(tree: unknown) {
    // A callback ref written inline is a new function on every render, so
    // React calls the old one with null and the new one with the node.
    for (const ref of attached) setRef(ref, null);
    attached = [];
    const drawn = new Map<string, any>();
    const visit = (x: unknown, path: string) => {
      if (Array.isArray(x)) {
        x.forEach((kid, i) => visit(kid, `${path}/${isEl(kid) && kid.key != null ? `#${kid.key}` : i}`));
        return;
      }
      if (!isEl(x)) return;
      const here = `${path}:${typeof x.type === "string" ? x.type : "fragment"}`;
      if (typeof x.type === "string") {
        const node = nodes.get(here) ?? {
          tagName: x.type.toUpperCase(),
          focus() { page.activeElement = node; },
        };
        node.className = x.props.className ?? "";
        node.props = x.props;
        node.text = textOf(x.props.children);
        drawn.set(here, node);
        if (x.ref) { setRef(x.ref, node); attached.push(x.ref); }
      }
      visit(x.props.children, here);
    };
    visit(tree, "");
    for (const [path, node] of nodes) {
      if (!drawn.has(path) && page.activeElement === node) page.activeElement = BODY;
    }
    nodes = drawn;
  }

  function mount<P>(component: (props: P) => unknown, first: P) {
    let props = first;
    slots = []; effects = []; nodes = new Map(); attached = [];
    const render = () => {
      cursor = 0; effectCursor = 0; queued = [];
      commit(component(props));
      const due = queued;
      for (const q of due) {
        const cleanup = effects[q.index]?.cleanup;
        if (typeof cleanup === "function") cleanup();
      }
      for (const q of due) effects[q.index] = { deps: q.deps, cleanup: q.run() };
    };
    rerender = render;
    render();
    return {
      update(next: P) { props = next; render(); },
      nodes: () => [...nodes.values()] as unknown[],
    };
  }

  return { react, mount, page, BODY };
});

vi.mock("react", () => dom.react);

const { default: BrowserWatchFindings } = await import("../components/BrowserWatchFindings");

const T0 = Date.UTC(2026, 8, 30, 9, 0);
const episode = (host: string, at: number): WatchEpisode =>
  ({ host, startMs: at, endMs: at + 120_000, count: 2, urls: [] }) as unknown as WatchEpisode;
const A = episode("a.example", T0);
const B = episode("b.example", T0 + 600_000);
const C = episode("c.example", T0 + 1_200_000);
const snapOf = (episodes: WatchEpisode[]) =>
  ({ episodes, settings: { enabled: true, quietMinutes: 15 } }) as unknown as WatchSnapshot;

beforeEach(() => {
  dom.page.activeElement = dom.BODY;
  vi.stubGlobal("document", dom.page);
});
afterEach(() => { vi.unstubAllGlobals(); });

/** The dialog's list, the ↻ in the dialog's header, and what a reader here
 *  can press or land on. */
function findings(episodes: WatchEpisode[], dismiss: (e: WatchEpisode) => Promise<void>) {
  const refresh = { tagName: "BUTTON", focus() { dom.page.activeElement = refresh; } };
  const refreshRef = { current: refresh as unknown as HTMLElement };
  const view = dom.mount(BrowserWatchFindings, { snap: snapOf(episodes), dismiss, refreshRef });
  const all = () => view.nodes() as Node[];
  const one = (what: string, hit: (n: Node) => boolean) => {
    const found = all().filter(hit);
    expect(found, `${what}: expected exactly one`).toHaveLength(1);
    return found[0];
  };
  return {
    refresh,
    show: (next: WatchEpisode[]) => view.update({ snap: snapOf(next), dismiss, refreshRef }),
    x: (host: string) => one(`the × for ${host}`, n => n.props["aria-label"] === `Dismiss ${host}`),
    head: (host: string) => one(`the row for ${host}`, n => n.className === "bw-ep-head" && n.text.includes(host)),
  };
}

/** Focus the × and press it, as Enter on it does. */
const press = (x: Node) => {
  x.focus();
  x.props.onClick({ currentTarget: x, stopPropagation() {}, preventDefault() {} });
};
const settle = () => new Promise<void>(r => setTimeout(r, 0));

describe("where focus goes once a dismissed finding has left", () => {
  it("to the next finding's row", async () => {
    let list = [A, B, C];
    const view = findings(list, async e => { list = list.filter(x => x !== e); view.show(list); });
    press(view.x("a.example"));
    await settle();
    expect(dom.page.activeElement, "focus fell to <body> with the dismissed row").toBe(view.head("b.example"));
  });

  it("also when the list is read again after the dismissal has answered", async () => {
    // The order React keeps: the reload resolves, and the render that drops
    // the row comes after it.
    const view = findings([A, B, C], async () => {});
    press(view.x("b.example"));
    await settle();
    view.show([A, C]);
    expect(dom.page.activeElement).toBe(view.head("c.example"));
  });

  it("to the previous row when the last one went", async () => {
    let list = [A, B];
    const view = findings(list, async e => { list = list.filter(x => x !== e); view.show(list); });
    press(view.x("b.example"));
    await settle();
    expect(dom.page.activeElement).toBe(view.head("a.example"));
  });

  it("to the dialog's ↻ when nothing is left", async () => {
    // A real control, as a removed row's is in the accounts panel: the deck
    // invents no focus stop to land on (canvas-keyboard.test.ts).
    let list = [A];
    const view = findings(list, async e => { list = list.filter(x => x !== e); view.show(list); });
    press(view.x("a.example"));
    await settle();
    expect(dom.page.activeElement).toBe(view.refresh);
  });

  it("nowhere, when the reader had already moved on", async () => {
    const view = findings([A, B, C], async () => {});
    press(view.x("a.example"));
    await settle();
    view.x("c.example").focus();
    view.show([B, C]);
    expect(dom.page.activeElement).toBe(view.x("c.example"));
  });

  it("nowhere, when the dismissal did not take and the row is still there", async () => {
    // A refused write leaves the row on the next read, and the × with it.
    const view = findings([A, B], async () => { view.show([A, B]); });
    const x = view.x("a.example");
    press(x);
    await settle();
    expect(dom.page.activeElement).toBe(x);
  });
});
