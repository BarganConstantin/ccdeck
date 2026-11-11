// "Fit all" on the canvas, while auto-fit is off: one quiet button with the
// canvas controls' recenter glyph that fits the board and turns auto-fit back on.
//
// The switch is use-auto-fit-switch's and BoardFlow.tsx shows the button only
// while it is off (#820).
import { useT } from "../i18n";
import { KitIcon } from "./kit-icons";

export default function AutoFitChip({ enableAutoFitAndRefit }: {
  enableAutoFitAndRefit: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="autofit-chip"
      onClick={enableAutoFitAndRefit}
      title={t("accounts.autoFit.fitAllTip")}
    >
      <KitIcon name="recenter" />
      {t("accounts.autoFit.fitAll")}
    </button>
  );
}
