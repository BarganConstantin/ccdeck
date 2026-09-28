// A lookup that answers only out of a table's own rows (#474).
//
// Every table in the client that turns a name into an emoji, a label or a
// server's identity is an object literal, and an object literal inherits from
// `Object.prototype`: `TABLE["constructor"]` is a function and
// `TABLE["__proto__"]` is the prototype itself, and neither `?? fallback` nor a
// truthiness test can see past either one. The names these tables are asked
// about are not the deck's to choose — a tool name off a hook payload, the
// first word of a command an agent ran, a filename, an MCP server segment — so
// the question has to be "is there a ROW for this name", not "is there a value".
//
// tool-skin.ts asked it six times, each spelled out as
// `Object.hasOwn(T, k) ? T[k] : fallback`, so a seventh table added there had
// six places to copy the guard from and none that said why. This is the one
// spelling, and the reason goes with it.

/** The table's own row for `key`, or undefined when it has none — whatever
 *  `Object.prototype` answers for that name. */
export function ownRow<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}
