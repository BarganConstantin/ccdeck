// An error our own code threw on purpose, with a sentence already in the
// language on show. A catch that puts an error on screen shows only these:
// any other thrown thing (a fetch's "Failed to fetch", a JSON parse error, a
// DOMException from the browser) is English from outside, so the site shows
// its own translated fallback instead.
export class OwnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnError";
  }
}

/** The error's sentence when it is one of ours; otherwise the fallback. */
export function ownMessage(err: unknown, fallback: string): string {
  return err instanceof OwnError && err.message ? err.message : fallback;
}
