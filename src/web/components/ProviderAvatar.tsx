import claude from "../assets/providers/claude-code.svg";
import codex from "../assets/providers/codex.svg";
import type { Provider } from "../types";

/** Provider identity uses the original artwork; status is drawn separately. */
export default function ProviderAvatar({ provider }: { provider: Provider }) {
  const name = provider === "codex" ? "Codex" : "Claude Code";
  return <img className="provider-avatar" src={provider === "codex" ? codex : claude}
    alt={name} title={name} width={20} height={20} draggable={false} />;
}
