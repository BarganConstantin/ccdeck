// The 30-second videos on ccdeck.dev, one per guide, and where each one opens.
//
// Every address in one place, so a guide that moves on the site is a one-line
// change here. Plain addresses with no query string: the deck sends nothing
// for a press on one of these, and the browser it opens in is the reader's own.

const SITE = "https://ccdeck.dev/guides";

/** Which film, the page it plays on, and what it is about in a sentence's words. */
export const FILMS = {
  localNetwork: { href: `${SITE}/local-network/#film`, subject: "Local network" },
  claudeAccounts: { href: `${SITE}/claude-accounts/#film`, subject: "Claude accounts" },
  usage: { href: `${SITE}/cost-and-quota/#film`, subject: "cost and quota" },
  tour: { href: `${SITE}/first-run/#film`, subject: "first run" },
} as const;

export type Film = keyof typeof FILMS;
