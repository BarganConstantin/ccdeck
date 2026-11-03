/** The word beside an email that says a Local network row is a Codex login.
 *  One address can be both a Claude and a Codex account, and two rows for it
 *  must not read as one; a Claude row says nothing, as every row did before.
 *  A product name, so it is not translated. */
export default function LanKind() {
  return <span className="lan-kind">Codex</span>;
}
