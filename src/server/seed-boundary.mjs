// What tmux's parser holds at a seed's boundary, kept from the pane's own
// output so the seed can hand it on (tmux-control.mjs, "The seed boundary").
//
// WHY. A seed is tmux's SCREEN — capture-pane's cells and the modes a format
// reports — not tmux's PARSER. A capture lands between two of tmux's reads of
// the pane, and those can split one write: a macOS pty hands tmux a large
// frame in pieces of about a kilobyte. The parser then holds what the cut left
// it in: the pen the next cells are drawn with, the start of an escape
// sequence, the first bytes of a character. No format reports any of them,
// and the seed resets the emulator, so the output after the boundary used to
// land in a parser at rest with the default pen: the rest of a row came out
// uncoloured, the rest of a sequence printed as text ("6mCUT"), a character
// lost its first bytes. A seed that would need another one after it to be
// right is a flicker; this makes the one seed exact.
//
// WHAT. Every byte of the pane's output the client is sent goes through
// feed() — streamed or not: output that arrives before a seed's capture is
// dropped from the stream, not from here — and is read the way the emulator
// the panel runs reads it (xterm.js 6: its UTF-8 decoding, then its VT500
// parser's states). tail() is what the client writes right after the seed's
// own bytes:
//
//   the pen     the SGR sequences since the pen was last reset, less each one
//               whose every attribute a later one sets again — an SGR
//               parameter sets an attribute whole — so that replaying them
//               ends in the same pen, in a few hundred bytes at most. A DECSC
//               (ESC 7, CSI s, ?1048h, ?1049h) keeps a copy for the screen it
//               is on, and a DECRC (ESC 8, CSI u, ?1048l, ?1049l) puts it back.
//   the rest    the sequence the output stopped inside, from its ESC (or C1
//               introducer), less the C0 controls in it that took effect
//               already; then the first bytes of a character the output
//               stopped inside. The bytes that finish them come next in the
//               stream, as they come to tmux.
//
// WHAT IT PRESUMES. At attach: a parser at rest, the default pen and the
// normal screen — what a pane set before the client attached is not in its
// stream, and the seed always presumed as much. After a %pause (lose()), tmux
// has skipped bytes: the pen is presumed default again, and no unfinished
// sequence is handed on until an ESC, CAN, SUB or C1 control says where the
// parser is. The client's quiet reseed covers that window, and presume() is
// that reseed taking a quiet pane as at rest.
//
// WHAT IT DOES NOT HAND ON: the character sets (G0-G3, SO/SI); an OSC 8
// hyperlink; what a DECSC saved before the seed, the cursor and its pen (no
// format reports the cursor, and the seed's reset clears the emulator's, so a
// DECRC after the seed restores what the seed left); a wrap pending at the
// right margin; a sequence longer than PENDING_MAX (a large OSC 52 or sixel
// image); the underline colour and style across a DECRC (xterm.js keeps the
// current ones there, this the saved ones); and a combining mark that is the
// first thing after the boundary: xterm.js joins a mark only to a character
// printed in the same run of text, and the seed's own bytes end that run.
//
// Pure: no I/O, no timers.
import { unfinishedTail } from "./utf8-carry.mjs";

/** The most bytes of an unfinished sequence handed on; past it, none are. */
export const PENDING_MAX = 16 * 1024;

/** The most bytes of SGR sequences a pen is kept in, once compacted; past it
 *  the pen is presumed default. */
export const PEN_MAX = 4 * 1024;

// The pen is compacted once its sequences pass this many bytes.
const PEN_COMPACT = 256;

// How many SGR parameter strings a reader remembers what they set for.
const KNOWN_MAX = 256;

// xterm.js keeps 32 parameters of a sequence and drops the rest; an SGR with
// more is replayed as it came, but never read for what it sets.
const MAX_PARAMS = 32;

// The VT500 parser's states, as xterm.js has them.
const GROUND = 0;
const ESCAPE = 1;
const ESC_INTER = 2;
const CSI_ENTRY = 3;
const CSI_PARAM = 4;
const CSI_INTER = 5;
const CSI_IGNORE = 6;
const SOS_PM_APC = 7;
const OSC = 8;
const DCS_ENTRY = 9;
const DCS_PARAM = 10;
const DCS_INTER = 11;
const DCS_IGNORE = 12;
const DCS_PASS = 13;

// The attributes an SGR parameter sets, each one whole.
const BOLD = 1 << 0;
const DIM = 1 << 1;
const ITALIC = 1 << 2;
const UNDERLINE = 1 << 3;   // the flag and the style (4, 4:n, 21, 24)
const BLINK = 1 << 4;
const INVERSE = 1 << 5;
const INVISIBLE = 1 << 6;
const STRIKE = 1 << 7;
const OVERLINE = 1 << 8;
const FG = 1 << 9;
const BG = 1 << 10;
const UL_COLOUR = 1 << 11;
const ALL = (1 << 12) - 1;

const SIMPLE = new Map([
  [1, BOLD], [2, DIM], [3, ITALIC], [4, UNDERLINE], [5, BLINK], [7, INVERSE], [8, INVISIBLE], [9, STRIKE],
  [21, UNDERLINE], [22, BOLD | DIM], [23, ITALIC], [24, UNDERLINE], [25, BLINK], [27, INVERSE], [28, INVISIBLE],
  [29, STRIKE], [39, FG], [49, BG], [53, OVERLINE], [55, OVERLINE], [59, UL_COLOUR],
]);

/** C0 controls xterm.js executes where they stand, inside a sequence too. */
const executable = (c) => c <= 0x17 || c === 0x19 || (c >= 0x1c && c <= 0x1f);

/** An SGR's parameter string as xterm.js reads it: numbers, each with the
 *  colon sub-parameters after it, an empty one as 0 (or -1 as a sub). */
function sgrParams(text) {
  return text.split(";").map((part) => {
    const [main, ...subs] = part.split(":");
    return { v: Number(main || 0), subs: subs.length ? subs.map(s => (s === "" ? -1 : Number(s))) : null };
  });
}

/** How many parameters after `pos` a 38, 48 or 58 at `pos` takes, and the
 *  colour mode it names, read as xterm.js reads it (InputHandler's
 *  _extractColor). Only modes 2 and 5 change the colour. */
function colourAdvance(ps, pos) {
  const accu = [0, 0, -1, 0, 0, 0];
  let cSpace = 0;
  let advance = 0;
  do {
    accu[advance + cSpace] = ps[pos + advance].v;
    const subs = ps[pos + advance].subs;
    if (subs) {
      let i = 0;
      do {
        if (accu[1] === 5) cSpace = 1;
        accu[advance + i + 1 + cSpace] = subs[i];
      } while (++i < subs.length && i + advance + 1 + cSpace < accu.length);
      break;
    }
    if ((accu[1] === 5 && advance + cSpace >= 2) || (accu[1] === 2 && advance + cSpace >= 5)) break;
    if (accu[1]) cSpace = 1;
  } while (++advance + pos < ps.length && advance + cSpace < accu.length);
  return { advance, mode: accu[1] };
}

/** The attributes an SGR's parameters set, or -1 when one of them is not
 *  understood here (such a sequence is kept, and never counted as setting
 *  anything again). */
export function sgrSets(text) {
  const ps = sgrParams(text);
  if (ps.length > MAX_PARAMS) return -1;
  let sets = 0;
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i].v;
    if (p === 0) sets |= ALL;
    else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) sets |= FG;
    else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) sets |= BG;
    else if (p === 38 || p === 48 || p === 58) {
      const { advance, mode } = colourAdvance(ps, i);
      if (mode === 2 || mode === 5) sets |= p === 38 ? FG : p === 48 ? BG : UL_COLOUR;
      i += advance;
    } else if (SIMPLE.has(p)) sets |= SIMPLE.get(p);
    else return -1;
  }
  return sets;
}

/**
 * A new reader of one pane's output: feed(bytes) for every %output of the
 * pane, in order; tail() for what a seed taken now hands on; lose() at a
 * %pause; presume() when the client takes a quiet pane as at rest.
 */
export function seedBoundary() {
  let state = GROUND;
  let placed = true;        // whether `state` is where the emulator's parser is
  const pending = [];       // the unfinished sequence's bytes, its introducer first
  let overflow = false;     // the unfinished sequence passed PENDING_MAX
  const u8 = [0, 0, 0, 0];  // the bytes of a character begun and not finished
  let u8len = 0;
  let need = 0;             // how many more that character takes
  let pen = [];             // { seq, sets } in order
  let penBytes = 0;
  let screen = "normal";
  let saved = { normal: null, alt: null };
  const known = new Map();  // an SGR's parameters -> what they set

  const toGround = () => {
    state = GROUND;
    pending.length = 0;
    overflow = false;
  };
  /** Keep the character just read: `c` itself, or the bytes of a character
   *  decoded from several. */
  const keep = (c, multi) => {
    if (overflow) return;
    if (pending.length + (multi ? u8len : 1) > PENDING_MAX) {
      overflow = true;
      pending.length = 0;
      return;
    }
    if (multi) for (let k = 0; k < u8len; k++) pending.push(u8[k]);
    else pending.push(c);
  };
  const begin = (next, c, multi) => {
    toGround();
    state = next;
    keep(c, multi);
  };

  const setPen = (entries) => {
    pen = entries;
    penBytes = entries.reduce((n, e) => n + e.seq.length, 0);
  };
  const compact = () => {
    let covered = 0;
    const kept = [];
    for (let k = pen.length - 1; k >= 0; k--) {
      const e = pen[k];
      if (e.sets >= 0 && (e.sets & ~covered) === 0) continue;
      kept.push(e);
      if (e.sets >= 0) covered |= e.sets;
    }
    setPen(kept.reverse());
    if (penBytes > PEN_MAX) setPen([]);
  };
  const sgr = (text) => {
    // A reset and nothing else leaves the pen the seed leaves.
    if (/^[0;]*$/.test(text)) return setPen([]);
    // A program sets the same few colours over and over.
    let sets = known.get(text);
    if (sets === undefined) {
      if (known.size >= KNOWN_MAX) known.clear();
      sets = sgrSets(text);
      known.set(text, sets);
    }
    const seq = `\x1b[${text}m`;
    if (sets === ALL) setPen([]);
    pen.push({ seq, sets });
    penBytes += seq.length;
    if (penBytes > PEN_COMPACT) compact();
  };
  const save = () => { saved[screen] = pen.slice(); };
  const restore = () => { setPen(saved[screen] ? saved[screen].slice() : []); };
  const reset = () => {
    setPen([]);
    screen = "normal";
    saved = { normal: null, alt: null };
  };

  // A sequence is read whole at its final byte, from `pending`: its
  // introducer (ESC and one byte, or a two-byte C1), what came between, and
  // the final. The C0 controls in it are not kept.
  const escDispatch = (final) => {
    if (pending.length !== 2) return;      // intermediates, or past PENDING_MAX
    if (final === 0x37) save();            // ESC 7, DECSC
    else if (final === 0x38) restore();    // ESC 8, DECRC
    else if (final === 0x63) reset();      // ESC c, RIS
  };
  /** Only these CSI finals touch the pen or the screen it is saved for. */
  const touches = (final) => final === 0x6d || final === 0x73 || final === 0x75 || final === 0x70 || final === 0x68 || final === 0x6c;
  /** A CSI from what lies between its introducer and its final, read as the
   *  parser's states read it: a prefix (< = > ?), parameters (0-9 : ;),
   *  intermediates (space to /), in that order, or the sequence is ignored. */
  const csi = (body, final) => {
    let prefix = "";
    let at = 0;
    const p0 = body.charCodeAt(0);
    if (p0 >= 0x3c && p0 <= 0x3f) { prefix = body[0]; at = 1; }
    let end = at;
    while (end < body.length && body.charCodeAt(end) <= 0x3b && body.charCodeAt(end) >= 0x30) end++;
    let last = end;
    while (last < body.length && body.charCodeAt(last) <= 0x2f && body.charCodeAt(last) >= 0x20) last++;
    if (last !== body.length) return;
    const params = body.slice(at, end);
    const inter = body.slice(end);
    if (prefix === "" && inter === "") {
      if (final === 0x6d) sgr(params);
      else if (final === 0x73) save();       // CSI s
      else if (final === 0x75) restore();    // CSI u
    } else if (prefix === "" && inter === "!" && final === 0x70) {   // CSI ! p, DECSTR
      setPen([]);
      saved[screen] = [];
    } else if (prefix === "?" && inter === "" && (final === 0x68 || final === 0x6c)) {
      const on = final === 0x68;
      for (const { v } of sgrParams(params)) {
        if (v === 1048) on ? save() : restore();
        else if (v === 1049) {
          if (on) { save(); screen = "alt"; } else { screen = "normal"; restore(); }
        } else if (v === 47 || v === 1047) screen = on ? "alt" : "normal";
      }
    }
  };
  const csiDispatch = (final) => {
    if (overflow || !touches(final)) return;
    csi(String.fromCharCode.apply(null, pending.slice(2, -1)), final);
  };

  /** One character `c` through the parser's states; `multi` when its bytes
   *  are the character just decoded (u8), not the byte `c` itself. */
  const step = (c, multi) => {
    if (!placed) {
      // After skipped bytes, only these say where the parser is.
      if (c === 0x1b || c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f)) placed = true;
      else return;
    }
    // From any state.
    if (c === 0x1b) return begin(ESCAPE, c, multi);
    if (c === 0x9b) return begin(CSI_ENTRY, c, multi);
    if (c === 0x9d) return begin(OSC, c, multi);
    if (c === 0x90) return begin(DCS_ENTRY, c, multi);
    if (c === 0x98 || c === 0x9e || c === 0x9f) return begin(SOS_PM_APC, c, multi);
    if (c === 0x18 || c === 0x1a || (c >= 0x80 && c <= 0x9f)) return toGround();
    const wide = c >= 0xa0;
    switch (state) {
      case GROUND:
        return;
      case ESCAPE:
        if (executable(c) || c === 0x7f) return;
        if (wide) return toGround();
        keep(c, multi);
        if (c <= 0x2f) { state = ESC_INTER; return; }
        if (c === 0x5b) { state = CSI_ENTRY; return; }
        if (c === 0x5d) { state = OSC; return; }
        if (c === 0x50) { state = DCS_ENTRY; return; }
        if (c === 0x58 || c === 0x5e || c === 0x5f) { state = SOS_PM_APC; return; }
        escDispatch(c);
        return toGround();
      case ESC_INTER:
        if (executable(c) || c === 0x7f) return;
        if (wide) return toGround();
        keep(c, multi);
        if (c <= 0x2f) return;
        escDispatch(c);
        return toGround();
      case CSI_ENTRY:
      case CSI_PARAM:
      case CSI_INTER:
        if (executable(c) || c === 0x7f) return;
        if (wide) return toGround();
        keep(c, multi);
        if (c >= 0x40) { csiDispatch(c); return toGround(); }
        if (c <= 0x2f) { state = CSI_INTER; return; }
        if (state === CSI_INTER) { state = CSI_IGNORE; return; }
        if (c <= 0x3b) { state = CSI_PARAM; return; }
        // A prefix (< = > ?) opens a sequence; anywhere else it spoils it.
        state = state === CSI_ENTRY ? CSI_PARAM : CSI_IGNORE;
        return;
      case CSI_IGNORE:
        if (executable(c)) return;
        if (c >= 0x40 && c <= 0x7e) return toGround();
        return keep(c, multi);
      case SOS_PM_APC:
        if (wide) return toGround();
        return keep(c, multi);
      case OSC:
        if (c === 0x07) return toGround();
        if (executable(c)) return;
        return keep(c, multi);
      case DCS_ENTRY:
      case DCS_PARAM:
      case DCS_INTER:
        if (executable(c) || c === 0x7f) return;
        if (wide) return toGround();
        keep(c, multi);
        if (c >= 0x40) { state = DCS_PASS; return; }
        if (c <= 0x2f) { state = DCS_INTER; return; }
        if (state === DCS_INTER) { state = DCS_IGNORE; return; }
        state = c <= 0x3b || state === DCS_ENTRY ? DCS_PARAM : DCS_IGNORE;
        return;
      case DCS_IGNORE:
      case DCS_PASS:
        return keep(c, multi);
      default:
    }
  };

  // UTF-8 as xterm.js decodes it: a character broken off by a byte that
  // cannot continue it is dropped and that byte read afresh; a byte no
  // character begins with, and a character that decodes to an overlong form,
  // a surrogate, past U+10FFFF or to U+FEFF (a byte order mark), reaches no
  // parser state at all.
  const decode = () => {
    const n = u8len;
    let cp = u8[0] & (n === 2 ? 0x1f : n === 3 ? 0x0f : 0x07);
    for (let i = 1; i < n; i++) cp = (cp << 6) | (u8[i] & 0x3f);
    const min = n === 2 ? 0x80 : n === 3 ? 0x800 : 0x10000;
    if (cp < min || (cp >= 0xd800 && cp <= 0xdfff) || cp > 0x10ffff || cp === 0xfeff) return -1;
    return cp;
  };
  const byte = (b) => {
    if (need) {
      if ((b & 0xc0) === 0x80) {
        u8[u8len++] = b;
        if (--need === 0) {
          const cp = decode();
          if (cp >= 0) step(cp, true);
          u8len = 0;
        }
        return;
      }
      u8len = 0;
      need = 0;
    }
    if (b < 0x80) {
      // Text at rest changes nothing kept here.
      if (state === GROUND && placed && b !== 0x1b && b !== 0x18 && b !== 0x1a) return;
      step(b, false);
      return;
    }
    const len = b >= 0xc2 && b <= 0xdf ? 2 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xf0 && b <= 0xf4 ? 4 : 0;
    if (!len) return;
    u8[0] = b;
    u8len = 1;
    need = len - 1;
  };

  return {
    /** Read the next bytes the pane wrote (a Buffer). */
    feed(bytes) {
      const n = bytes.length;
      // At rest, only an ESC, or a C1 control (U+0080-U+009F, whose UTF-8
      // begins with C2), can leave the ground: CAN and SUB keep it there, and
      // text changes nothing. So a run without either is skipped whole, save
      // its last three bytes: whether it ends inside a character depends on
      // those alone, UTF-8 finding its footing again within three. The
      // positions of the next of each are kept, so no byte is searched twice.
      let esc = -2;
      let c1 = -2;
      for (let i = 0; i < n; i++) {
        if (need === 0 && state === GROUND && placed) {
          if (esc !== -1 && esc < i) esc = bytes.indexOf(0x1b, i);
          if (c1 !== -1 && c1 < i) c1 = bytes.indexOf(0xc2, i);
          const j = esc === -1 ? (c1 === -1 ? n : c1) : (c1 === -1 ? esc : Math.min(esc, c1));
          if (j === n) {
            for (let k = Math.max(i, n - 3); k < n; k++) byte(bytes[k]);
            return;
          }
          i = j;
          // Most CSIs come whole in one write, with nothing in them the
          // states would act on before the final: such a one is read here at
          // once, and only a cut or odd one goes through the states.
          if (bytes[i] === 0x1b && bytes[i + 1] === 0x5b) {
            let k = i + 2;
            while (k < n && bytes[k] <= 0x3f && bytes[k] >= 0x20) k++;
            if (k < n && bytes[k] >= 0x40 && bytes[k] <= 0x7e) {
              if (touches(bytes[k])) csi(bytes.toString("latin1", i + 2, k), bytes[k]);
              i = k;
              continue;
            }
          }
        }
        byte(bytes[i]);
      }
    },

    /** What a seed taken now writes after its own bytes, so that an emulator
     *  it reset reads what follows as tmux's parser does. */
    tail() {
      const parts = pen.map(e => Buffer.from(e.seq, "latin1"));
      if (placed && !overflow) {
        if (pending.length) parts.push(Buffer.from(pending));
        if (need) {
          const begun = Buffer.from(u8.slice(0, u8len));
          if (unfinishedTail(begun) === u8len) parts.push(begun);
        }
      }
      return Buffer.concat(parts);
    },

    /** tmux skipped bytes (a %pause): presume the pen default, and hand on no
     *  unfinished sequence until the stream says where the parser is. */
    lose() {
      placed = false;
      toGround();
      u8len = 0;
      need = 0;
      setPen([]);
      saved = { normal: null, alt: null };
    },

    /** The pane has been quiet: take its parser as at rest. */
    presume() {
      placed = true;
      toGround();
      u8len = 0;
      need = 0;
    },
  };
}
