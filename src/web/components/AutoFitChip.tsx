// The chip on the canvas that says auto-fit is off, and turns it back on.
//
// Moved out of App.tsx's markup unchanged. The switch is use-auto-fit-switch's
// and App.tsx shows the chip only while it is off (#820).
export default function AutoFitChip({ enableAutoFitAndRefit }: {
  enableAutoFitAndRefit: () => void;
}) {
  return (
    <div className="autofit-chip">
      <span className="autofit-state" title="New sessions are not brought into view while you are moving it yourself">
        Auto-fit off
      </span>
      <button
        type="button"
        className="autofit-resume"
        onClick={enableAutoFitAndRefit}
        title="Bring new sessions into view again"
        aria-label="Resume auto-fit"
      >
        Resume
      </button>
    </div>
  );
}
