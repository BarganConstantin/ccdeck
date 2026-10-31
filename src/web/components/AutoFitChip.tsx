// The chip on the canvas that says auto-fit is off, and turns it back on.
//
// Moved out of App.tsx's markup unchanged. The switch is use-auto-fit-switch's
// and App.tsx shows the chip only while it is off (#820).
import { useT } from "../i18n";

export default function AutoFitChip({ enableAutoFitAndRefit }: {
  enableAutoFitAndRefit: () => void;
}) {
  const t = useT();
  return (
    <div className="autofit-chip">
      <span className="autofit-state" title={t("accounts.autoFit.offTip")}>
        {t("accounts.autoFit.off")}
      </span>
      <button
        type="button"
        className="autofit-resume"
        onClick={enableAutoFitAndRefit}
        title={t("accounts.autoFit.resumeTip")}
        aria-label={t("accounts.autoFit.resumeLabel")}
      >
        {t("accounts.autoFit.resume")}
      </button>
    </div>
  );
}
