import { useRef, type HTMLAttributes } from "react";
import { useSegmentThumb } from "../use-segment-thumb";

/** A group of segments (`.uh-range` or `.ap-sides` buttons) with V4's sliding
 *  thumb under the selected one. Pass the group's own role, label and class. */
export default function SegmentGroup(props: HTMLAttributes<HTMLDivElement>) {
  const ref = useRef<HTMLDivElement>(null);
  useSegmentThumb(ref);
  return <div ref={ref} {...props} />;
}
