import { useCallback, useRef, useState } from "react";

interface CodexStartupPrefsAnswer {
  ok?: boolean;
  prefs?: { codexStartupDiscoveryEnabled?: boolean };
}

/** The startup relationship scan is a server setting: the watcher, not this
 *  browser tab, owns the rollout reads. */
export function useCodexStartupDiscovery() {
  const [enabled, setEnabled] = useState(true);
  const touchedRef = useRef(false);
  const confirmedRef = useRef(true);
  const desiredRef = useRef(true);
  const revisionRef = useRef(0);
  const forceWriteRef = useRef(false);
  const writeRef = useRef<Promise<void> | null>(null);
  const drainRef = useRef<() => void>(() => {});

  const loadCodexStartupPrefs = useCallback((d: CodexStartupPrefsAnswer) => {
    if (touchedRef.current) return;
    const value = d.prefs?.codexStartupDiscoveryEnabled !== false;
    confirmedRef.current = value;
    desiredRef.current = value;
    setEnabled(value);
  }, []);

  const drainWrites = useCallback(() => {
    if (writeRef.current) return;
    const work = (async () => {
      while (forceWriteRef.current || desiredRef.current !== confirmedRef.current) {
        const target = desiredRef.current;
        const revision = revisionRef.current;
        forceWriteRef.current = false;
        try {
          const response = await fetch("/api/prefs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ codexStartupDiscoveryEnabled: target }),
          });
          if (!response.ok) throw new Error("Codex startup preference write failed");
          const answer = await response.json() as CodexStartupPrefsAnswer;
          if (!answer?.ok) throw new Error("Codex startup preference write was rejected");
          const confirmed = typeof answer.prefs?.codexStartupDiscoveryEnabled === "boolean"
            ? answer.prefs.codexStartupDiscoveryEnabled
            : target;
          confirmedRef.current = confirmed;
          if (revision === revisionRef.current) {
            desiredRef.current = confirmed;
            setEnabled(confirmed);
          }
        } catch {
          // An older failed write must not cancel a newer user choice. Re-send
          // that latest intent even if it matches the last confirmed value: a
          // failed response cannot tell us whether the server committed it.
          if (revision !== revisionRef.current) {
            forceWriteRef.current = true;
            continue;
          }
          desiredRef.current = confirmedRef.current;
          forceWriteRef.current = false;
          setEnabled(confirmedRef.current);
          break;
        }
      }
    })();
    writeRef.current = work;
    void work.finally(() => {
      if (writeRef.current !== work) return;
      writeRef.current = null;
      if (forceWriteRef.current || desiredRef.current !== confirmedRef.current) drainRef.current();
    });
  }, []);
  drainRef.current = drainWrites;

  const toggleCodexStartupDiscovery = useCallback(() => {
    const next = !desiredRef.current;
    desiredRef.current = next;
    revisionRef.current += 1;
    forceWriteRef.current = true;
    touchedRef.current = true;
    setEnabled(next);
    drainWrites();
  }, [drainWrites]);

  return { codexStartupDiscoveryEnabled: enabled, loadCodexStartupPrefs, toggleCodexStartupDiscovery };
}
