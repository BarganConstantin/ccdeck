// The folded Inspector's tab (V4's Figma): a corner in the pane header's
// band, on the Inspector's surface with its left and bottom lines, holding one
// button, ‹, which shows the Inspector again (App.tsx says when it is drawn).
// The pane's header ends before it (workspace.css), so no control sits under it.
import { useT } from "../i18n";
import { useSingleKeyShortcuts } from "../use-single-key-shortcuts";
import { KitIcon } from "./kit-icons";
import { useHint } from "./use-hint";

export default function InspectorTab({ onShow }: { onShow: () => void }) {
  const tr = useT();
  const singleKeys = useSingleKeyShortcuts();
  const hint = useHint("below");
  const label = tr("board.inspector.show");
  return (
    <div className="insp-corner">
      <button
        type="button"
        className="glyph-btn insp-show"
        aria-label={label}
        aria-keyshortcuts={singleKeys ? "D" : undefined}
        onClick={onShow}
        {...hint.bind({ label, keys: singleKeys ? "D" : undefined })}
      >
        <KitIcon name="chevron-left" />
      </button>
      {hint.node}
    </div>
  );
}
