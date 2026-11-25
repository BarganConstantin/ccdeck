// SIGNED IN AS AN ACCOUNT THAT IS NOT HERE. Claude Code's live login is one
// claude-swap does not hold, so no row is the live one (claude-login.mjs) —
// said once, with the add that ends it, rather than leaving the list to look as
// if nobody were in.
//
// THE ADDRESS IS TEXT. The catalog marks where each language puts the emphasis
// ("signed in to <b>{email}</b>"); tNodes reads that mark before the address
// goes in, so the reader sees the address in bold and never the mark, and an
// address with "<" or "&" in it reads exactly as it is. 4.3.11 filled the
// address in as a node and left the mark around it as text: "<b>a@b.c</b>".
import { tNodes } from "../accounts-rich";
import { type TFunction, useT } from "../i18n";

/** The notice's sentence, as nodes: the address a <strong> text node. */
export function unlistedSentence(t: TFunction, email: string) {
  return tNodes(t, "accounts.panel.unlisted", { email });
}

export default function UnlistedLoginNotice({ email, onAdd }: { email: string; onAdd: () => void }) {
  const t = useT();
  return (
    <div className="ap-notice">
      {/* An address has no spaces to wrap at: .ap-notice-text breaks it
          anywhere, so the Add account press keeps its place at any width. */}
      <span className="ap-notice-text">{unlistedSentence(t, email)}</span>
      <button type="button" className="ap-notice-fix" onClick={onAdd} title={t("accounts.panel.addTip")}>
        {t("accounts.panel.addAccount")}
      </button>
    </div>
  );
}
