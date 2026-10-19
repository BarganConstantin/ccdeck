// Stub — replaced by the detail work (#2179).
import type { ForgeSelection } from "./ForgeContext";
export default function BranchDetail({ selection }: { selection: Extract<ForgeSelection, { type: "branch" }> }) {
  return <p className="fg-note">{selection.repo} {selection.name}</p>;
}
