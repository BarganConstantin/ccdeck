// What a tone's <select> carries as its value (#1207): a built-in figure's id
// as it is, or a custom sound's id behind a prefix no figure id starts with.
//
// One select offers both kinds and an <option> value is one string, so the
// kind rides in the string. Written once here rather than as a template in two
// places and a `startsWith` in a third, beside a bare `slice(7)` that was the
// prefix's length restated by hand.

const CUSTOM_PREFIX = "custom:";

/** The option value that stands for a custom sound. */
export function customOptionValue(id: string): string {
  return `${CUSTOM_PREFIX}${id}`;
}

/** The custom sound an option value stands for, or null for a built-in figure. */
export function customIdOf(value: string): string | null {
  return value.startsWith(CUSTOM_PREFIX) ? value.slice(CUSTOM_PREFIX.length) : null;
}
