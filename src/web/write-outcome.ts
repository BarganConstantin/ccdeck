// One vocabulary for how a write is going, whatever the provider.
export type WriteOutcome = "saving" | "saved" | "failed" | "uncertain";

type WriteLike = { busy?: boolean; uncertain?: boolean; error?: string; operation?: { state?: string } | null };

// A guard operation (even one from another tab) reads like the server's table.
// Idle (nothing written yet) is null: it is not "saved".
export function writeOutcomeOf(state: WriteLike): WriteOutcome | null {
  if (state.operation) {
    if (state.operation.state === "pending") return "saving";
    if (state.operation.state === "confirmed") return "saved";
    return "uncertain";
  }
  if (state.busy) return "saving";
  if (state.uncertain) return "uncertain";
  if (state.error) return "failed";
  return null;
}
