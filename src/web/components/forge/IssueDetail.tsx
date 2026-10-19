// Stub — replaced by the detail work (#2179).
import type { ForgeSelection } from "./ForgeContext";
export default function IssueDetail({ selection }: { selection: Extract<ForgeSelection, { type: "issue" }> }) {
  return <p className="fg-note">{selection.repo}#{selection.number}</p>;
}
