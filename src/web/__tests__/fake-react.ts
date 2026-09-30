// A React of the hooks the dialogs call, and a way to press what they draw.
//
// The suite has no DOM, so a dialog whose bug is what happens AFTER a press —
// a typed name that is gone when the answer comes back, a focused button taken
// away under the reader — could only be pinned by reading its source. This
// runs the component function itself instead: hooks keep their state across
// renders the way React's do, a state that changes renders again, effects run
// after a render whose deps moved, layout ones first, and what comes back is
// the element tree the component drew, whose handlers a test can call.
// focus-rescue-1762.test.ts and notify-switch-adopts-standing-1761.test.ts
// carry smaller versions of the same idea for a hook on its own.
//
// What it does not do is lay anything out, attach a node to a ref, or render a
// child component: a test reads the tree the component under test drew
// itself, and says in `commit` what the document would have done with it.
//
// Mocked in as "react" by the test that uses it — the JSX runtime stays the
// real one, since all it does is build the elements:
//
//   vi.mock("react", async () => (await import("./fake-react")).react);

type Deps = readonly unknown[] | undefined;

interface Queued { index: number; layout: boolean; run: () => void | (() => void); deps: Deps }

interface Instance {
  slots: unknown[];
  effects: Array<{ deps: Deps; cleanup: void | (() => void) } | undefined>;
  queued: Queued[];
  cursor: number;
  effectCursor: number;
  /** A state changed since this pass began, so another one is owed. */
  dirty: boolean;
  /** Render again until nothing changes — what a setter outside a render asks. */
  update: () => void;
}

let current: Instance | null = null;

const moved = (prev: Deps, next: Deps) =>
  !prev || !next || prev.length !== next.length || next.some((d, k) => !Object.is(d, prev[k]));

/** This hook's slot on the instance being rendered, made on the first render. */
function slot<T>(init: () => T): T {
  const inst = current;
  if (!inst) throw new Error("a hook was called outside a render");
  const i = inst.cursor++;
  if (!(i in inst.slots)) inst.slots[i] = init();
  return inst.slots[i] as T;
}

function effect(layout: boolean, run: () => void | (() => void), deps?: readonly unknown[]) {
  const inst = current;
  if (!inst) throw new Error("a hook was called outside a render");
  const index = inst.effectCursor++;
  const prev = inst.effects[index];
  if (!prev || moved(prev.deps, deps)) inst.queued.push({ index, layout, run, deps });
}

function memo<T>(make: () => T, deps: Deps): T {
  const s = slot(() => ({ deps: undefined as Deps, value: undefined as T, made: false }));
  if (!s.made || moved(s.deps, deps)) { s.value = make(); s.deps = deps; s.made = true; }
  return s.value;
}

export const react = {
  useRef<T>(init: T) {
    return slot(() => ({ current: init }));
  },
  useState<T>(init: T | (() => T)) {
    const inst = current;
    const s = slot(() => {
      const box = { state: typeof init === "function" ? (init as () => T)() : init, set: (_: T | ((prev: T) => T)) => {} };
      box.set = next => {
        const value = typeof next === "function" ? (next as (prev: T) => T)(box.state) : next;
        if (Object.is(value, box.state)) return;
        box.state = value;
        inst!.dirty = true;
        inst!.update();
      };
      return box;
    });
    return [s.state, s.set] as const;
  },
  useEffect(run: () => void | (() => void), deps?: readonly unknown[]) { effect(false, run, deps); },
  useLayoutEffect(run: () => void | (() => void), deps?: readonly unknown[]) { effect(true, run, deps); },
  useCallback<F>(fn: F, deps: readonly unknown[]) { return memo(() => fn, deps); },
  useMemo<T>(make: () => T, deps: readonly unknown[]) { return memo(make, deps); },
};

/** One element the component drew. */
export interface Drawn {
  type: unknown;
  props: Record<string, unknown> & { children?: unknown };
  ref?: unknown;
}

/**
 * Renders `component` with `props`, again whenever one of its states changes,
 * and on `rerender` with new props. A change made while a pass is running —
 * an effect's, or a handler's — is one more pass once it ends, until nothing
 * moves. `commit` runs between each render and its effects, which is where
 * the document would have attached refs and dropped the focus of anything the
 * render took away.
 */
export function mount<P>(
  component: (props: P) => unknown,
  props: P,
  opts: { commit?: (tree: unknown) => void } = {},
) {
  let tree: unknown = null;
  let shown = props;
  let running = false;
  const inst: Instance = {
    slots: [], effects: [], queued: [], cursor: 0, effectCursor: 0, dirty: false,
    update() {
      if (running) return;
      running = true;
      try {
        let passes = 0;
        do {
          if (++passes > 50) throw new Error("the component never settled");
          inst.dirty = false;
          pass();
        } while (inst.dirty);
      } finally { running = false; }
    },
  };
  const pass = () => {
    inst.cursor = 0;
    inst.effectCursor = 0;
    inst.queued = [];
    current = inst;
    try { tree = component(shown); } finally { current = null; }
    opts.commit?.(tree);
    const order = [...inst.queued.filter(q => q.layout), ...inst.queued.filter(q => !q.layout)];
    for (const q of order) {
      const cleanup = inst.effects[q.index]?.cleanup;
      if (typeof cleanup === "function") cleanup();
      inst.effects[q.index] = { deps: q.deps, cleanup: q.run() };
    }
  };
  inst.update();
  return {
    get tree() { return tree; },
    rerender(next: P = shown) { shown = next; inst.update(); },
  };
}

/** Every element in the tree that `match` accepts, in document order. */
export function all(tree: unknown, match: (el: Drawn) => boolean): Drawn[] {
  const out: Drawn[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) { for (const c of n) walk(c); return; }
    if (!n || typeof n !== "object" || !("props" in n)) return;
    const el = n as Drawn;
    if (match(el)) out.push(el);
    walk(el.props.children);
  };
  walk(tree);
  return out;
}

/** The one element `match` accepts, or null when there is none. More than one
 *  is a test that is not about the element it thinks it is. */
export function one(tree: unknown, match: (el: Drawn) => boolean): Drawn | null {
  const found = all(tree, match);
  if (found.length > 1) throw new Error(`expected one element, found ${found.length}`);
  return found[0] ?? null;
}

/** The text an element or subtree reads as. */
export function textOf(n: unknown): string {
  if (n == null || typeof n === "boolean") return "";
  if (typeof n === "string" || typeof n === "number") return String(n);
  if (Array.isArray(n)) return n.map(textOf).join("");
  if (typeof n === "object" && "props" in n) return textOf((n as Drawn).props.children);
  return "";
}

/** Lets every promise already settled run its callbacks — a fetch stub's
 *  answer, and the `.then` a press hangs on it. */
export async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
