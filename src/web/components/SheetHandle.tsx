// The grab handle at the top of a phone sheet (styles/phone-sheet.css): drawn
// only at 640 and under, where Usage, This machine, the Inspector and Accounts
// come up from the bottom edge. Decorative; the drag it starts is
// use-phone-sheets.ts's, and Esc and the panel's own × are the ways that
// need no finger.
export default function SheetHandle() {
  return <span className="sheet-handle" aria-hidden="true" />;
}
