// Claude FM's character, drawn: the headphones, the body with its arms and
// eyes, the hat, and the legs, each a group of its own so the sheet can move it,
// plus the grips and the crouched and seated legs a few errands draw.
//
// Lifted out of components/ClaudeFm.tsx unchanged, with the pixel geometry only
// it reads. The geometry is worked out once, at module scope, rather than on
// every render; and the drawing is memoised on the two things it reads — what
// the character is doing and which way it faces — so a step along the ledge
// re-renders the walker around it and not these rects.
import { memo } from "react";
import {
  GEAR_CELLS, HAT, HAT_X, HAT_Y, LEG_SPLIT_COL, LEG_TOP_ROW, spriteRects, SPRITE_H, SPRITE_W,
  type Act, type Facing,
} from "../claude-fm";

/** What each grid cell is drawn as. A map here rather than a chain of
 *  comparisons in the markup below, because unstyled-class.test.ts reads every
 *  string a `className` expression holds and would count a bare `"e"` as a
 *  class this deck hard-codes and never styles — which is exactly the typo that
 *  test exists to catch. The names are quoted in a .tsx, which is also what
 *  dead-css.test.ts looks for before calling a rule unused. A cell with no
 *  entry takes its group's own fill. */
const CELL_CLASS: Record<string, string | undefined> = {
  e: "fm-eye",
  s: "fm-shade",
  p: "fm-pad",
};

const BODY_RECTS = spriteRects().filter(r => !GEAR_CELLS.has(r.cell));
const GEAR_RECTS = spriteRects().filter(r => GEAR_CELLS.has(r.cell));
const EYE_RECTS = BODY_RECTS.filter(r => r.cell === "e");
const HAT_RECTS = spriteRects(HAT);
const TORSO_RECTS = BODY_RECTS.filter(r => r.y < LEG_TOP_ROW && r.cell !== "e")
  .map(r => {
    if (r.y !== 8 && r.y !== 9) return r;
    const x = Math.max(6, r.x);
    return { ...r, x, w: Math.max(0, Math.min(12, r.x + r.w) - x) };
  }).filter(r => r.w > 0);
const LEG_RECTS = {
  left: BODY_RECTS.filter(r => r.y >= LEG_TOP_ROW && r.x < LEG_SPLIT_COL),
  right: BODY_RECTS.filter(r => r.y >= LEG_TOP_ROW && r.x >= LEG_SPLIT_COL),
};

export default memo(function FmSprite({ act, facing }: { act: Act | null; facing: Facing }) {
  return (
    <svg viewBox={`0 0 ${SPRITE_W} ${SPRITE_H}`} shapeRendering="crispEdges" aria-hidden>
      {/* Two groups so the body can bob while the cups hold still — a
          character whose headphones swim around its head reads as a
          glitch rather than as dancing. */}
      {/* TWO NESTED GROUPS, AND THE NESTING IS THE WHOLE TRICK. The outer
          one owns where the headphones are WORN — on the head while
          something is playing, down around the neck when nothing is — and
          the inner one owns how they move while worn. One element cannot
          hold both: a transition and an animation on the same transform
          do not compose, the animation simply wins, and the headphones
          would snap between the two positions instead of travelling.

          DRAWN BEFORE THE BODY ON PURPOSE. SVG paints in document order,
          so the body covers this — and that is what makes the neck
          position free: the band slides down behind the head and is
          simply gone, with the cups tucked behind the arms. Nothing has
          to be hidden, because nothing was ever in front. */}
      <g className="fm-gear">
        <g className="fm-gear-motion">
          {GEAR_RECTS.map(r => (
            <rect
              key={`g${r.y}-${r.x}`}
              x={r.x} y={r.y} width={r.w} height={1}
              className={CELL_CLASS[r.cell]}
            />
          ))}
        </g>
      </g>
      {/* THE LEGS ARE THEIR OWN PARTS, so they can take a step. A body
          that rises and falls without its legs alternating is a hop, not
          a walk — which is why the walk never looked like walking.

          They are separated by position rather than by a letter of their
          own in the grid: they are the only thing below LEG_TOP_ROW and
          there is nothing between them, so a row and a column is all it
          takes. The sprite stays eighteen lines of text. */}
      <g className="fm-body">
        {/* Fill the original eye cells before pupils move or blink.
            Otherwise their old positions become holes showing the canvas. */}
        {EYE_RECTS.map(r => (
          <rect key={`eye-bed-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill="var(--accent)" />
        ))}
        {TORSO_RECTS.map(r => (
          <rect
            key={`b${r.y}-${r.x}`}
            x={r.x} y={r.y} width={r.w} height={1}
            className={CELL_CLASS[r.cell]}
          />
        ))}
        {/* Arms are separate from the torso so a greeting never moves
            the head, feet, or the walking animation. Kept inside the
            body group so they still follow its dance. */}
        <g className="fm-arms">
          <rect x={4} y={8} width={2} height={2} />
          <rect x={12} y={8} width={1} height={2} />
          <rect x={13} y={8} width={1} height={2} className="fm-shade" />
        </g>
        {/* Pupils paint last: looking right must not slide them beneath
            the next body/shadow rectangle in SVG paint order. */}
        {EYE_RECTS.map(r => (
          <rect key={`eye-${r.x}`}
            x={r.x - (r.x >= SPRITE_W / 2 ? 1 : 0) + (facing === "right" ? 1 : 0)}
            y={r.y} width={r.w} height={1} className="fm-eye" />
        ))}
      </g>
      {/* DRAWN AFTER THE BODY, which is the whole reason it is its own group.
          The headphones are drawn BEFORE it so they can slide down and
          hide behind the head; a hat has to do the opposite — the brim
          sits over the forehead, so it has to be painted on top of it. */}
      <g className="fm-hat">
        {HAT_RECTS.map(r => (
          <rect
            key={`h${r.y}-${r.x}`}
            x={HAT_X + r.x} y={HAT_Y + r.y} width={r.w} height={1}
            className={r.cell === "k" ? "fm-hatband" : undefined}
          />
        ))}
      </g>
      {(act === "climb" || act === "rope-throw" || act === "rope-catch" || act === "pull-up") && (
        <g className="fm-grip">
          <path className="fm-grip-left" d="M5 9H4V4H7V3H9V5H6V9Z" />
          <path className="fm-grip-right" d="M12 9H14V6H11V5H9V7H12Z" />
        </g>
      )}
      {(act === "land" || act === "dismount") && (
        <g className="fm-crouch-legs">
          <path d="M6 11H8V13H6Z" />
          <path d="M10 11H12V13H10Z" />
        </g>
      )}
      {(["sit", "cast", "fish", "reel", "stow"] as (Act | null)[]).includes(act) && (
        <g className="fm-seated-legs">
          <path className="fm-seated-far" d="M10 10H12V11H11V14H8V13H9V11H10Z" />
          <path d="M6 10H9V11H7V15H4V14H5V11H6Z" />
        </g>
      )}
      {(["left", "right"] as const).map(side => (
        <g key={side} className="fm-leg" data-side={side}>
          {LEG_RECTS[side].map(r => (
              <rect
                key={`${side}${r.y}-${r.x}`}
                x={r.x} y={r.y} width={r.w} height={1}
                className={CELL_CLASS[r.cell]}
              />
            ))}
        </g>
      ))}
    </svg>
  );
});
