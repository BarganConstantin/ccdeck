// What a machine between two paired decks can read in the lines they send once
// the handshake is done — the check lan-sealed-frames-810.test.ts makes of every
// round, here on its own so lan-sealed-readable-1846.test.ts can hand it lines
// it built.
//
// NOT A SEARCH OF THE RAW LINE (#1846). After the handshake a line is
// `{"sealed":"<base64>","tag":"<base64>"}`, so the raw line is nearly all
// ciphertext, and a four-letter word from the list — "want", "have" — turns up
// in random base64 about once per 64^4 places. Over one round's few KB that
// failed the suite once in a few thousand runs, with nothing leaked.
//
// So a line is read in two parts. EVERYTHING BUT THE CIPHERTEXT is searched for
// every secret, as plainly as before: a frame that went out in the clear, or a
// field beside the seal, is caught here. That part holds nothing but the two
// field names on a good line, so no draw of the ciphertext can trip it.
//
// THE CIPHERTEXT has to be ciphertext, not merely look like it. Each value must
// be base64 and nothing else, and the bytes it decodes to must not spell any
// secret the way JSON writes it — quotes and all, as a frame in the clear
// carries its verb (`"t":"have"`) and its field names. That catches a frame
// that was only put in a base64 coat, by its verb, whatever else it carries.
// And the quotes are what make it safe to run on random bytes: the shortest
// needle is six bytes, which uniform bytes spell by chance about once in 2^48
// places — never, at a few hundred bytes a round. Unquoted, a four-letter word
// is a needle of four bytes and once in 2^32: the same coin toss, only rarer.

/** The two fields a sealed frame has, and all it may have. */
const SEAL_FIELDS = ["sealed", "tag"];

/** One of those fields as a sealed frame spells it: a value in the base64
 *  alphabet. What is not in the alphabet stays on the line and is searched. */
const CIPHERTEXT = /"(sealed|tag)":"([A-Za-z0-9+/=]*)"/g;

/** Base64 and nothing else, at least one byte of it. Node's decoder skips what
 *  is not in the alphabet, so only such a value survives the round trip. */
const isBase64 = (v: unknown): v is string =>
  typeof v === "string" && v !== "" && Buffer.from(v, "base64").toString("base64") === v;

/** What of `secrets` can be read in `lines`, one line per finding — empty when
 *  nothing can. */
export function readableOnWire(lines: readonly string[], secrets: readonly string[]): string[] {
  const found: string[] = [];
  lines.forEach((line, i) => {
    const at = `line ${i + 1}`;
    let frame: unknown = null;
    try { frame = JSON.parse(line); } catch { /* not JSON, reported below */ }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      found.push(`${at} is not a sealed frame`);
    } else {
      for (const [field, value] of Object.entries(frame)) {
        if (!SEAL_FIELDS.includes(field)) found.push(`${at} carries "${field}" beside the seal`);
        else if (!isBase64(value)) found.push(`${at}: its "${field}" is not base64`);
      }
    }
    const rest = line.replace(CIPHERTEXT, (whole: string, field: string, value: string) => {
      if (!isBase64(value)) return whole;
      const bytes = Buffer.from(value, "base64");
      for (const s of secrets) {
        if (bytes.includes(JSON.stringify(s))) found.push(`${at}: its "${field}" decodes to ${JSON.stringify(s)}`);
      }
      return `"${field}":""`;
    });
    for (const s of secrets) if (rest.includes(s)) found.push(`${at}: "${s}" is readable outside the seal`);
  });
  return found;
}
