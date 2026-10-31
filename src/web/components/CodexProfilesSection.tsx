// Codex's accounts, drawn by the same row, fold, warning and Auto-switch block
// as Claude's: the default account open with its bars and when it was read, the
// others behind one "Other accounts" row, each with a Switch, a press on a row
// opening its bars, a warning that explains itself, and a ⋯ menu for the rest.
// The two columns stay separate (CodexAccountsPanel.tsx) but are one design.
//
// What differs is what a Codex account is. It is a CODEX_HOME folder rather than
// a slot, so nothing here moves or shares a login: a login is a single-use
// rotating token, and a copy of it would burn the original. codex-accounts.ts
// turns a profile and its reading into what the shared components read.
import { useCallback, useEffect, useRef, useState } from "react";
import { allOpen, isOpen, orderChoices, orderKey, SLOT_ORDER, sortAccounts, toggleAll, toggleOne, validOrder, type Openness } from "../other-accounts-order";
import { loadOpenness, loadOrder, saveOpenness, saveOrder } from "../accounts-prefs";
import { sentence } from "../account-issue";
import { isAutoArmed, pastThreshold } from "../account-fold";
import { ALIAS_MAX_LENGTH } from "../alias-save";
import { type AutoStatus } from "../claude-accounts";
import {
  CODEX_VOICE, codexAccount, codexIssue, codexPeers, DEFAULT_READ_MS, nextReading, OTHER_READ_MS, readingFor, shownReading, signedOut,
  type CodexProfile, type ProfileQuota,
} from "../codex-accounts";
import { copyText } from "../copy-text";
import { codexDefaultMoved } from "../use-quota";
import { type Failure } from "../accounts-reload";
import { focusDropped } from "../panel-press";
import { usePanelClock } from "../use-panel-clock";
import { useNextDraft } from "../use-next-draft";
import { useRequestSlot } from "../use-request-slot";
import { useThresholdDraft } from "../use-threshold-draft";
import AccountIssuePopover, { WarnGlyph } from "./AccountIssuePopover";
import AccountRow from "./AccountRow";
import AddCodexAccountDialog from "./AddCodexAccountDialog";
import AnchoredPopover from "./AnchoredPopover";
import AutoSwitchPolicy from "./AutoSwitchPolicy";
import OtherAccounts from "./OtherAccounts";

/** Keeps this column's order and open rows apart from Claude's. */
const SCOPE = ".codex";
/** A login that moved during a read answers again after the server's one-minute
 *  floor at the latest, so a few tries are enough and nothing runs for ever. */
const RETRY_MS = 15_000;
const RETRIES = 6;

async function postJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; reason?: string; id?: string }> {
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => null) as { ok?: boolean; reason?: string; id?: string } | null;
  return { ok: response.ok && result?.ok === true, status: response.status, reason: result?.reason, id: result?.id };
}

export default function CodexProfilesSection({ onClose }: { onClose?: () => void } = {}) {
  const { busy, claim, release, pressProps } = useRequestSlot();
  const nowSec = usePanelClock();
  const [profiles, setProfiles] = useState<CodexProfile[] | null>(null);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const profileRequest = useRef(0);
  const profileRefreshes = useRef(0);
  const profileController = useRef<AbortController | null>(null);
  const quotaRequests = useRef(new Set<string>());
  const readFor = useRef(new Set<string>());
  const activeId = useRef<string | null>(null);
  /** When each account was last read, for the five-minute round of the others. */
  const readAt = useRef<Record<string, number>>({});
  const retries = useRef<Record<string, { count: number; timer?: ReturnType<typeof setTimeout> }>>({});
  const [error, setError] = useState(false);
  const [quotas, setQuotas] = useState<Record<string, ProfileQuota | null>>({});
  const revision = useRef(0);
  const [reloading, setReloading] = useState(false);
  /** The refusal a press left: on its row when `row` is set, else at the foot. */
  const [failure, setFailure] = useState<Failure | null>(null);
  /** The account a switch from this panel just landed on, said on its row. */
  const [switched, setSwitched] = useState<{ id: string; name: string } | null>(null);
  /** What a copied command said, at the foot. */
  const [message, setMessage] = useState("");
  /** Which profile's ⋯ is open, how the keyboard came in, and which form it is. */
  const [menu, setMenu] = useState<null | { id: string; start: "first" | "last"; view: "menu" | "rename" }>(null);
  const [aliasDraft, setAliasDraft] = useState("");
  const [menuError, setMenuError] = useState<string | null>(null);
  /** The Add / Sign in dialog: a new account, or one signed in again. */
  const [dialog, setDialog] = useState<null | { id?: string; label?: string; account?: string | null }>(null);
  /** The account whose Remove has been pressed once and is waiting for the second. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** The "Other accounts" row: shut on open, every time, as Claude's is. */
  const [restOpen, setRestOpen] = useState(false);
  /** Whose warning has its explanation open, and which control it hangs from. */
  const [issueOpen, setIssueOpen] = useState<{ id: string; anchor: string } | null>(null);
  const [openness, setOpenness] = useState<Openness>(() => loadOpenness(SCOPE));
  const [order, setOrder] = useState<string>(() => loadOrder(SCOPE));
  const [auto, setAuto] = useState<AutoStatus | null>(null);

  useEffect(() => { saveOpenness(openness, SCOPE); }, [openness]);
  useEffect(() => { saveOrder(order, SCOPE); }, [order]);

  /** Put focus back when a press took the control it was on: a switch replaces
   *  the row's button with the live dot. Only when it really fell. */
  const rescueFocus = useCallback((num: number | null) => {
    window.requestAnimationFrame(() => {
      if (!focusDropped(document.activeElement?.tagName ?? null)) return;
      const row = num == null ? null : document.getElementById(`ap-codex-more-${num}`);
      (row ?? document.querySelector<HTMLElement>(".codex-accounts-panel .ap-refresh"))?.focus();
    });
  }, []);

  const loadAuto = useCallback(async () => {
    try {
      const response = await fetch("/api/codex-auto");
      const status = await response.json() as AutoStatus | null;
      if (response.ok && status?.ok === true && status.settings) setAuto(status);
    } catch { /* the next round asks again */ }
  }, []);

  /** Every Auto-switch control's press. */
  const post = useCallback(async (body: Record<string, unknown>, tag: string) => {
    if (!claim(tag)) return null;
    setFailure(null);
    try {
      const response = await fetch("/api/codex-auto", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const out = await response.json().catch(() => null) as (AutoStatus & { reason?: string }) | null;
      if (out?.ok) setAuto(out);
      else setFailure({ text: "That setting was not saved. Try again." });
      return out;
    } catch {
      setFailure({ text: "server unreachable" });
      return null;
    } finally { release(); }
  }, [claim, release]);

  const {
    threshold, thresholdPick, thresholdCtl, thresholdSaved, thresholdRef, thresholdSaveRef,
    thresholdCustom, thresholdRefusal, thresholdFieldRef,
    proposeThreshold, typeThreshold, cancelThreshold, leaveThreshold, doThreshold,
  } = useThresholdDraft({ auto, post, load: loadAuto });
  const { nextPick, nextCtl, nextSaved, nextRef, nextSaveRef, proposeNext, doNext } = useNextDraft({ auto, post, load: loadAuto });

  async function refreshProfiles(signal = profileController.current?.signal): Promise<CodexProfile[] | undefined> {
    if (signal?.aborted) return undefined;
    const request = ++profileRequest.current;
    profileRefreshes.current++;
    try {
      const response = await fetch("/api/codex-profiles", { signal });
      if (!response.ok) throw new Error("Unable to load Codex profiles");
      const result = await response.json() as { profiles: CodexProfile[]; revision?: number };
      if (!Array.isArray(result.profiles)) throw new Error("Invalid Codex profiles response");
      if (signal?.aborted || request !== profileRequest.current) return undefined;
      setProfiles(result.profiles);
      revision.current = result.revision ?? 0;
      setError(false);
      return result.profiles;
    } finally { profileRefreshes.current--; }
  }

  /** Read one profile's numbers. `auto` is the first read of a login and shows
   *  that it is reading; `poll` keeps what is on screen until the new one lands.
   *  An answer that the login moved during the read is not a state to show, so it
   *  is asked again until the login has settled. */
  async function checkQuota(id: string, mode: "auto" | "poll" = "poll") {
    if (quotaRequests.current.has(id)) return;
    quotaRequests.current.add(id);
    if (mode === "auto") setQuotas(current => ({ ...current, [id]: null }));
    let value: ProfileQuota;
    try {
      const response = await fetch(`/api/codex-profile-quota?id=${encodeURIComponent(id)}`);
      if (!response.ok) throw new Error("Quota unavailable");
      value = await response.json() as ProfileQuota;
    } catch {
      value = { ok: false, reason: "fetch_error" };
    } finally { quotaRequests.current.delete(id); }
    readAt.current[id] = Date.now();
    setQuotas(current => ({ ...current, [id]: nextReading(current[id], value) }));
    const retry = retries.current[id] ?? { count: 0 };
    clearTimeout(retry.timer);
    if (value.reason !== "profile_changed") { delete retries.current[id]; return; }
    if (retry.count >= RETRIES) return;
    retries.current[id] = { count: retry.count + 1, timer: setTimeout(() => void checkQuota(id), RETRY_MS) };
  }

  useEffect(() => {
    const controller = new AbortController();
    profileController.current = controller;
    const load = () => {
      if (controller.signal.aborted || profileRefreshes.current > 0) return;
      const request = profileRequest.current + 1;
      void loadAuto();
      return refreshProfiles(controller.signal).catch(() => {
        if (!controller.signal.aborted && request === profileRequest.current) setError(true);
      });
    };
    void load();
    const timer = setInterval(() => void load(), 15_000);
    return () => {
      controller.abort(); profileRequest.current++; clearInterval(timer);
      for (const retry of Object.values(retries.current)) clearTimeout(retry.timer);
    };
  }, []);

  // Every profile is read once as it appears, and again when its login changes,
  // so the numbers are there before anyone asks.
  useEffect(() => {
    if (!profiles) return;
    for (const profile of profiles) {
      const key = `${profile.id}:${profile.identityVersion}`;
      if (profile.available === false || readFor.current.has(key)) continue;
      readFor.current.add(key);
      void checkQuota(profile.id, "auto");
    }
    // A switch's note lasts while the account it landed on is the default.
    setSwitched(note => note && profiles.some(p => p.id === note.id && p.active) ? note : null);
    // From here or from Auto-switch, the Usage panel follows the default.
    const active = profiles.find(p => p.active)?.id ?? null;
    if (activeId.current && active && active !== activeId.current) codexDefaultMoved();
    activeId.current = active;
  }, [profiles]);

  // The default account, the one being spent, each minute, and the rest every
  // five, so the row that says where to go next is not an hour old.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const profile of profilesRef.current ?? []) {
        if (profile.available === false) continue;
        if (profile.active || now - (readAt.current[profile.id] ?? 0) >= OTHER_READ_MS) void checkQuota(profile.id);
      }
    }, DEFAULT_READ_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!confirmRemove) return;
    const timer = setTimeout(() => setConfirmRemove(null), 4000);
    return () => clearTimeout(timer);
  }, [confirmRemove]);
  useEffect(() => { if (!menu) { setConfirmRemove(null); setMenuError(null); } }, [menu]);

  const rows = (profiles ?? []).map((profile, index) => {
    const reading = readingFor(profile, quotas[profile.id]);
    return {
      profile, reading,
      account: codexAccount(profile, index + 1, reading, { nowMs: nowSec * 1000, heldOut: auto?.heldOut }),
      issue: codexIssue(profile, reading, profiles ?? []),
    };
  });
  type Row = (typeof rows)[number];
  const head = rows.find(row => row.profile.active) ?? rows[0];
  const others = rows.filter(row => row !== head);
  const otherAccounts = others.map(row => row.account);
  const choices = orderChoices(otherAccounts).map(choice => choice.id === SLOT_ORDER ? { ...choice, label: "Order added" } : choice);
  const shownOrder = validOrder(order, otherAccounts);
  const rest = sortAccounts(otherAccounts, shownOrder,
    a => { const row = others.find(r => r.account === a); return !a.disabled && !row?.issue?.blocksSwitch; }, nowSec)
    .map(a => others.find(row => row.account === a) as Row);
  const rowOf = (id: string | undefined) => rows.find(row => row.profile.id === id);
  const rowBoundary = (id: string) => restOpen && rest.some(row => row.profile.id === id) ? "ap-codex-rest-list" : "ap-codex-scroll";

  const reload = async () => {
    setReloading(true);
    try {
      await Promise.all([
        refreshProfiles(), loadAuto(),
        ...(profiles ?? []).filter(profile => profile.available !== false).map(profile => checkQuota(profile.id)),
      ]);
    } catch { setError(true); }
    finally { setReloading(false); }
  };

  const doSwitch = async (num: number, name: string) => {
    const profile = rows.find(row => row.account.num === num)?.profile;
    if (!profile || !claim(`switch-${num}`)) return;
    setFailure(null);
    setSwitched(null);
    setMessage("");
    try {
      const out = await postJson("/api/codex-profile-select", { id: profile.id, expectedRevision: revision.current, operationId: crypto.randomUUID() });
      if (out.ok) setSwitched({ id: profile.id, name });
      else {
        const conflict = ["selection_conflict", "operation_conflict", "selection_busy"].includes(out.reason ?? "");
        setFailure({ text: conflict ? "Another change moved the default just then. Try again." : "The switch did not go through. Reload and try again.", row: num });
      }
      await refreshProfiles().catch(() => setError(true));
    } catch {
      setFailure({ text: "server unreachable", row: num });
    } finally {
      release();
      rescueFocus(num);
    }
  };

  /** Make an account for the dialog, and read the roster again so it is listed.
   *  It has no name of its own: it is called by its email once it is signed in.
   *  Resolves its id, or null when the deck refused. */
  async function createProfile(): Promise<string | null> {
    try {
      const out = await postJson("/api/codex-profile-add", { expectedRevision: revision.current, operationId: crypto.randomUUID() });
      if (!out.ok || !out.id) return null;
      await refreshProfiles().catch(() => setError(true));
      return out.id;
    } catch { return null; }
  }

  async function removeProfile(id: string): Promise<boolean> {
    const out = await postJson("/api/codex-profile-remove", { id, expectedRevision: revision.current, operationId: crypto.randomUUID() }).catch(() => null);
    readFor.current.clear();
    setQuotas(current => { const { [id]: _gone, ...left } = current; return left; });
    await refreshProfiles().catch(() => setError(true));
    return out?.ok === true;
  }

  /** A sign-in landed on `into`, already here: its row takes the login, and the
   *  account made for the sign-in goes. Every row is read again afterwards. */
  async function replaceLogin(id: string, into: string): Promise<boolean> {
    const out = await postJson("/api/codex-profile-replace-login", { id, into, expectedRevision: revision.current }).catch(() => null);
    if (!out?.ok) return false;
    readFor.current.clear();
    setQuotas(current => { const { [id]: _gone, ...left } = current; return left; });
    await refreshProfiles().catch(() => setError(true));
    return true;
  }

  /** Two presses within four seconds, like Claude's Remove: the first arms it. */
  async function pressRemove(id: string, num: number) {
    if (confirmRemove !== id) { setConfirmRemove(id); return; }
    if (!claim(`rm-${num}`)) return;
    setConfirmRemove(null);
    try {
      if (await removeProfile(id)) {
        setMenu(null);
        setMessage("Account removed. Its sign-in and history are kept aside in the deck's data folder, not deleted.");
        rescueFocus(null);
      } else setMenuError("Could not remove the account. Reload and try again.");
    } finally { release(); }
  }

  async function saveAlias(profile: CodexProfile, num: number) {
    const name = aliasDraft.trim();
    if (name === (profile.managedLabel ?? "")) { setMenu(null); return; }
    if (!claim(`alias-${num}`)) return;
    setMenuError(null);
    try {
      const out = await postJson("/api/codex-profile-rename", { id: profile.id, label: name, expectedRevision: revision.current }).catch(() => null);
      if (out?.ok) { await refreshProfiles().catch(() => setError(true)); setMenu(null); rescueFocus(num); }
      else setMenuError(out?.reason === "invalid_label" ? "A name cannot hold a slash." : "Could not rename the account. Try again.");
    } finally { release(); }
  }

  async function copyCommand(url: string, done: string) {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Unavailable");
      const result = await response.json() as { command: string };
      setMessage(await copyText(result.command) ? done : result.command);
    } catch { setMessage("Could not prepare the command."); }
  }

  const openMenu = (id: string, start: "first" | "last" = "first") => {
    setIssueOpen(null);
    setMenu({ id, start, view: "menu" });
  };
  const openIssue = (id: string, anchor: string) => {
    setMenu(null);
    setIssueOpen(open => open?.anchor === anchor ? null : { id, anchor });
  };
  const closeIssue = (refocus = false) => {
    if (refocus && issueOpen) document.getElementById(issueOpen.anchor)?.focus();
    setIssueOpen(null);
  };
  const signIn = (profile: CodexProfile) => setDialog({ id: profile.id, label: profile.label, account: profile.account });

  /** One account's row, drawn the same above the fold and behind it. */
  const accountRow = ({ profile, reading, account: a, issue }: Row) => {
    const plan = shownReading(reading)?.plan;
    const reads = quotas[profile.id] === null || reading?.reason === "profile_changed";
    return (
      <AccountRow key={profile.id} a={a} nowSec={nowSec} issueOverride={issue}
        voice={{
          ...CODEX_VOICE,
          readPlan: plan ? `${sentence(plan)} plan. ${CODEX_VOICE.readPlan}` : CODEX_VOICE.readPlan,
          waiting: reads ? "Reading usage…" : undefined,
        }}
        opened={isOpen(openness, a)} onToggleLanes={() => setOpenness(o => toggleOne(o, a))}
        busy={busy} pressProps={pressProps} onSwitch={doSwitch}
        menuOpen={menu?.id === profile.id} onOpenMenu={(_, start) => openMenu(profile.id, start)} onCloseMenu={() => setMenu(null)}
        refusal={failure?.row === a.num ? failure : null} onDismissRefusal={() => setFailure(null)}
        onSignIn={() => signIn(profile)}
        switchedHere={switched?.id === profile.id} swapped={null} displaced={undefined}
        issueExpanded={issueOpen?.anchor === `ap-codex-issue-${a.num}`} onOpenIssue={(_, anchor) => openIssue(profile.id, anchor)}
        sortKey={a.active ? null : orderKey(shownOrder)} />
    );
  };

  const policyBlock = auto?.ok ? (
    <AutoSwitchPolicy auto={auto} threshold={threshold} thresholdPick={thresholdPick}
      thresholdCtl={thresholdCtl} thresholdSaved={thresholdSaved}
      thresholdRef={thresholdRef} thresholdSaveRef={thresholdSaveRef}
      thresholdCustom={thresholdCustom} thresholdRefusal={thresholdRefusal} thresholdFieldRef={thresholdFieldRef}
      proposeThreshold={proposeThreshold} typeThreshold={typeThreshold}
      cancelThreshold={cancelThreshold} leaveThreshold={leaveThreshold} doThreshold={doThreshold}
      nextPick={nextPick} nextCtl={nextCtl} nextSaved={nextSaved} nextRef={nextRef} nextSaveRef={nextSaveRef}
      proposeNext={proposeNext} doNext={doNext}
      pressProps={pressProps} post={post} load={loadAuto} />
  ) : null;

  const menuRow = rowOf(menu?.id);
  const issueRow = rowOf(issueOpen?.id);
  return (
    <>
      <div className="ap-header">
        <h2>Codex accounts</h2>
        <div className="ap-header-right">
          <button type="button" className="glyph-btn ap-add" aria-label="Add a Codex account" title="Sign in to another Codex account"
            aria-haspopup="dialog" onClick={() => setDialog({})}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
              <path d="M7 2.2v9.6M2.2 7h9.6" />
            </svg>
          </button>
          <button type="button" className="glyph-btn ap-refresh" aria-label="Reload Codex accounts" title="Read the accounts and their numbers again"
            {...pressProps("reload", reloading)} onClick={() => void reload()}>
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M11.6 6.2A4.8 4.8 0 1 0 11 9.6" />
              <path d="M11.9 2.6v3.7h-3.6" />
            </svg>
          </button>
          {onClose && (
            <button type="button" className="glyph-btn" aria-label="Close Codex accounts" onClick={onClose}>
              <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden>
                <path d="M3.4 3.4l7.2 7.2M10.6 3.4l-7.2 7.2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      <div className="ap-scroll" id="ap-codex-scroll">
        <section className="ap-codex" aria-label="Codex profiles">
          {profiles === null ? (
            error ? (
              <div className="ap-empty" role="alert">
                <span>Could not load the Codex accounts.</span>
                <span className="ap-hint">The panel keeps trying every 15 seconds.</span>
                <button type="button" className="ap-fix" {...pressProps("reload", reloading)}
                  onClick={() => void reload().then(() => rescueFocus(null))}>{reloading ? "trying…" : "try again"}</button>
              </div>
            ) : <div className="ap-empty">Checking…</div>
          ) : (
            <>
              {error && <p role="alert" className="ap-codex-hint">Could not refresh the accounts. Showing the last list.</p>}
              {/* The default account's trouble, once, above the list: every new
                  session starts on it, so it is the column's news. */}
              {head?.issue?.tone === "warn" && (
                <div className="ap-notice">
                  <button type="button" id="ap-codex-notice" className="ap-issue" data-tone="warn"
                    aria-haspopup="dialog" aria-expanded={issueOpen?.anchor === "ap-codex-notice"}
                    aria-controls={issueOpen?.anchor === "ap-codex-notice" ? "ap-issue-pop" : undefined}
                    onClick={() => openIssue(head.profile.id, "ap-codex-notice")}>
                    <WarnGlyph />
                    <span className="ap-issue-text">Current account needs attention</span>
                  </button>
                  {head.issue.fix && (
                    <button type="button" className="ap-notice-fix" onClick={() => signIn(head.profile)}
                      title="Open the sign-in dialog. Signing in replaces this account's login in place.">
                      Sign in
                    </button>
                  )}
                </div>
              )}
              <ul className="ap-list">{head && accountRow(head)}</ul>
              {rest.length > 0 && (
                <OtherAccounts idPrefix="codex-"
                  peers={codexPeers(rest, nowSec)}
                  strained={head ? pastThreshold(head.account, threshold, nowSec) : false}
                  armed={isAutoArmed(auto)}
                  threshold={auto?.ok ? threshold : null}
                  open={restOpen}
                  onToggle={() => setRestOpen(open => !open)}
                  order={shownOrder}
                  choices={choices}
                  onOrder={setOrder}
                  allOpen={allOpen(openness, rest.map(row => row.account))}
                  onToggleAll={() => setOpenness(o => toggleAll(o, rest.map(row => row.account)))}
                />
              )}
              {rest.length > 0 && restOpen && (
                <div className="ap-rest-panel" id="ap-codex-rest-panel">
                  <ul className="ap-list ap-others" id="ap-codex-rest-list">{rest.map(accountRow)}</ul>
                  {policyBlock}
                </div>
              )}
              {failure && failure.row == null && (
                <div className="ap-failure" role="alert">
                  <span className="ap-failure-text">{failure.text}</span>
                  <button type="button" className="ap-failure-x" onClick={() => setFailure(null)}
                    aria-label="Dismiss this message" title="Dismiss">×</button>
                </div>
              )}
              {message && <p className="ap-codex-hint" role="status">{message}</p>}
            </>
          )}
        </section>
      </div>
      <div className="vis-hidden" role="status" aria-atomic="true">
        {switched ? `Now active: ${switched.name}` : ""}
      </div>
      {menu && menuRow && (() => {
        const { profile, account: a } = menuRow;
        const titleId = `ap-codex-pop-title-${a.num}`;
        const refusal = menuError && <p className="ap-pop-error" role="alert">{menuError}</p>;
        const choose = (run: () => void) => () => { setMenu(null); run(); };
        return (
          <AnchoredPopover anchorId={`ap-codex-more-${a.num}`} boundaryId={rowBoundary(profile.id)} id={`ap-codex-menu-${a.num}`}
            className="ap-pop" role={menu.view === "menu" ? "menu" : "dialog"}
            labelledBy={menu.view === "menu" ? `ap-codex-more-${a.num}` : titleId} start={menu.start} onClose={() => setMenu(null)}>
            {menu.view === "menu" && (
              <>
                <button type="button" role="menuitem" className="ap-menu-item"
                  onClick={() => { setAliasDraft(profile.managedLabel ?? ""); setMenuError(null); setMenu({ ...menu, view: "rename" }); }}>Rename</button>
                <button type="button" role="menuitem" className="ap-menu-item"
                  title={signedOut(profile) ? "Sign in to this account" : "Replace this account's login"}
                  onClick={choose(() => signIn(profile))}>{signedOut(profile) || profile.metadataUnavailable ? "Sign in" : "Sign in again"}</button>
                <button type="button" role="menuitem" className="ap-menu-item"
                  title="Copies a command that starts Codex on this account"
                  onClick={choose(() => void copyCommand(`/api/codex-profile-launch?id=${encodeURIComponent(profile.id)}`, "Launch command copied."))}>Copy launch command</button>
                {(!a.active || a.disabled) && (
                  <button type="button" role="menuitem" className="ap-menu-item"
                    {...pressProps(`rot-${a.num}`)}
                    title={a.disabled ? "Return this account to auto-rotation" : "Hold this account out of auto-rotation"}
                    onClick={() => void post({ action: "account", id: profile.id, enabled: a.disabled }, `rot-${a.num}`).then(out => { if (out?.ok) setMenu(null); })}
                  >{a.disabled ? "Put back in rotation" : "Hold out of rotation"}</button>
                )}
                {a.active && (
                  <>
                    <button type="button" role="menuitem" className="ap-menu-item"
                      title="Copies a one-time setup so the plain codex command follows the default"
                      onClick={choose(() => void copyCommand("/api/codex-terminal-command?action=install", "Command copied. Run it in your terminal."))}>Enable terminal selection</button>
                    <button type="button" role="menuitem" className="ap-menu-item"
                      onClick={choose(() => void copyCommand("/api/codex-terminal-command?action=uninstall", "Command copied. Run it in your terminal."))}>Remove terminal selection</button>
                  </>
                )}
                {profile.managed && (
                  <>
                    <div role="separator" className="ap-menu-sep" />
                    <button type="button" role="menuitem"
                      className={`ap-menu-item danger${confirmRemove === profile.id ? " armed" : ""}`}
                      {...pressProps(`rm-${a.num}`)}
                      aria-label={confirmRemove === profile.id ? "Confirm remove" : undefined}
                      title={confirmRemove === profile.id
                        ? "Press again within four seconds to remove it"
                        : "Take this account out of the deck. Its sign-in and history are kept aside, not deleted."}
                      onClick={() => void pressRemove(profile.id, a.num)}
                    >{busy === `rm-${a.num}` ? "Removing…" : confirmRemove === profile.id ? "Confirm" : "Remove"}</button>
                  </>
                )}
                {refusal}
              </>
            )}
            {menu.view === "rename" && (
              <form className="ap-pop-form" onSubmit={event => { event.preventDefault(); void saveAlias(profile, a.num); }}>
                <label className="ap-pop-title" id={titleId} htmlFor={`ap-codex-alias-${a.num}`}>Rename account</label>
                <input id={`ap-codex-alias-${a.num}`} className="ap-manage-input" type="text" value={aliasDraft}
                  onChange={event => setAliasDraft(event.target.value)} maxLength={ALIAS_MAX_LENGTH}
                  placeholder="e.g. work" spellCheck={false} autoComplete="off" autoFocus
                  onFocus={event => event.currentTarget.select()} />
                {refusal}
                <div className="ap-pop-actions">
                  <button type="button" className="btn" onClick={() => setMenu(null)}>Cancel</button>
                  <button type="submit" className="btn primary" {...pressProps(`alias-${a.num}`)}
                    title="A short name to show instead of the email">{busy === `alias-${a.num}` ? "…" : "Save"}</button>
                </div>
              </form>
            )}
          </AnchoredPopover>
        );
      })()}
      {issueOpen && issueRow?.issue && (
        <AccountIssuePopover anchorId={issueOpen.anchor}
          boundaryId={issueOpen.anchor === "ap-codex-notice" ? "ap-codex-scroll" : rowBoundary(issueRow.profile.id)}
          issue={issueRow.issue}
          who={issueRow.account.alias ?? issueRow.account.email ?? `account ${issueRow.account.num}`}
          fetchedAt={issueRow.account.fetchedAt} nowSec={nowSec}
          onClose={closeIssue} onSignIn={() => signIn(issueRow.profile)} />
      )}
      {dialog && (
        <AddCodexAccountDialog
          profile={dialog.id && dialog.label ? { id: dialog.id, label: dialog.label, account: dialog.account } : undefined}
          onCreate={createProfile}
          onCopyCommand={id => void copyCommand(`/api/codex-profile-login?id=${encodeURIComponent(id)}`, "Command copied. Run it in your terminal.")}
          onSignedIn={async id => {
            readFor.current.clear();
            const roster = await refreshProfiles().catch(() => { setError(true); return undefined; });
            const signedIn = roster?.find(profile => profile.id === id);
            if (signedIn?.active) codexDefaultMoved();
            const other = roster?.find(profile => profile.id === signedIn?.sameAccountAs);
            return { account: signedIn?.account ?? null, repeats: other ? { id: other.id, name: other.account ?? other.label } : null };
          }}
          onReplace={replaceLogin}
          onDiscard={removeProfile}
          onClose={() => { setDialog(null); void refreshProfiles().catch(() => setError(true)); }}
        />
      )}
    </>
  );
}
