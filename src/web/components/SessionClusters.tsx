import React, { useLayoutEffect, useRef, useState } from "react";
import { useStore, useViewport, type ReactFlowState } from "reactflow";
import { sessionHue } from "../reducer";
import { SEP } from "../cluster-header";
import { clusterBounds, clusterBoxStyle, clusterLabelStyle, shallowEqualClusters, type Cluster } from "../cluster-bounds";
import { labelRoom, paneChrome, sameBoxes, type PaneBox } from "../cluster-label-room";
import { AlertMark } from "./StateMark";

function selectClusters(s: ReactFlowState): Cluster[] {
  return clusterBounds(s.nodeInternals.values());
}
const selectPaneWidth = (s: ReactFlowState) => s.width;
const selectPaneHeight = (s: ReactFlowState) => s.height;

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
  // The pane's size, from the store React Flow measures it into, and the
  // chrome drawn over it, from the page: where each pill has room to be drawn
  // whole (cluster-label-room.ts). The chrome is read after every render and
  // before paint — this layer renders on every camera frame, and the filter
  // bar, the panels and the chip come and go with the renders above it — and
  // a measure that has not changed is the same state, so it costs no render.
  const width = useStore(selectPaneWidth);
  const height = useStore(selectPaneHeight);
  const pane = { width, height };
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [chrome, setChrome] = useState<PaneBox[]>([]);
  useLayoutEffect(() => {
    const host = layerRef.current?.parentElement;
    if (!host) return;
    const next = paneChrome(host);
    setChrome(prev => (sameBoxes(prev, next) ? prev : next));
  });

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
  // clusterBoxStyle in cluster-bounds.ts.
  //
  // transformOrigin lives in the sheet with the rest of the layer's geometry.
  const cameraStyle: React.CSSProperties = {
    transform: `translate(${x}px, ${y}px) scale(${zoom})`,
  };

  return (
    <div className="session-clusters" style={cameraStyle} ref={layerRef}>
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
        // Where the box and the pill go, and why neither carries the camera, is
        // cluster-bounds.ts's: see clusterBoxStyle and clusterLabelStyle.
        const boxStyle = clusterBoxStyle(c, hue);
        // Drawn whole inside the pane and clear of the chrome over it, or not
        // at all: under the top bar or the filter bar a pill was cut through
        // its words and still took focus behind them. Never moved to stay in
        // view, and never wider than its gutter — cluster-label-room.ts.
        const room = labelRoom(c, { x, y, zoom }, pane, chrome);
        const labelStyle = clusterLabelStyle(c, zoom, hue, room.maxWidth);
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
        // The tooltip carries the whole thing untruncated — everything the pill
        // says, in its order — on the line above the sentence rather than
        // after another separator: with the fields joined by one glyph, a
        // sentence after another would have read as one more field
        // (cluster-header.ts builds it). The label is not a drag surface —
        // the gesture belongs to the sessionGroup node behind the cards, and this button sits above the
        // handle by LABEL_LIFT precisely so a click reaches it — so a title
        // here has no drag to fight.
        return (
          <React.Fragment key={c.sessionId}>
            <div className="cluster-card" style={boxStyle} aria-hidden />
            <button
              type="button"
              className="cluster-label"
              data-alarm={c.alarm ? "" : undefined}
              data-offpane={room.hidden ? "" : undefined}
              style={labelStyle}
              title={c.title}
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
