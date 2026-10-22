// For a suite that draws Settings, Settings search or the keyboard tables as a
// deck with integrations draws them: the list such a deck answers, every kind
// offered, read through the client as the page reads it. The page draws
// integrations only once the deck has said a kind is offered
// (integrations/client.ts, offeredKinds), so such a suite says so first.
import { refreshIntegrations } from "../integrations/client";

export async function deckOffersEveryKind(): Promise<void> {
  const g = globalThis as { window?: unknown; fetch: typeof fetch };
  const had = { window: g.window, fetch: g.fetch };
  g.window = { setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout };
  g.fetch = async () => new Response(JSON.stringify({
    ok: true,
    providers: [
      { kind: "jira", label: "Jira", available: true },
      { kind: "github", label: "GitHub", available: true },
      { kind: "gitlab", label: "GitLab", available: true },
    ],
    connections: [],
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    await refreshIntegrations();
  } finally {
    g.fetch = had.fetch;
    if (had.window === undefined) delete g.window;
    else g.window = had.window;
  }
}
