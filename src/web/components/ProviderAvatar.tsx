import claude from "../assets/providers/claude-code.svg";
import codex from "../assets/providers/codex.svg";
import { providerLabel } from "../provider-copy";
import type { Provider } from "../types";
import type { CSSProperties } from "react";

/** opencode and Copilot wear a monogram in the same slot, in the deck's
 *  neutral ink: the deck ships no artwork of theirs, and a borrowed mark or a
 *  colour of their own would say more than the deck knows about them. */
const MONOGRAMS: Partial<Record<Provider, string>> = { opencode: "O", copilot: "C" };

/** Unchanged transparent artwork wears each provider's theme-aware accent. */
export default function ProviderAvatar({ provider }: { provider: Provider }) {
  const name = providerLabel(provider);
  const monogram = MONOGRAMS[provider];
  if (monogram) {
    return <span className="provider-avatar provider-monogram" data-provider={provider} role="img"
      aria-label={name} title={name}><span aria-hidden="true">{monogram}</span></span>;
  }
  const style: CSSProperties & { "--provider-mark": string } = {
    "--provider-mark": `url("${provider === "codex" ? codex : claude}")`,
  };
  return <span className="provider-avatar" data-provider={provider} role="img"
    aria-label={name} title={name} style={style} />;
}
