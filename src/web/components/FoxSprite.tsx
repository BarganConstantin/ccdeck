import { memo } from "react";
import type { Act, Facing } from "../claude-fm";
import { FOX, FOX_GEAR } from "../fox-sprite";
import { spriteRects, type SpriteRect } from "../claude-fm-sprite";

const FILLS: Record<string, string> = {
  f: "#d88735", s: "#a55b24", o: "#63351e", w: "#ffe2aa", n: "#372821",
};
const GEAR_CLASSES: Record<string, string | undefined> = { p: "fm-pad" };
const RECTS = spriteRects(FOX);
const GEAR = spriteRects(FOX_GEAR);
// A run can cross a part boundary. Clip it rather than assigning the whole
// run by its starting column, which made the tail base walk with the feet.
function clip(rects: SpriteRect[], left: number, right: number): SpriteRect[] {
  return rects.map(r => ({ ...r, x: Math.max(left, r.x),
    w: Math.max(0, Math.min(right, r.x + r.w) - Math.max(left, r.x)) }))
    .filter(r => r.w > 0);
}
const TAIL = clip(RECTS.filter(r => r.y >= 8), 12, 18);
const BODY = RECTS.filter(r => r.y < 11 && r.cell !== "e")
  .map(r => r.y === 8 || r.y === 9
    ? { ...r, x: Math.max(6, r.x), w: Math.max(0, Math.min(12, r.x + r.w) - Math.max(6, r.x)) }
    : r.y === 10 ? { ...r, w: Math.max(0, Math.min(12, r.x + r.w) - r.x) }
    : r).filter(r => r.w > 0);
const EYES = RECTS.filter(r => r.cell === "e");
const LEGS = {
  left: clip(RECTS.filter(r => r.y >= 11), 0, 9),
  right: clip(RECTS.filter(r => r.y >= 11), 9, 12),
};

export default memo(function FoxSprite({ act, facing }: { act: Act | null; facing: Facing }) {
  const grips = act === "climb" || act === "rope-throw" || act === "rope-catch" || act === "pull-up";
  const crouch = act === "land" || act === "dismount";
  const seated = act === "sit" || act === "cast" || act === "fish" || act === "reel" || act === "stow";
  return <svg data-character="fox" viewBox="0 0 18 14" shapeRendering="crispEdges" aria-hidden focusable="false">
    <g className="fm-body" data-part="tail">
      {TAIL.map(r => <rect key={`t${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS[r.cell]} />)}
    </g>
    <g className="fm-gear"><g className="fm-gear-motion">
      {GEAR.map(r => <rect key={`g${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1}
        className={GEAR_CLASSES[r.cell]} />)}
    </g></g>
    <g className="fm-body">
      {BODY.map(r => <rect key={`b${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS[r.cell]} />)}
      {EYES.map(r => <rect key={`bed${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS.f} />)}
      <g className="fm-arms" fill={FILLS.f}>
        <rect x={4} y={8} width={2} height={2} /><rect x={12} y={8} width={1} height={2} />
      </g>
      {EYES.map(r => <rect key={`e${r.x}`} x={r.x + (facing === "right" ? 1 : 0) - (r.x >= 9 ? 1 : 0)}
        y={r.y} width={r.w} height={1} className="fm-eye" style={{ fill: FILLS.n }} />)}
    </g>
    {grips && <g className="fm-grip" style={{ fill: FILLS.f }}>
      <path className="fm-grip-left" d="M5 9H4V4H7V3H9V5H6V9Z" />
      <path className="fm-grip-right" d="M12 9H14V6H11V5H9V7H12Z" />
    </g>}
    {crouch && <g className="fm-crouch-legs" style={{ fill: FILLS.f }}>
      <path d="M6 11H8V13H6Z" /><path d="M10 11H12V13H10Z" />
    </g>}
    {seated && <g className="fm-seated-legs" style={{ fill: FILLS.f }}>
      <path className="fm-seated-far" style={{ fill: FILLS.s }} d="M10 10H12V11H11V14H8V13H9V11H10Z" />
      <path d="M6 10H9V11H7V15H4V14H5V11H6Z" />
    </g>}
    {(["left", "right"] as const).map(side => <g key={side} className="fm-leg" data-side={side}>
      {LEGS[side].map(r => <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS[r.cell]} />)}
    </g>)}
  </svg>;
});
