// Claude FM's pictures: the character's grid, the props it picks up, and the
// hat it wears when there is nothing to listen to — each drawn as text, and the
// one function that turns a grid into the runs of rectangles the SVGs draw.
//
// Lifted out of claude-fm.ts unchanged. What the character DOES stays there;
// this is only what it looks like, which components/FmSprite.tsx and the props
// in components/ClaudeFm.tsx draw.
import type { Prop } from "./claude-fm";

/**
 * The character.
 *
 * An original creature, drawn as a grid here rather than shipped as an image: a
 * PNG would be a binary asset in a repo that has none, would need a second one
 * for the light theme, and would be a fixed size on a canvas that zooms.
 * Eighteen columns of text cost nothing, recolour with the palette and stay
 * crisp at any scale — and if this ever becomes the mark on the tin, the mark
 * is eighteen lines of text that anyone can edit.
 *
 * The proportions are the second pass. The first put the headphones a column
 * clear of the head, which at 44px read as three separate objects floating
 * near each other rather than as one character wearing something. The cups
 * touch the head now, the band arcs down to meet them over three rows instead
 * of two, and the whole thing is drawn on 18 columns rather than 16 so the legs
 * have somewhere to be.
 *
 * The legs are the fifth pass and are three rows rather than two. At two they
 * were as tall as they were wide — square stubs under a body nine rows deep,
 * which reads as a thing balanced on blocks rather than a thing standing on
 * legs. Three rows is the shortest that looks like a leg, and it is what gives
 * the stride something to swing.
 *
 * The arms are the fourth pass, and they cost two rows rather than two
 * columns: the ear cups run down both sides of the head, so there is nowhere
 * for an arm to come out until below them. The cups end a row earlier than they
 * did and the two rows under them are wide — which also gives the silhouette a
 * waist it did not have, since the body narrows again below the arms.
 *
 * The detail is the third pass, and all of it is one column wide. A flat fill
 * reads as a shape rather than as a body, so the right-hand column of every
 * body row is a shade — one light source, from the left, consistently — and
 * each cup has a lighter pad inside it so it reads as something worn rather
 * than as a grey block. Two cells of extra vocabulary; the silhouette is
 * unchanged.
 *
 *   `.` nothing   `b` body   `s` body in shadow   `e` eye
 *   `c` headphone cup   `p` ear pad   `a` headband
 */
export const SPRITE: readonly string[] = [
  "......aaaaaa......",
  "....aa......aa....",
  "...a..bbbbbs..a...",
  "...cpcbbbbbscpc...",
  "...cpcbebbescpc...",
  "...cpcbbbbbscpc...",
  "...cpcbbbbbscpc...",
  "....ccbbbbbscc....",
  "....bbbbbbbbbs....",
  "....bbbbbbbbbs....",
  "......bbbbbs......",
  "......bb..bs......",
  "......bb..bs......",
  "......bb..bs......",
];

export const SPRITE_W = 18;
export const SPRITE_H = SPRITE.length;

/** Which grid cells are holes rather than body. */
export const EYE_CELLS: ReadonlySet<string> = new Set(["e"]);
/** Which belong to the headphones, which follow the body rather than moving
 *  with it. The pad travels with the cup it is inside. */
export const GEAR_CELLS: ReadonlySet<string> = new Set(["a", "c", "p"]);

export interface SpriteRect { x: number; y: number; w: number; cell: string }

/**
 * The grid as rectangles, one per horizontal run.
 *
 * A rect per filled square would be over a hundred elements for this sprite and
 * every one of them a node the browser lays out; merging runs brings it to
 * about a third of that with identical pixels. The merge stops at a change of
 * cell, so a run never spans two colours.
 */
export function spriteRects(grid: readonly string[] = SPRITE): SpriteRect[] {
  const out: SpriteRect[] = [];
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x];
      if (cell === ".") { x += 1; continue; }
      let w = 1;
      while (x + w < row.length && row[x + w] === cell) w += 1;
      out.push({ x, y, w, cell });
      x += w;
    }
  });
  return out;
}

/**
 * The props. Deliberately not recognisable objects — a character tidying away
 * an identifiable thing invites the question of what it was, and the answer is
 * nothing. One is crumpled, one is round.
 */
export const LITTER: readonly string[] = [
  ".xx.",
  "xxxx",
  ".xx.",
];
export const BALL: readonly string[] = [
  "..xx..",
  ".xsxx.",
  "xssxxx",
  "xxxxsx",
  ".xxxx.",
  "..xx..",
];

/** An upward-pointing telescope on a tripod. Two screen pixels per cell;
 * the eyepiece on rows 8–10 meets the character's eyes, feet on row 23. */
export const SCOPE: readonly string[] = [
  "...xx...............",
  "..xaax..............",
  ".xaallx.............",
  "xaallllx............",
  ".xllllllx...........",
  "..xllllllx..........",
  "...xllllllx.........",
  "....xllllllxx.......",
  ".....xllllxsxx..xx..",
  "......xllxsssx.xllxx",
  ".......xxssssxxxllxx",
  "........xssssssxx...",
  ".........xssssx.....",
  "..........xxxx......",
  "..........xax.......",
  ".........xxxxx......",
  "........xx.x.xx.....",
  "........xl.x.lx.....",
  ".......xl..x..lx....",
  ".......xl..x..lx....",
  "......xl...x...lx...",
  "......xl...x...lx...",
  ".....xl....x....lx..",
  "....xxx...xxx...xxx.",
];

export const PROP_ART: Record<Prop["kind"], readonly string[]> =
  { litter: LITTER, ball: BALL, scope: SCOPE };

/**
 * What it wears when there is nothing to listen to.
 *
 * A hat rather than nothing at all, because the headphones leaving used to
 * leave a bare head — and a bare head is not a state, it is the absence of one.
 * Swapping one for the other makes the change legible from across a room
 * without a word or a colour, and it reads as the character putting something
 * on rather than something being taken away.
 *
 * Its own small grid rather than more rows in the sprite: it sits ON the head
 * rather than beside it, so weaving it into the eighteen columns would mean a
 * letter for every square the brim overlaps and a body that has to know about
 * a hat.
 *
 * THE CROWN IS THE WIDTH OF THE HEAD, and the band is the same. It was four
 * cells against a six-cell band, which left the band sticking out either side
 * like a second little brim — and with the band drawn in the body's own colour,
 * what that read as was the blue head showing THROUGH the hat. A crown that
 * sits flush on its band is one solid shape.
 *
 * THE BRIM IS TWICE THE WIDTH OF THE HEAD, and that ratio is the whole of what
 * says which kind of hat it is. The first build made it one cell wider either
 * side — the least that reads as a hat at all — and what it read as was a cap.
 * A wide brim over a narrow crown is the silhouette, so the crown stayed six
 * pixels across and the brim went to thirty-six.
 *
 * The crown is taller than the sprite has room for, so the hat starts a row
 * ABOVE the grid. Nothing needs to move for that: the sheet already lets this
 * character draw outside its own box, because the dances lift it past the top.
 *
 *   `h` the hat   `k` its band
 */
export const HAT: readonly string[] = [
  "...hhhhhh...",
  "...hhhhhh...",
  "...kkkkkk...",
  "hhhhhhhhhhhh",
];

/** Where it sits on the sprite: centred on the head's columns, with the brim on
 *  the head's own top row so it covers the forehead rather than floating over
 *  it. Checked against the head in the test rather than eyeballed. */
export const HAT_X = 3;
export const HAT_Y = -1;

/** Where the legs begin, and the column that divides them.
 *
 *  They are their own parts rather than more body, so they can take a step —
 *  and they can be separated by position alone, without a letter of their own
 *  in the grid, because they are the only thing below this row and there is
 *  nothing between them. The sprite stays eighteen lines of text.
 */
export const LEG_TOP_ROW = 11;
export const LEG_SPLIT_COL = 9;
