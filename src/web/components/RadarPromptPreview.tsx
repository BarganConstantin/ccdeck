import { useEffect, useRef, useState } from "react";
import type { CapturedExport } from "../use-telemetry-capture";
import { promptPreview } from "../telemetry-highlights";

/** Load content only for prompt exports near the visible part of the feed. */
export default function RadarPromptPreview({ event }: { event: CapturedExport }) {
  const node = useRef<HTMLSpanElement>(null);
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let started = false;
    const load = () => {
      if (started) return;
      started = true;
      void fetch(`/api/system/traffic-radar/capture/event?id=${event.id}`, { signal: controller.signal }).then(async response => {
        if (!response.ok) return;
        const data = await response.json();
        if (!controller.signal.aborted) setPreview(promptPreview(data.payload));
      }).catch(() => {});
    };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { load(); observer?.disconnect(); } }, { rootMargin: "100px" });
    if (node.current && observer) observer.observe(node.current); else load();
    return () => { controller.abort(); observer?.disconnect(); };
  }, [event.id, event.observedAt]);
  return <span ref={node} className="tr-prompt-preview">{preview ?? "Prompt-related fields · open to inspect"}</span>;
}
