// The tool kinds the card's foot draws as icons, most recent first.
//
// Pure over the calls the card already receives (its tool list), so the foot
// says which kinds the session used without a new route or a new field.
import { categoryFor, type ToolCategory } from "./tool-taxonomy";
import type { KitIconName } from "./components/kit-icons";
import type { ToolCall } from "./types";

/** V4's Agent / Card shows at most three. */
export const FOOT_TOOL_ICONS = 3;

/** The kit icon each tool kind wears in the foot. */
export const TOOL_KIT_ICON: Record<ToolCategory, KitIconName> = {
  file: "file",
  shell: "terminal",
  web: "search",
  agent: "agents",
  task: "sessions",
  plan: "thinking",
  mcp: "integrations",
  other: "tools",
};

/** The distinct kinds of the session's calls, the latest-started first, at most
 *  `max`. */
export function recentToolKinds(tools: readonly Pick<ToolCall, "name" | "startedAt">[], max = FOOT_TOOL_ICONS): ToolCategory[] {
  const out: ToolCategory[] = [];
  const latest = [...tools].sort((a, b) => b.startedAt - a.startedAt);
  for (const call of latest) {
    const kind = categoryFor(call.name);
    if (!out.includes(kind)) out.push(kind);
    if (out.length >= max) break;
  }
  return out;
}
