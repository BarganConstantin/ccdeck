// The two window events the account listens for, named once: what
// use-event-stream.ts dispatches for the deck stream's `event: account`, and
// for the stream opening again after a restart. Their own module, so the
// stream can name them without importing the account's code, which loads only
// when the account is on (use-account.ts).
export const ACCOUNT_EVENT = "ccdeck:account";
export const STREAM_OPEN_EVENT = "ccdeck:stream-open";
