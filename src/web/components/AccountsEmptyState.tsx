// What the accounts panel says when there is no roster to draw.
//
// Lifted out of AccountsPanel.tsx unchanged. The roster read answers `ok:
// false` for four different reasons — claude-swap still installing, not
// installed, installed with nothing in its store, or a store that could not be
// read — and each needs a different thing from the reader, so each gets its own
// sentence. It was a forty-line branch of the panel's render that read nothing
// but the answer's reason and hint, and that is all it is handed.
import { type AccountsData } from "../claude-accounts";

export default function AccountsEmptyState({ data }: { data: Pick<AccountsData, "reason" | "hint"> }) {
  return (
    <div className="ap-empty">
      {/* The deck's own install, still running. Said as a wait rather
          than a fault, and with no command in it: the command belongs
          to `no_cswap`, where there is no install coming, and printed
          here it sent people to race a second installer against the
          one already running. */}
      {data.reason === "cswap_installing" ? (
        <>
          <span>Installing claude-swap…</span>
          <span className="ap-hint">
            The deck is setting it up in the background, so there is nothing to do here.
            On a new machine this can take a few minutes; the panel fills in by itself
            when it is done.
          </span>
        </>
      ) : data.reason === "no_cswap" ? (
        <>
          <span>claude-swap isn't installed.</span>
          <span className="ap-hint">
            This panel reads the account store claude-swap keeps — without it there is
            nothing to show. It is a separate tool, published on PyPI, so it does not
            come with this package.
          </span>
          {data.hint && <code className="ap-cmd">{data.hint}</code>}
          <span className="ap-hint">Then add an account with the <strong>+</strong> button above.</span>
        </>
      ) : data.reason === "no_accounts" ? (
        <>
          <span>No accounts added yet.</span>
          <span className="ap-hint">
            claude-swap is installed but has nothing in its store. Use the <strong>+</strong> above
            to sign one in, or to paste one shared from another deck.
          </span>
        </>
      ) : (
        <>
          <span>Couldn't read the account store.</span>
          <span className="ap-hint">
            claude-swap is installed, but its store could not be read
            {data.reason ? ` (${data.reason})` : ""}.
          </span>
        </>
      )}
    </div>
  );
}
