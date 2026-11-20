// The glyphs Chat and the Decision card draw: a lock, a changed question, and the
// marks a tool row wears. V4's kit drawings, in currentColor, hidden from
// assistive technology (every one sits beside words that say what it says). The
// logo is never drawn here.
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
