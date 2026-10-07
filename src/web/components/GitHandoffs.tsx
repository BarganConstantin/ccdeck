// The git view's hand-off row: open the session's folder in a git client, an
// editor or a terminal on the deck's machine, and copy its branch, commit SHA
// and folder path. Used by the glance in the detail panel, where the launch
// buttons carry their app's name, and by the wide view's header (`compact`),
// where every button is an icon with its words in its title and label.
//
// A launch button is drawn only for a slot the deck found an app for
// (git-handoffs.ts), and only while this page is on the deck's own machine —
// from another machine's browser it would open an app on a screen nobody there
// is looking at, so the row keeps its copy buttons and, in the glance, says
// why. The server refuses such a launch whatever the page draws.
//
// Several copy values share one Copy menu wherever the launch buttons need the
// room; three identical copy glyphs side by side would only be told apart by
// hovering each.
//
// The Fork look's toolbar (`tools`) draws the same actions as two of its tool
// columns, Open in ▾ and Copy ▾, each a menu: the launches in one, the copies
// in the other.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { copyText } from "../copy-text";
import { isEscapeKey } from "../modal-dismiss";
import { openHandoff, useHandoffs, type HandoffSlot } from "../git-handoffs";

interface Props {
  sessionId: string;
  branch: string | null;
  sha: string | null;
  /** The session's folder, as copied. */
  path: string | null;
  /** The wide view's header: icons only, at every width. */
  compact: boolean;
  /** A subagent whose folder is its own, by the key the server knows it by. */
  agentId?: string | null;
  /** The Fork look's toolbar: Open in ▾ and Copy ▾ as its tool columns. */
  tools?: boolean;
}

type CopyKind = "branch" | "sha" | "path";
interface CopyItem { kind: CopyKind; value: string; key: string; word: string; label: string; shown: string }

const COPIED_MS = 1_600;

const svg = (d: string) => (
  <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
    strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    <path d={d} />
  </svg>
);
const ICON = {
  git: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <circle cx="3.6" cy="3.4" r="1.3" /><circle cx="3.6" cy="10.6" r="1.3" /><circle cx="10.4" cy="7" r="1.3" />
      <path d="M3.6 4.7v4.6M4.8 4.2 9.2 6.4" />
    </svg>
  ),
  editor: svg("M4.6 4 2 7l2.6 3M9.4 4 12 7l-2.6 3"),
  terminal: svg("M3 4.6 5.4 7 3 9.4M7.2 10h3.8"),
  copy: (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="4.8" y="4.8" width="6.8" height="6.8" rx="1.3" />
      <path d="M9.2 4.8V3.5a1 1 0 0 0-1-1H3.5a1 1 0 0 0-1 1v4.7a1 1 0 0 0 1 1h1.3" />
    </svg>
  ),
  check: svg("M3 7.4 5.8 10 11 4.2"),
  chevron: (
    <svg className="gv-ho-chev" width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M2.5 3.8 5 6.3l2.5-2.5" />
    </svg>
  ),
  failed: svg("M7 3.4v4.2M7 10.2v.1"),
};
/** The Fork toolbar's 18px glyphs, and its 7px menu chevron. */
const TOOL = {
  open: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M8 3.6H5a1.6 1.6 0 0 0-1.6 1.6v7.8A1.6 1.6 0 0 0 5 14.6h7.8a1.6 1.6 0 0 0 1.6-1.6v-3" /><path d="M10.6 3.4h4v4M14.4 3.6 8.6 9.4" />
    </svg>
  ),
  copy: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <rect x="6.4" y="6.4" width="8.4" height="8.4" rx="1.6" /><path d="M11.6 6.4V4.8a1.4 1.4 0 0 0-1.4-1.4H4.8a1.4 1.4 0 0 0-1.4 1.4v5.4a1.4 1.4 0 0 0 1.4 1.4h1.6" />
    </svg>
  ),
  check: (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false"><path d="M4 9.6 7.4 13 14 5.6" /></svg>
  ),
  chevron: (
    <svg className="fk-tool-chev" width="7" height="7" viewBox="0 0 7 7" fill="none" stroke="currentColor" strokeWidth="1.3"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false"><path d="M1 2.4 3.5 4.9 6 2.4" /></svg>
  ),
};

/** A button's word and the word it reads for a moment after a copy, stacked in
 *  one cell so the button is as wide as the longer and never changes width —
 *  the buttons beside it stay where the pointer left them. */
function Words({ now, then, done }: { now: string; then: string; done: boolean }) {
  return (
    <span className="gv-ho-words">
      <span data-on={done ? undefined : ""}>{now}</span>
      <span data-on={done ? "" : undefined} aria-hidden>{then}</span>
    </span>
  );
}

/** The last part of a folder path, for a title that names the folder. */
function folderName(path: string | null): string {
  if (!path) return "this folder";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** The words of one launch button: what it shows, and what it says it does. */
function launchWords(slot: HandoffSlot, app: string, name: string): { word: string; title: string } {
  if (slot === "terminal") return { word: "Terminal", title: `Open a terminal in ${name}${app === "Terminal" ? "" : ` (${app})`}` };
  if (slot === "git" && app === "lazygit") return { word: "lazygit", title: `Open lazygit on ${name} in a terminal` };
  return { word: app, title: `Open ${name} in ${app}` };
}

export default function GitHandoffs({ sessionId, branch, sha, path, compact, agentId = null, tools = false }: Props) {
  const handoffs = useHandoffs();
  const uid = useId();
  // Which menu is open: Copy, or (the Fork toolbar's) Open in.
  const [which, setWhich] = useState<"copy" | "open">("copy");
  const menuId = `${uid}-${which}-menu`;
  const copyId = `${uid}-copy`;
  const openId = `${uid}-open`;
  const buttonId = which === "open" ? openId : copyId;
  const [menu, setMenu] = useState<"first" | "last" | null>(null);
  // Whether the pointer opened the menu: only then does it animate in.
  const [menuByPointer, setMenuByPointer] = useState(false);
  const [copied, setCopied] = useState<CopyKind | "menu" | null>(null);
  const [failed, setFailed] = useState<{ slot: HandoffSlot; error: string } | null>(null);
  const [busy, setBusy] = useState<HandoffSlot | null>(null);
  const [said, setSaid] = useState("");
  const alive = useRef(true);
  const timer = useRef(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => () => { alive.current = false; window.clearTimeout(timer.current); }, []);
  // Another session's row starts clean: a refusal is about the folder it was for.
  useEffect(() => { setFailed(null); setMenu(null); }, [sessionId, agentId]);

  const name = folderName(path);
  const items: CopyItem[] = [];
  if (branch) items.push({ kind: "branch", value: branch, key: "Branch", word: "Copy branch", label: "the branch name", shown: branch });
  if (sha) items.push({ kind: "sha", value: sha, key: "Commit", word: "Copy SHA", label: "the commit SHA", shown: sha.slice(0, 7) });
  if (path) items.push({ kind: "path", value: path, key: "Folder", word: "Copy path", label: "the folder path", shown: path });

  const loading = handoffs.state === "idle" || handoffs.state === "loading";
  const local = handoffs.state === "ready" && handoffs.local;
  const launches = local
    ? (["git", "editor", "terminal"] as HandoffSlot[]).flatMap(slot => {
      const s = handoffs.slots[slot];
      const app = s.apps.find(a => a.id === s.chosen) ?? s.apps[0];
      return app ? [{ slot, app }] : [];
    })
    : [];
  const elsewhere = handoffs.state === "ready" && !handoffs.local;
  // Words for the copy buttons only where nothing else needs the row: the
  // glance seen from another machine, which is the mockup's own layout.
  const wordyCopies = !compact && elsewhere;
  const folded = items.length > 1 && !wordyCopies;

  const flash = (kind: CopyKind | "menu", sentence: string) => {
    window.clearTimeout(timer.current);
    setCopied(kind);
    setSaid(sentence);
    timer.current = window.setTimeout(() => { if (alive.current) setCopied(null); }, COPIED_MS);
  };
  const copy = (item: CopyItem, from: CopyKind | "menu") => {
    void copyText(item.value).then(ok => {
      if (!alive.current) return;
      if (ok) flash(from, `Copied ${item.label}`);
      else setSaid(`Could not copy ${item.label}; it is ${item.value}`);
    });
  };

  const launch = (slot: HandoffSlot) => {
    if (busy) return;
    setBusy(slot);
    setFailed(null);
    void openHandoff({ sessionId, agentId, slot }).then(r => {
      if (!alive.current) return;
      setBusy(null);
      if (r.ok) { setSaid(`Opening ${r.app?.name ?? "it"}`); return; }
      setFailed({ slot, error: r.error ?? "The deck could not open it." });
      setSaid(`Could not open it: ${r.error ?? ""}`);
    });
  };

  // ── the Copy menu: a menu button, its items walked by the arrows ──────────
  const itemsInMenu = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
  const openMenu = (start: "first" | "last", byPointer = false, of: "copy" | "open" = "copy") => {
    setMenuByPointer(byPointer);
    setWhich(of);
    setMenu(start);
  };
  // Placed before it is painted, inside the panel that holds the row — the
  // git view's (its key scope) or the detail panel, both of which clip — or
  // the window, and never wider than that box less an 8px margin each side.
  useLayoutEffect(() => {
    const el = menuRef.current;
    const anchor = document.getElementById(buttonId);
    if (!menu || !el || !anchor) return;
    const holder = anchor.closest('[data-key-scope="git"], .detail')?.getBoundingClientRect();
    const clip = holder
      ? { left: Math.max(0, holder.left), right: Math.min(window.innerWidth, holder.right) }
      : { left: 0, right: window.innerWidth };
    const room = Math.max(0, clip.right - clip.left - 16);
    el.style.left = "0px";
    el.style.maxWidth = `${Math.min(288, room)}px`;
    el.style.minWidth = `${Math.min(208, room)}px`;
    const box = anchor.getBoundingClientRect();
    const width = el.offsetWidth;
    // Its left edge on the button's when it fits, else its right edge on the
    // button's, then kept inside the box either way.
    const want = box.left + width <= clip.right - 8 ? 0 : box.width - width;
    const left = Math.max(clip.left + 8 - box.left, Math.min(want, clip.right - 8 - width - box.left));
    el.style.left = `${Math.round(left)}px`;
  }, [menu, buttonId]);
  const closeMenu = (refocus: boolean) => {
    setMenu(null);
    if (refocus) document.getElementById(buttonId)?.focus();
  };
  useEffect(() => {
    if (!menu) return;
    const list = itemsInMenu();
    (menu === "last" ? list[list.length - 1] : list[0])?.focus();
    // A press anywhere else closes it, without taking focus anywhere.
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => document.removeEventListener("pointerdown", onDown, true);
    // Mount of a menu only (or the other menu replacing it): a re-render
    // must not pull focus back to an end.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu !== null && which]);

  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = itemsInMenu();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === "ArrowDown") next = (at + 1) % list.length;
    else if (e.key === "ArrowUp") next = (at - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    if (next >= 0) { e.preventDefault(); e.stopPropagation(); list[next]?.focus(); return; }
    // Escape closes the menu and nothing else: the panel behind it stays open.
    if (isEscapeKey(e.key)) { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
    // Tab leaves the way focus came in, as the deck's other menus do: back to
    // the button, and on to the control after it for a plain Tab, rather than
    // through items the arrows already walk.
    if (e.key === "Tab") {
      e.stopPropagation();
      document.getElementById(buttonId)?.focus();
      if (e.shiftKey) e.preventDefault();
      setMenu(null);
      return;
    }
    // No letter typed here reaches a canvas shortcut.
    if (e.key.length === 1) e.stopPropagation();
  };
  const onMenuButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    openMenu(e.key === "ArrowUp" ? "last" : "first", false, e.currentTarget.id === openId ? "open" : "copy");
  };
  // A menu button's press: opens its menu, or closes the one open.
  const pressMenu = (of: "copy" | "open", detail: number) =>
    (menu && which === of ? closeMenu(false) : openMenu("first", detail > 0, of));
  const copyItems = (
    items.map(item => (
      <button key={item.kind} type="button" role="menuitem" className="ap-menu-item gv-ho-item"
        title={item.value}
        onClick={() => { closeMenu(true); copy(item, "menu"); }}>
        <span className="gv-ho-key">{item.key}</span>
        <span className="gv-ho-val">{item.shown}</span>
      </button>
    ))
  );

  if (tools) {
    // The Fork toolbar's two tools. Open in is drawn only where the deck
    // found an app and the page is on its machine, as the launch buttons are.
    const openTitle = failed ? `Could not open: ${failed.error}` : `Open ${name} in an app`;
    const copyTitle = copied === "menu" ? said : "Copy the branch, commit SHA or folder path";
    return (
      <div className="gv-handoffs-wrap" ref={wrapRef} data-tools="">
        <div className="gv-handoffs" role="group" aria-label="Open or copy" aria-busy={loading || undefined} data-tools="">
          {!loading && launches.length > 0 && (
            <span className="gv-ho-copy">
              <button id={openId} type="button" className="fk-tool" data-failed={failed ? "" : undefined}
                aria-haspopup="menu" aria-expanded={menu !== null && which === "open"} aria-controls={menu && which === "open" ? menuId : undefined}
                title={openTitle} aria-label={openTitle}
                onClick={e => pressMenu("open", e.detail)} onKeyDown={onMenuButtonKey}>
                <span className="fk-tool-icon">{TOOL.open}{TOOL.chevron}</span>
                <span className="fk-tool-label">Open in</span>
              </button>
              {menu && which === "open" && (
                <div ref={menuRef} id={menuId} className="gv-ho-menu" role="menu" aria-labelledby={openId}
                  data-motion={menuByPointer ? "pointer" : undefined} onKeyDown={onMenuKey}>
                  {launches.map(({ slot, app }) => {
                    const { word, title } = launchWords(slot, app.name, name);
                    return (
                      <button key={slot} type="button" role="menuitem" className="ap-menu-item gv-ho-item gv-ho-launch" data-slot={slot}
                        title={title} aria-busy={busy === slot || undefined}
                        onClick={() => { closeMenu(true); launch(slot); }}>
                        {ICON[slot]}<span className="gv-ho-val">{word}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </span>
          )}
          {!loading && items.length > 0 && (
            <span className="gv-ho-copy">
              <button id={copyId} type="button" className="fk-tool" data-done={copied === "menu" ? "" : undefined}
                aria-haspopup="menu" aria-expanded={menu !== null && which === "copy"} aria-controls={menu && which === "copy" ? menuId : undefined}
                title={copyTitle} aria-label={copyTitle}
                onClick={e => pressMenu("copy", e.detail)} onKeyDown={onMenuButtonKey}>
                <span className="fk-tool-icon">{copied === "menu" ? TOOL.check : TOOL.copy}{TOOL.chevron}</span>
                <span className="fk-tool-label"><Words now="Copy" then="Copied" done={copied === "menu"} /></span>
              </button>
              {menu && which === "copy" && (
                <div ref={menuRef} id={menuId} className="gv-ho-menu" role="menu" aria-labelledby={copyId}
                  data-motion={menuByPointer ? "pointer" : undefined} onKeyDown={onMenuKey}>
                  {copyItems}
                </div>
              )}
            </span>
          )}
        </div>
        <span className="vis-hidden" role="status" aria-live="polite">{said}</span>
      </div>
    );
  }

  const copyButton = (item: CopyItem) => {
    const done = copied === item.kind;
    const label = done ? `${item.label[0].toUpperCase()}${item.label.slice(1)} was copied` : `Copy ${item.label}`;
    return (
      <button key={item.kind} type="button" className="btn gv-hand" data-copy={item.kind}
        data-icon={wordyCopies ? undefined : ""} data-done={done ? "" : undefined}
        title={`Copy ${item.value}`} aria-label={label} onClick={() => copy(item, item.kind)}>
        {done ? ICON.check : ICON.copy}
        {wordyCopies && <Words now={item.word} then="Copied" done={done} />}
      </button>
    );
  };

  return (
    <div className="gv-handoffs-wrap" ref={wrapRef} data-compact={compact ? "" : undefined}>
      <div className="gv-handoffs" role="group" aria-label="Open or copy" aria-busy={loading || undefined}
        data-compact={compact ? "" : undefined} data-loading={loading ? "" : undefined}>
        {!loading && launches.map(({ slot, app }) => {
          const { word, title } = launchWords(slot, app.name, name);
          const bad = failed?.slot === slot;
          return (
            <button key={slot} type="button" className="btn gv-hand" data-slot={slot}
              data-icon={compact ? "" : undefined} data-failed={bad ? "" : undefined}
              title={bad ? `Could not open: ${failed.error}` : title}
              aria-label={bad ? `${title}. Could not open: ${failed.error}` : title}
              aria-busy={busy === slot || undefined}
              onClick={() => launch(slot)}>
              {bad && compact ? ICON.failed : ICON[slot]}
              {!compact && <span>{word}</span>}
            </button>
          );
        })}
        {!loading && launches.length > 0 && items.length > 0 && compact && <span className="gv-ho-rule" aria-hidden />}
        {!loading && !folded && items.map(copyButton)}
        {!loading && folded && (
          <span className="gv-ho-copy">
            <button id={copyId} type="button" className="btn gv-hand" data-copy="menu"
              data-icon={compact ? "" : undefined} data-done={copied === "menu" ? "" : undefined}
              aria-haspopup="menu" aria-expanded={menu !== null} aria-controls={menu ? menuId : undefined}
              title={copied === "menu" ? said : "Copy the branch, commit SHA or folder path"}
              aria-label={copied === "menu" ? said : "Copy the branch, commit SHA or folder path"}
              onClick={e => pressMenu("copy", e.detail)} onKeyDown={onMenuButtonKey}>
              {copied === "menu" ? ICON.check : ICON.copy}
              {/* A plain swap here: nothing follows this button in its row. */}
              {!compact && <span>{copied === "menu" ? "Copied" : "Copy"}</span>}
              {ICON.chevron}
            </button>
            {menu && (
              <div ref={menuRef} id={menuId} className="gv-ho-menu" role="menu" aria-labelledby={copyId}
                data-motion={menuByPointer ? "pointer" : undefined} onKeyDown={onMenuKey}>
                {copyItems}
              </div>
            )}
          </span>
        )}
      </div>
      {!compact && elsewhere && (
        <p className="gv-ho-note">
          Open buttons are hidden here: this deck runs on <b title={handoffs.machine || undefined}>{handoffs.machine || "another machine"}</b>, and they would open apps on that machine.
        </p>
      )}
      {!compact && failed && <p className="gv-ho-note gv-ho-failed">Could not open it: {failed.error}</p>}
      <span className="vis-hidden" role="status" aria-live="polite">{said}</span>
    </div>
  );
}
