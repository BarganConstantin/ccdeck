// The tie between a recap note and the card it speaks for.
//
// A thread with beads on it: a hairline in the session's colour, dots strung
// along it, and a bead at each end where it is fastened — to the note on one
// side and to the card on the other. Curved, because the note is seldom level
// with the card (it is taller, and it can be dragged anywhere), and a straight
// line between two points at different heights reads as a mistake where a curve
// reads as a thread. Static: it is drawn for a session at rest.
import React from "react";
import { getBezierPath, type EdgeProps } from "reactflow";

export default function RecapTieEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style }: EdgeProps) {
  const [path] = getBezierPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, curvature: 0.35 });
  return (
    <g className="recap-tie" style={style as React.CSSProperties}>
      <path className="recap-tie-thread" d={path} />
      <path className="recap-tie-beads" d={path} />
      <circle className="recap-tie-end" cx={sourceX} cy={sourceY} r={3.5} />
      <circle className="recap-tie-end" cx={targetX} cy={targetY} r={3.5} />
    </g>
  );
}
