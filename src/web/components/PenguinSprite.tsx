import { memo } from "react";
import type { Act, Facing } from "../claude-fm";
import { GEAR_CELLS, SPRITE, spriteRects } from "../claude-fm-sprite";
import { PENGUIN } from "../penguin-sprite";

const FILLS: Record<string, string> = {
  d: "#3b4855", h: "#657b8b", w: "#f4f0df", e: "#19242b", b: "#f0b44b",
};
const GEAR_CLASSES: Record<string, string | undefined> = { p: "fm-pad" };
const RECTS = spriteRects(PENGUIN);
const GEAR = spriteRects(SPRITE).filter(r => GEAR_CELLS.has(r.cell));
const EYES = RECTS.filter(r => r.cell === "e");
const BODY = RECTS.filter(r => r.y < 12 && r.cell !== "e")
  .map(r => r.y === 8 || r.y === 9
    ? { ...r, x: Math.max(6, r.x), w: Math.max(0, Math.min(12, r.x + r.w) - Math.max(6, r.x)) }
    : r).filter(r => r.w > 0);
const FEET = {
  left: RECTS.filter(r => r.y >= 12 && r.x < 9),
  right: RECTS.filter(r => r.y >= 12 && r.x >= 9),
};

export default memo(function PenguinSprite({ act, facing }: { act: Act | null; facing: Facing }) {
  const grips = act === "climb" || act === "rope-throw" || act === "rope-catch" || act === "pull-up";
  const crouch = act === "land" || act === "dismount";
  const seated = act === "sit" || act === "cast" || act === "fish" || act === "reel" || act === "stow";
  return <svg data-character="penguin" viewBox="0 0 18 14" shapeRendering="crispEdges" aria-hidden focusable="false">
    <g className="fm-gear"><g className="fm-gear-motion">
      {GEAR.map(r => <rect key={`g${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1}
        className={GEAR_CLASSES[r.cell]} />)}
    </g></g>
    <g className="fm-body">
      {BODY.map(r => <rect key={`b${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS[r.cell]} />)}
      {EYES.map(r => <rect key={`bed${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS.w} />)}
      <g className="fm-arms" fill={FILLS.d}>
        <path d="M4 8H6V10H5V11H4Z" /><path d="M12 8H14V11H13V10H12Z" />
      </g>
      {EYES.map(r => <rect key={`e${r.x}`} x={r.x + (facing === "right" ? 1 : 0)} y={r.y}
        width={r.w} height={1} className="fm-eye" style={{ fill: FILLS.e }} />)}
    </g>
    {grips && <g className="fm-grip" style={{ fill: FILLS.h }}>
      <path className="fm-grip-left" d="M5 10H4V4H5V2H6V1H7V0H9V2H7V3H6V10Z" />
      <path className="fm-grip-right" d="M12 10H14V6H13V3H11V2H9V4H12Z" />
    </g>}
    {crouch && <g className="fm-crouch-legs" style={{ fill: FILLS.b }}>
      <path d="M5 12H8V13H5Z" /><path d="M10 12H13V13H10Z" />
    </g>}
    {seated && <g className="fm-seated-legs" style={{ fill: FILLS.b }}>
      <path className="fm-seated-far" style={{ fill: "#c88736" }} d="M10 11H12V12H13V14H10V13H11V12H10Z" />
      <path d="M6 11H8V12H7V13H8V14H4V13H5V12H6Z" />
    </g>}
    {(["left", "right"] as const).map(side => <g key={side} className="fm-leg" data-side={side}>
      {FEET[side].map(r => <rect key={`${r.y}-${r.x}`} x={r.x} y={r.y} width={r.w} height={1} fill={FILLS.b} />)}
    </g>)}
  </svg>;
});
