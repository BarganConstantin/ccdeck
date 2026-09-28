import React from "react";
import { useStore, useViewport, type ReactFlowState } from "reactflow";
import { sessionHue } from "../reducer";
import { SEP } from "../cluster-header";
import { clusterBounds, labelMaxWidth, LABEL_LIFT, shallowEqualClusters, type Cluster } from "../cluster-bounds";
import { AlertMark } from "./StateMark";

function selectClusters(s: ReactFlowState): Cluster[] {
  return clusterBounds(s.nodeInternals.values());
}

/**
 * A click on a cluster's name asks the deck to bring that session into view,
 * and the deck does the moving (#785).
 *
 * This component used to call `fitView` itself and then stamp the deck's
 * `lastFitTimeRef` through an `onFit` prop — every camera move the deck makes
 * has to say so, because `isUserViewportGesture` cannot tell an eventless fit
 * from a drag, and an unstamped one turned auto-fit off for good. The stamp is
 * App's own now, with the move: `onFocusSession` is App's focusAgent, the one
 * routine every "go to this card" shares (focus-camera.ts), which frames the
 * session clear of the floating panels at a readable zoom and stamps after it.
 */
export default function SessionClusters({ onFocusSession }: { onFocusSession?: (sessionId: string) => void }) {
  const { x, y, zoom } = useViewport();
  const clusters = useStore(selectClusters, shallowEqualClusters);

  if (clusters.length <= 1) return null; // no need to disambiguate one tree

  // A session's root card has the session's own id, so framing "the session"
  // is framing its root with everything it belongs with.
  const focusSession = (sessionId: string) => {
    try { onFocusSession?.(sessionId); } catch {}
  };

  // The camera, applied once to the layer, instead of folded into every number
  // underneath it. This is the same transform React Flow writes to
  // .react-flow__viewport to carry the real nodes, built from the same three
  // viewport values, so the decorative layer and the nodes it decorates move as
  // one thing rather than as two things that agree most of the time.
  //
  // Before #353 every box below composed the camera into its own left, top,
  // width and height — and .cluster-card eases all four over 320ms, so a pan
  // rewrote four eased layout properties sixty times a second and the box
  // trailed its own nodes by up to 94px on a pan and 1014px of width on a zoom.
  // Moving the camera up here is what makes those four honest: see the note on
  // boxStyle.
  //
  // transformOrigin lives in the sheet with the rest of the layer's geometry.
  const cameraStyle: React.CSSProperties = {
    transform: `translate(${x}px, ${y}px) scale(${zoom})`,
  };

  return (
    <div className="session-clusters" style={cameraStyle}>
      {clusters.map(c => {
        const hue = sessionHue(c.sessionId);
        // Only the hue. The four colours these two elements used to carry —
        // label, rim, card border, card wash — were composed here at a
        // lightness tuned for the dark canvas, which made them the one part of
        // the palette that could not answer to data-theme; the label measured
        // 1.21:1 on white across the hue circle. The hue is the half this
        // component actually knows (it is a hash of the session id); the half
        // that depends on the theme belongs to the sheet, and is there now.
        //
        // Layout coordinates, straight out of clusterBounds, with no camera in
        // them. clusterBounds already works in the same space React Flow keeps
        // node positions in, so these four change when — and only when — the
        // layout changes, which is the single event .cluster-card's 320ms
        // easing was written for.
        //
        // They read `c.x * zoom + x`, `c.y * zoom + y`, `c.w * zoom` and
        // `c.h * zoom` before #353. Folding the camera in is what made that
        // easing fire on every pan and zoom frame as well, and once it was
        // folded in no rule in the sheet could tell a camera move from a layout
        // move ever again, because by then they were the same number.
        // The position is a translate since #864: the box still eases over the
        // 320ms the nodes do when the layout moves, but on the compositor
        // rather than through left and top. The size stays width and height,
        // which change only when a session gains or loses a node.
        const boxStyle: React.CSSProperties = {
          position: "absolute",
          left: 0,
          top: 0,
          transform: `translate(${c.x}px, ${c.y}px)`,
          width: c.w,
          height: c.h,
          "--session-hue": hue,
        } as React.CSSProperties;
        // The label is the one child that must not scale with the camera: it is
        // text, and a session name drawn at 0.2× is a smudge. It sits in layout
        // space like the box, so the layer's own scale(zoom) is divided back out.
        //
        // AND IT STAYS ITS OWN SIZE ALL THE WAY OUT (#846). It used to shrink
        // with a zoom-out — `scale(min(1, zoom))` on screen — so at the 0.32 a
        // real board settles into, a 10px label drew at about 3px and the one
        // line that says which session a cluster is could not be read. It is
        // 1× on screen at every zoom now. The lift is divided out the same
        // way, so the tab keeps the geometry it has at 1× — 12px above the
        // box's top edge, over the handle's top strip — instead of sliding down
        // over the cards as the box shrinks under it.
        //
        // `|| 1` guards a zoom of zero, which would make this Infinity and put
        // the label nowhere. React Flow clamps to minZoom (0.2 on this canvas)
        // and never hands one out, so this is a fallback rather than a case.
        //
        // AND IT IS BOUND TO THE GUTTER IT WAS MEASURED AGAINST (#977). The cap
        // on NAME_COLUMNS in cluster-header.ts is argued entirely in LAYOUT
        // units — "a capped header stays inside the 240px gutter layout.ts
        // leaves between two session columns" — and the line above is what
        // stopped that from being true: at 1× a header spans the same number
        // of layout units as screen px, but at zoom z it spans `screen / z` of
        // them, and the cap does not shrink with the board.
        //
        // Measured in Firefox against this sheet, a workspace + capped ai-title
        // pill draws 302.7px at every zoom. In layout units that is 302.7 at
        // 1×, 796.7 at 0.38 and 946 at the 0.32 a real board settles into —
        // against a cluster box of 276 and 624 units of clear canvas to the
        // next column's box. So at 0.32 it reached 686 units past its own box,
        // 62 units INTO the box next door, and `document.elementFromPoint` on
        // the neighbour returned this button: the label is `pointer-events:
        // auto` in a layer that clips nothing, so a click there called
        // focusSession for the wrong session and a drag there was captured by
        // the label instead of panning. The z-index: 0 that keeps the paint
        // harmless does nothing for the hit box.
        //
        // The bound is the same 240 the cap was justified by, in screen px so
        // it tracks the camera: its own box plus one card width of the gutter,
        // which at every zoom leaves the remaining 384 units of canvas — and
        // all of the next column — to whoever owns them. It costs text only
        // below about 0.58, where the pill would otherwise be reaching across
        // the gap anyway, and `title` still carries the whole header.
        const labelStyle: React.CSSProperties = {
          position: "absolute",
          left: c.x + 16,
          top: c.y - LABEL_LIFT / (zoom || 1),
          transform: `scale(${1 / (zoom || 1)})`,
          transformOrigin: "left top",
          maxWidth: labelMaxWidth(c.w, zoom),
          "--session-hue": hue,
        } as React.CSSProperties;
        // Three fields, one pill, and only the middle one in a span of its own.
        // The separators stay the same glyph on purpose: what differs between
        // these fields is their KIND, not their rank, and the sheet says so by
        // leaving the name in its own case while the workspace and the id are
        // drawn uppercase. Two glyphs would have added a second rhythm without
        // saying which of its neighbours it binds to.
        //
        // The pill is content-width and transitions neither width nor left, so
        // a rename repaints one edge with no easing anywhere. The four eased
        // properties on .cluster-card are the node bounds above and no name
        // reaches them.
        //
        // The tooltip carries the whole thing untruncated, on the line above
        // the sentence rather than after another separator: with three fields
        // now joined by the same glyph, a fourth would have read as a fourth
        // field. The label is not a drag surface — the gesture belongs to the
        // sessionGroup node behind the cards, and this button sits above the
        // handle by LABEL_LIFT precisely so a click reaches it — so a title
        // here has no drag to fight.
        return (
          <React.Fragment key={c.sessionId}>
            <div className="cluster-card" style={boxStyle} aria-hidden />
            <button
              type="button"
              className="cluster-label"
              data-alarm={c.alarm ? "" : undefined}
              style={labelStyle}
              title={`${c.alarm ? "Waiting on you\n" : ""}Zoom to ${c.fullLabel}\ndrag the wrapper to move the whole session`}
              onClick={() => focusSession(c.sessionId)}
            >
              {/* Stopped until a human answers, said first and in words for a
                  screen reader, and as the triangle the faces use for the eye.
                  The pill is the only thing on a cluster that is 1× at every
                  zoom, so it is the one place a blocked session can always be
                  found from — the tile under it may be twenty pixels wide. */}
              {c.alarm ? <><AlertMark /><span className="cluster-label-said">waiting on you: </span></> : null}
              {/* THREE FIELDS, THREE RANKS. They were one run of identical
                  uppercase hue text, so the workspace, the session's own name
                  and the four-character address all asked for the eye equally
                  and the caption ended up louder than the node it labels. The
                  workspace keeps the hue and the capitals — it is the address,
                  and the only field the session colour needs to mark. The other
                  two step down to the annotation tier and to normal weight; the
                  separators go with them, so the run reads as one strong word
                  followed by its qualifiers rather than as three equals.

                  THE NAME IS THERE ONLY WHEN THE CARD CANNOT SAY IT. The root
                  card prints the same name on its own row, so at a zoom where
                  that row reads, the pill was the name a second time — and
                  since #846 the pill keeps its size while the cards shrink, the
                  second copy was the larger one, three times the width of the
                  card it labels. The sheet hides this span at the `detail`
                  distance, where the card's row is legible; at `compact` and
                  `overview` the card is a face that gives the title up first,
                  and the pill is the one place that always reads it. Its
                  separator lives inside the span so the two leave together.
                  The tooltip keeps all three fields. */}
              {c.label}
              {/* The branch, between the address and the description: it is
                  about what the session is doing now, and at a distance that
                  is the question the pill is being read for. The sheet shows it
                  at the overview distance only — nearer in, the subagents'
                  own cards and the root's face say it. */}
              {c.branch ? <span className="cluster-label-branch">{SEP + c.branch}</span> : null}
              {c.name ? <span className="cluster-label-name">{SEP + c.name}</span> : null}
              {c.shortId ? <span className="cluster-label-id">{SEP + c.shortId}</span> : null}
            </button>
          </React.Fragment>
        );
      })}
    </div>
  );
}
