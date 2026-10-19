// Stub — replaced by the detail work (#2179).
import type { ForgeSelection } from "./ForgeContext";
export default function PipelineDetail({ selection }: { selection: Extract<ForgeSelection, { type: "pipeline" }> }) {
  return <p className="fg-note">{selection.repo} pipeline {selection.id}</p>;
}
