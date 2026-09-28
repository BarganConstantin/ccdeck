// OS notifications for a session that is waiting on you: whether the browser
// allows them, the deck's own switch, asking for permission, and — the subtle
// part — what has already been raised, so that adopting a world full of old
// blocks does not fire a burst of them at once.
//
// Lifted out of App.tsx's `Inner`, where it was the last 270 lines before the
// markup. It takes the waiting set the sidebar already computes, the moment the
// deck finished adopting the world, and how to bring a session into view when a
// notification is clicked; it owns everything else, and every setter is private.
//
// One thing stayed behind on purpose. The deck's server-side prefs are read once,
// and that one answer carries both this switch and the auto-update switch. The
// read stays in App.tsx beside auto-update, and hands this hook its half through
// `loadNotifyPrefs`. Moving the read here would have meant either reaching back
// into the auto-update state or making two requests for one answer.
import { useCallback, useEffect, useRef, useState } from "react";

import { type NotifyPermission, blockKey, canAsk, mayRaise, nextRaised, noticesFor, seedRaised, shouldReseed, shouldSeedFromWorld } from "./notify";
import type { BlockedSession } from "./ambient-counts";

export interface OsNotificationsDeps {
  /** The sessions currently blocked on a human — the same set the sidebar draws. */
  waitingSessions: BlockedSession[];
  /** When the deck finished adopting the world, or null before it has. */
  liveSince: number | null;
  /** Bring a session into view; what clicking a notification does. */
  focusSession: (sessionId: string) => void;
}

/** What /api/prefs answers, as far as this hook reads it. */
export interface NotifyPrefsAnswer {
  prefs?: { notifications?: boolean };
  notificationsVetoed?: boolean;
}

export function useOsNotifications({ waitingSessions, liveSince, focusSession }: OsNotificationsDeps) {
  // The fifth surface, and the only one that leaves the page.
  //
  // The four above — chip, title, favicon, live region — all answer "which
  // agent is waiting on me" to somebody who is already looking at the deck.
  // The block this feature exists for is the one nobody is looking at, and for
  // that one the deck's reply has been "come and look". A system notification
  // is the only thing it can say into an empty room.
  //
  // Every rule about WHETHER to speak is in notify.ts, where the bare-node
  // suite can call it; what is here is the DOM the rule is not allowed to own —
  // the permission read, the `new Notification`, the click that brings the tab
  // back. Same division as ambient.ts and block-announce.ts, for the same
  // reason: a rule spelled out inside a component is a rule the tests cannot
  // call, and what cannot be called gets copied and then drifts.
  //
  // THE MEMO IS A REF, NOT STATE. Nothing on screen reads it, and making it
  // state would re-render the whole canvas every time a notification was
  // raised — to show exactly what was already showing.
  //
  // The dependency is the KEY STRING and not the session list, the same trick
  // the announcement above uses and for the same measured reason: the list is
  // rebuilt whenever `revision` moves, which is every event and every sweep, so
  // a list-shaped dependency would re-run this through every event of every
  // tool storm. Joined keys move only when the set of blocks does.
  // Read once into state rather than off `Notification.permission` on the
  // render path, so that granting it re-renders the bar and takes the button
  // away. The initialiser has to tolerate the API being absent — this bundle
  // also runs in the bare-node suite, and `Notification` is not defined there.
  const [notifyPermission, setNotifyPermission] = useState<NotifyPermission>(
    () => (typeof Notification === "undefined" ? "denied" : Notification.permission as NotifyPermission),
  );
  /** What to say after the browser has been answered, or null when there is
   *  nothing to say. Pressing a button and watching it vanish is the same
   *  picture whether it worked or was refused, and the refusal is the one that
   *  matters: the user believes they switched something on that is off. */
  const [notifySaid, setNotifySaid] = useState<"on" | "blocked" | null>(null);
  /** Latched the first time the offer is shown. Without it the button is a
   *  moving target — it is mounted on `waitingSessions.length > 0`, so a block
   *  answered in the five seconds it takes to reach for it takes the button out
   *  from under the cursor. Once offered, it stays until it is answered. */
  /** The deck's own switch, which is a different question from the browser's
   *  permission. Brave may have said yes and the user may still want quiet —
   *  and a permission, once granted, is not something any page can hand back,
   *  so without this the only mute was in the browser's site settings. Held
   *  server-side (deck-prefs.mjs) rather than in localStorage, because the same
   *  switch governs the notifier that runs when no page exists at all. */
  /** Off until the first prefs read answers, which is also the stored default
   *  since 3.22.7. A switch drawn `on` over a deck that is not notifying is the
   *  one wrong guess this can make. */
  const [notifyOn, setNotifyOn] = useState(false);
  /** Whether the MACHINE has vetoed this — AGENTS_DECK_NO_NOTIFY=1 at launch.
   *  Not the same question as "is the switch off", and the menu says a
   *  different sentence for each: one is the user's own press, the other is
   *  somebody else's decision the press cannot undo until the next launch. */
  const [notifyVetoed, setNotifyVetoed] = useState(false);
  const askNotifyRef = useRef<() => void>(() => {});
  const toggleNotify = useCallback(() => {
    // Optimistic, and corrected by the answer. The switch is the one control
    // whose whole point is that it responds now; waiting for a round trip to a
    // loopback server would still be a flicker, and a failed write leaves the
    // UI saying what the file says rather than what the press wanted.
    const want = !notifyOn;
    setNotifyOn(want);
    // AND THE PRESS FINISHES THE JOB. Switching this on used to leave a switch
    // reading "on" above a line saying the browser had never been asked, which
    // is a control contradicting itself — the user's reasonable reply being
    // "if it is on, why must I do something else?". `requestPermission()` needs
    // a user gesture and this IS one, so the prompt goes up on the same press.
    // Only from off to on, only while the browser can still be asked, and the
    // switch stays on whatever the answer is: a refusal costs the page's
    // notifier, not the deck's, and block-notify.mjs needs no permission.
    // Through a ref because the asker is declared below this and a plain call
    // would be a use-before-define; a dependency on it would rebuild this
    // callback for no reason.
    if (want && typeof Notification !== "undefined" && Notification.permission === "default") {
      askNotifyRef.current();
    }
    fetch("/api/prefs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notifications: want }),
    }).then(r => (r.ok ? r.json() : null)).then(d => {
      if (!d?.ok) return;
      setNotifyOn(d.prefs?.notifications === true);
      setNotifyVetoed(d.notificationsVetoed === true);
    }).catch(() => {});
  }, [notifyOn]);
  const notifySupported = typeof Notification !== "undefined";
  // `canAsk` is still what decides whether a prompt can be raised at all; the
  // latch that used to remember "a session blocked once, so offer it" went with
  // the topbar button it existed for. The sound menu asks the question from a
  // place that is always there.
  const notifyAskable = canAsk(notifyPermission, notifySupported);
  // The confirmation is a status, not a state: it says what just happened and
  // then gets out of the bar. Eight seconds for a refusal against four for a
  // grant, because "blocked" is the one carrying instructions the user has to
  // read before it goes.
  useEffect(() => {
    if (!notifySaid) return;
    const ms = notifySaid === "blocked" ? 8000 : 4000;
    const t = setTimeout(() => setNotifySaid(null), ms);
    return () => clearTimeout(t);
  }, [notifySaid]);
  const askForNotifications = useCallback(() => {
    if (typeof Notification === "undefined") return;
    // Fire-and-forget on purpose. The promise resolves when the user answers,
    // which may be never — a Chrome prompt left sitting behind another window
    // is the normal case — and nothing here should wait on it.
    void Notification.requestPermission().then(p => {
      const answer = p as NotifyPermission;
      setNotifyPermission(answer);
      // "default" means the prompt was dismissed rather than answered — the
      // browser will ask again next time, so there is nothing to report and
      // nothing has changed.
      if (answer === "granted") setNotifySaid("on");
      else if (answer === "denied") setNotifySaid("blocked");
    });
  }, []);
  askNotifyRef.current = askForNotifications;
  const notifyRaisedRef = useRef<ReadonlySet<string>>(new Set());
  /** The permission the memo below was seeded against, so that a change of
   *  answer re-seeds exactly once. `null` until the first seed. */
  const notifySeededAtRef = useRef<NotifyPermission | null>(null);
  const blockedKeys = waitingSessions.map(b => blockKey(b.id, b.waiting)).join("|");

  // WHEN THE NOTIFIER STARTS WATCHING, it adopts the world as it finds it: a
  // deck opening onto a machine with four prompts already standing must not
  // fire four notifications about lunchtime, and a tab a session-restoring
  // browser brought back into the background is hidden, so the visibility gate
  // does not cover that on its own.
  //
  // "Starts watching" is TWO moments, and conflating them cost the feature its
  // first impression. Seeding used to live inside the raise effect behind the
  // `permission === "granted"` guard, so on the ordinary path — open the deck,
  // see a session blocked, press the button, allow — the seed had not happened
  // yet when permission arrived. The next block to come in was therefore
  // swallowed as history rather than announced, and the FIRST notification
  // after a user asked to be notified was silence. They press the button, get
  // nothing, and conclude the feature is broken; the one after that works, by
  // which time they are not looking.
  //
  // So this seeds on mount whatever the answer is, and again at the moment the
  // answer changes. Granting is the user saying "tell me from here", and what
  // is standing at that moment is on their screen — they were looking at it
  // when they pressed the button, so it is history too. What arrives next is
  // news, and it is the notification that has to land.
  useEffect(() => {
    if (!shouldReseed(notifySeededAtRef.current, notifyPermission)) return;
    notifySeededAtRef.current = notifyPermission;
    notifyRaisedRef.current = seedRaised(waitingSessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notifyPermission]);

  /** Whether the world has been adopted as history yet — the seed below runs
   *  once, on the FIRST replay, and a reconnect's replay must not re-run it. */
  const notifySeededReplayRef = useRef(false);

  // …AND THE MOMENT THAT ACTUALLY CARRIES THE BLOCKS (#968). The seed above runs
  // at mount, and at mount this deck knows nothing: `stateRef.current` is still
  // `initialState()`, because the EventSource that fills it is opened by an
  // effect and its first message cannot arrive before the mount commit. So
  // `waitingSessions` is `[]` there and `seedRaised([])` adopted an empty world
  // — then recorded itself as seeded, so it never ran again.
  //
  // The cost was the exact burst the seed exists to prevent. A tab a browser
  // restored INTO THE BACKGROUND after a reboot is hidden, so the visibility
  // gate does not cover it; the ring buffer replays three standing prompts with
  // their original `since`; the coalescer flushes one render at `replay-end`;
  // and `blockedKeys` moves from "" to three keys against an empty `raised` —
  // three notifications about prompts from before lunch, at once.
  //
  // `liveSince` is the moment the deck has finished adopting the world, so the
  // seed happens here instead. Declared BEFORE the raiser so that on the commit
  // where both fire — replay-end changes `liveSince` and `blockedKeys` together
  // — this one has already adopted them.
  useEffect(() => {
    if (!shouldSeedFromWorld(notifySeededReplayRef.current, liveSince)) return;
    notifySeededReplayRef.current = true;
    notifyRaisedRef.current = seedRaised(waitingSessions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSince]);

  useEffect(() => {
    if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
    // Never before EITHER seed above. Effects run in declaration order, so on
    // the commit that ends the first replay both have already adopted the
    // standing blocks — but a render that reordered them would turn every
    // restored deck into a burst, and the guard is one call.
    //
    // The `liveSince` half also holds the raiser through the replay itself:
    // blocks arriving there are history by definition, and returning here
    // leaves `raised` untouched, so the seed at replay-end still adopts them
    // rather than them being dropped.
    if (!mayRaise(notifySeededAtRef.current, liveSince)) return;
    const pageVisible = typeof document === "undefined" || !document.hidden;
    const notices = noticesFor(waitingSessions, notifyRaisedRef.current, pageVisible, notifyOn);
    for (const n of notices) {
      try {
        // `tag` is the block key, so a second deck on the same machine REPLACES
        // this notification in the tray rather than stacking a duplicate beside
        // it — the same fan-out that makes `since` load-bearing in the key.
        const note = new Notification(n.title, { body: n.body, tag: n.key });
        note.onclick = () => {
          // Bring the deck back and land on the session that asked, rather than
          // on whatever the canvas happened to be showing. A notification that
          // returns you to a page you then have to search is half a feature.
          window.focus();
          // The same handler the topbar's blocked chip clicks through, so the
          // notification lands the user exactly where the chip would have.
          focusSession(n.sessionId);
          note.close();
        };
      } catch {
        // A notification can throw where the API exists but the platform will
        // not raise one — a Linux desktop with no notification daemon is the
        // common case. It is not worth a message on screen: the four in-page
        // surfaces are all still saying it, which is the state the deck was in
        // before this existed.
      }
    }
    // Looking at the page counts as having been told, so a block that arrives
    // while the deck is on screen is remembered as seen and does not fire late
    // when the tab is next hidden. Both branches prune keys whose block is gone,
    // which is what stops the memo growing for the life of a tab left open for
    // days — safe only because the key carries `since`, so a block that cleared
    // and came back is a different key.
    notifyRaisedRef.current = pageVisible
      ? seedRaised(waitingSessions)
      : nextRaised(waitingSessions, notices, notifyRaisedRef.current);
    // `liveSince` as well as the keys, and it is not decoration. A block raised
    // while the stream was DOWN arrives during the reconnect's replay, when
    // this effect is gated off — so `blockedKeys` has already taken its new
    // value by the time the gate opens, and keyed on the keys alone this would
    // never run again for it. The reconnect's `replay-end` does not re-seed
    // (that is `shouldSeedFromWorld`'s first-replay-only guard), so on that
    // commit `raised` still lacks the block and it is announced — which is the
    // notification a user who walked away most wants.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blockedKeys, liveSince]);

  /** The notifications half of the one /api/prefs read App.tsx makes. */
  const loadNotifyPrefs = useCallback((d: NotifyPrefsAnswer) => {
    setNotifyOn(d.prefs?.notifications === true);
    setNotifyVetoed(d.notificationsVetoed === true);
  }, []);

  return { notifyPermission, notifySaid, notifyOn, notifyVetoed, toggleNotify,
           notifySupported, askForNotifications, loadNotifyPrefs };
}
