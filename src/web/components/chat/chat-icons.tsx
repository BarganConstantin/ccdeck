// The glyphs Chat and the Decision card draw: a lock, a changed question, the
// marks a tool row wears, and the image on a message's chip. V4's kit drawings,
// in currentColor, hidden from assistive technology (every one sits beside
// words that say what it says). The logo is never drawn here.
import { KitIcon, KitStateGlyph } from "../kit-icons";

/** A changed rule or mode: only in the terminal. */
export const LockGlyph = () => <KitIcon name="lock" />;

/** The question changed under the answer. */
export const ChangedGlyph = () => <KitIcon name="changed" />;

export const ChevronRightGlyph = () => <KitIcon name="chevron-right" />;
export const FileGlyph = () => <KitIcon name="file" />;
export const SearchGlyph = () => <KitIcon name="search" />;
export const ToolTerminalGlyph = () => <KitIcon name="terminal" />;
/** The option you chose, on a question card: Done's tick. */
export const DoneGlyph = () => <KitStateGlyph name="done" size={12} />;
/** A sub-agent the assistant started. */
export const AgentGlyph = () => <KitIcon name="agents" />;
/** A task-list item not started yet: Idle's ring. */
export const TodoPendingGlyph = () => <KitStateGlyph name="idle" size={12} />;
/** The task being worked on: Working's ring, drawn still. */
export const TodoActiveGlyph = () => <KitStateGlyph name="working" size={12} />;
/** Images you sent with a message, on its chip. */
export const ImageGlyph = () => <KitIcon name="image" />;
