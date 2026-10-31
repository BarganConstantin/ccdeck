// English: the source of truth. Every other catalog is measured against this
// one (i18n.test.ts), and any key a language lacks falls back to it.
//
// Keys are stable ids, never the English sentence, so a copy edit here does not
// orphan the translations. {name} marks a value filled in at run time and must
// appear, spelled the same, in every translation of that key. A key may have
// plural forms, "<key>.one" / "<key>.other" (and few/many/... where a language
// needs them), picked by the `count` value; see translate.ts.
//
// Not translated, on purpose: product names (ccdeck, Claude Code, Codex,
// Claude, Sonnet, Opus), model names, command and file names, numbers and the
// formats of times and units ("2d 4h", "12%").
export const en = {
  // ── Language ─────────────────────────────────────────────────────────────
  "language.group": "Language",
  "language.name": "Interface language",
  "language.note": "Saved in this browser. Anything not translated yet stays in English.",

  // ── Settings chrome ──────────────────────────────────────────────────────
  "settings.title": "Settings",
  "settings.close": "Close settings",
  "settings.closeTip": "Close (Esc)",
  "settings.sections": "Settings sections",
  "settings.section.general.label": "General",
  "settings.section.general.note": "Session behavior, board preferences, and automatic updates.",
  "settings.section.appearance.label": "Appearance",
  "settings.section.appearance.note": "The colour theme and the character on the canvas.",
  "settings.section.reading.label": "Text & density",
  "settings.section.reading.note": "Make the deck comfortable to read. Changes apply immediately and stay separate from canvas zoom.",
  "settings.section.keyboard.label": "Keyboard",
  "settings.section.keyboard.note": "Keyboard shortcuts and single-key controls.",
  "settings.section.notifications.label": "Notifications",
  "settings.section.notifications.note": "How the deck reaches you while you are not looking at it.",
  "settings.section.sounds.label": "Sounds",
  "settings.section.sounds.note": "Notification tones and custom audio.",
  "settings.section.integrations.label": "Integrations",
  "settings.section.integrations.note": "Manage connections to your developer tools.",
  "settings.section.data.label": "Data",
  "settings.section.data.note": "What the deck keeps on this device.",
  "settings.section.claude.label": "Claude Code",
  "settings.section.claude.note": "Claude Code settings, saved to your settings.json. Most changes reach running sessions.",
  "settings.section.radar.label": "Radar",
  "settings.section.radar.note": "What Claude Code sends to its telemetry collector, watched all the time.",
  "settings.section.about.label": "About",
  "settings.section.about.note": "The version you are running, and where to say what you think of it.",

  // ── Usage panel ──────────────────────────────────────────────────────────
  "usage.title": "Usage",
  "usage.close": "Close",
  "usage.closePanel": "Close usage panel",
  "usage.historyOpen": "Open quota history",
  "usage.history": "Quota history",
  "usage.refresh.both": "Refresh Claude + Codex quota",
  "usage.refresh.codex": "Refresh Codex quota",
  "usage.refresh.claude": "Refresh Claude quota",
  "usage.period.label": "Period",
  "usage.period.today": "today",
  "usage.period.month": "month",
  "usage.period.all": "all",
  "usage.period.today.noun": "today",
  "usage.period.month.noun": "this month",
  "usage.period.all.noun": "all time",
  "usage.period.today.hint": "Since midnight, on this machine's clock.",
  "usage.period.month.hint": "Since the 1st of this calendar month — not the last 30 days.",
  "usage.period.all.hint": "Every transcript on disk, back to 2020.",
  "usage.period.reading": "Reading {period} from the transcripts on this machine…",
  "usage.period.readingShort": "Reading {period}…",
  "usage.estimate": "Local estimate · {source}",
  "usage.source.live": "live sessions",
  "usage.tokens.in": "in",
  "usage.tokens.out": "out",
  "usage.tokens.cacheRead": "cache r",
  "usage.tokens.cacheCreate": "cache c",
  "usage.bySession": "By session",
  "usage.noSessionDated": "No session falls in this period yet — ccusage dates sessions in UTC, and the totals above are your local day.",
  "usage.empty.all": "No usage in any transcript on this machine.",
  "usage.empty.period": "No usage {period}.",
  "usage.empty.longer": "Try a longer period.",
  "usage.empty.none": "No usage data yet.",
  "usage.empty.start": "Start a Claude Code or Codex session.",

  // ── Durations: "2d 4h", "1h 5m", "12m" ──────────────────────────────────
  "time.dh": "{d}d {h}h",
  "time.hm": "{h}h {m}m",
  "time.m": "{m}m",

  // ── Quota sections and bars ──────────────────────────────────────────────
  "quota.claude.title": "Claude quota",
  "quota.codex.title": "Codex quota",
  "quota.window.hours": "{n}-hour window",
  "quota.window.days": "{n}-day window",
  "quota.window.rateLimit": "Rate limit",
  "quota.sonnet7d": "Sonnet (7d)",
  "quota.opus7d": "Opus (7d)",
  "quota.extra": "Extra credits (month)",
  "quota.extraCurrency": "Extra credits (month, {currency})",
  "quota.extraOn": "extra usage credits: on",
  "quota.spendCap": "spend cap · {used} of {limit}",
  "quota.creditsBalance": "credits: {amount}",
  "quota.creditsUnlimited": "credits: unlimited",
  "quota.overage": "overage limit reached",
  "quota.partial": "Partial data — OpenAI returned limits this build doesn't recognise.",
  "quota.none": "No quota to show.",
  "quota.unavailable": "Quota unavailable.",
  "quota.checking": "Checking…",
  "quota.noNewer": "no newer reading",
  "quota.age.now": "just now",
  "quota.age.seconds": "{n}s ago",
  "quota.age.minutes": "{n}m ago",
  "quota.age.hours": "{n}h ago",
  "quota.source.swap": "Read from claude-swap's last collection — costs no request against your usage-endpoint budget. Saved limit resets, which it does not collect, are read separately: every 30 minutes, or 5 on refresh",
  "quota.source.api": "Fetched from Anthropic's usage endpoint, at most once every 5 minutes",
  "quota.source.cli": "Parsed from `claude /usage`, at most once every 5 minutes",
  "quota.source.other": "Last update",
  "quota.source.codex": "Fetched from the Codex usage endpoint",
  "quota.hint.noSubscription": "This install signs in with an API key (or Bedrock/Vertex), which is billed per token and has no session window.",
  "quota.hint.rateLimitedAnthropic": "Anthropic asked the deck to wait — it will retry on its own.",
  "quota.hint.waiting": "Waiting for the next allowed read — or click ↻.",
  "quota.hint.runUsage": "Run /usage in a claude session, then click ↻",
  "quota.hint.codexNoToken": "Run codex login to authenticate.",
  "quota.hint.codexApiKey": "API-key login — ChatGPT quota is only available for codex login.",
  "quota.hint.codexExpired": "Codex session expired — run codex login.",
  "quota.hint.codexRefreshFailed": "Couldn't refresh the Codex token — click ↻ to retry.",
  "quota.hint.codexUntrusted": "chatgpt_base_url in ~/.codex/config.toml is not an https OpenAI host, so the token was not sent.",
  "quota.hint.rateLimitedOpenai": "OpenAI asked the deck to wait — it will retry on its own.",
  "quota.hint.codexUnreachable": "ChatGPT API unreachable — click ↻ to retry.",
  "quota.rateLimitReached": "Rate limit reached",
  "quota.rolled": "reset",
  "quota.noReading": "no reading",
  "quota.waitingReading": "waiting for a new reading",
  "quota.resetsIn": "resets in {time}",
  "quota.resetsAt": "resets {when}",
  "quota.pace.usedUp": "used up",
  "quota.pace.onPace": "on pace",
  "quota.pace.over": "{n}% over pace",
  "quota.pace.under": "{n}% under pace",
  "quota.pace.runsOut": "runs out in {time}",
  "quota.pace.target": "To last until reset, stay near {pct}% by now",
  "quota.pace.why": "To last until reset, stay near {pct}% by now.",
  "quota.pace.whyPerDay": "To last until reset, stay near {pct}% by now. About {n}% a day left.",
} as const;

export type MessageKey = keyof typeof en;

/** Any catalog as the lookup sees it. */
export type Catalog = Readonly<Record<string, string>>;

/** A translation: some or all of English's keys, and no others. */
export type Translation = Partial<Record<MessageKey, string>>;
