// The door into the event pipeline for the modules the pipeline itself
// imports.
//
// pushEvent lives in src/server/index.mjs, with the ring, the SSE fan-out and
// the log it feeds, and for every hook event it asks session-enrichment.mjs to
// read the session's transcript. The enrichment answers with synthetic events
// of its own — ModelObserved, UsageObserved, SessionNamed, ContextObserved —
// and those go back through pushEvent. So the two need each other by nature,
// and src/server keeps no import cycles (boot-module-graph.test.ts). This is
// where the cycle is broken: a module that emits imports pushEvent from here,
// and index.mjs connects the real one as it loads — before any event can
// exist, because nothing emits until a request or a timer that startServer
// arms asks it to.

let _sink = null;

/** Hand an event to the pipeline — index.mjs's pushEvent, with its arguments
 *  and its answer unchanged. */
export function pushEvent(raw, source, opts) {
  return _sink(raw, source, opts);
}

/** index.mjs's, once, as it loads. */
export function connectEventSink(push) {
  _sink = push;
}
