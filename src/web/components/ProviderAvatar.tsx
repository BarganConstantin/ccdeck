import claude from "../assets/providers/claude-code.svg";
import codex from "../assets/providers/codex.svg";
import type { Provider } from "../types";
import type { CSSProperties } from "react";

/** Upstream monochrome artwork follows the theme's ink; status stays separate. */
export default function ProviderAvatar({ provider }: { provider: Provider }) {
  const name = provider === "codex" ? "Codex" : "Claude Code";
  const style: CSSProperties & { "--provider-mark": string } = {
    "--provider-mark": `url("${provider === "codex" ? codex : claude}")`,
  };
  return <span className="provider-avatar" data-provider={provider} role="img"
    aria-label={name} title={name} style={style} />;
}
