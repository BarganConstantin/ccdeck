// What a GitHub or GitLab token needs, beside the token field in Settings ›
// Integrations (#2179).
//
// The panels only read, so the help asks for read access and nothing more,
// and says what each permission is for: a token that hides something can then
// be fixed rather than guessed at. The links open the forge's own token page,
// filled in where the forge allows it.
import type { ReactNode } from "react";
import type { ForgeKind } from "../../forge-types";
import { useT } from "../../i18n";
import { ExternalLinkGlyph } from "../action-glyphs";
import { useIntegrationForm } from "../IntegrationConnectionForm";

/** The page that makes a token: GitHub's, or the GitLab instance's at
 *  `baseUrl` (null while what was typed is not an address yet). */
export function forgeTokenUrl(kind: ForgeKind, baseUrl?: string | null, style: "classic" | "fine-grained" = "classic"): string | null {
  if (kind === "github") {
    return style === "classic"
      ? "https://github.com/settings/tokens/new?scopes=repo,read:org&description=ccdeck"
      : "https://github.com/settings/personal-access-tokens/new";
  }
  const raw = (baseUrl ?? "").trim() || "https://gitlab.com";
  let base: URL;
  try {
    // The form takes an address without its scheme, as the deck does.
    base = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (base.protocol !== "https:" && base.protocol !== "http:") return null;
  if (!base.hostname.includes(".") && base.hostname !== "localhost") return null;
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}/-/user_settings/personal_access_tokens?name=ccdeck&scopes=read_api`;
}

/** A sentence with named holes ({repo}, {scope}) filled by elements, so a
 *  language can put the code names wherever its grammar wants them. */
function withParts(text: string, parts: Record<string, ReactNode>): ReactNode[] {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const name = /^\{(\w+)\}$/.exec(piece)?.[1];
    return name && name in parts ? <span key={i}>{parts[name]}</span> : piece;
  });
}

function Make({ href, children }: { href: string | null; children: string }) {
  if (!href) return null;
  return (
    <a className="fg-token-link" href={href} target="_blank" rel="noreferrer noopener">
      {children} <ExternalLinkGlyph />
    </a>
  );
}

/** Under the connect form's fields; on GitLab it follows the instance typed
 *  so far (or `baseUrl`, outside a form). */
export default function ForgeTokenHelp({ kind, baseUrl }: { kind: ForgeKind; baseUrl?: string | null }) {
  const { values } = useIntegrationForm();
  const t = useT();
  if (kind === "github") {
    return (
      <div className="fg-token-help">
        <p>{t("forge.token.gh.intro")}</p>
        <ul>
          <li>
            <strong>{t("forge.token.gh.classicName")}</strong> {withParts(t("forge.token.gh.classic"), { repo: <code>repo</code>, org: <code>read:org</code> })}{" "}
            <Make href={forgeTokenUrl("github")}>{t("forge.token.makeOne")}</Make>
          </li>
          <li>
            <strong>{t("forge.token.gh.fineName")}</strong> {t("forge.token.gh.fine")}{" "}
            <Make href={forgeTokenUrl("github", null, "fine-grained")}>{t("forge.token.makeOne")}</Make>
          </li>
        </ul>
        <p>{t("forge.token.gh.approval")}</p>
      </div>
    );
  }
  const href = forgeTokenUrl("gitlab", baseUrl ?? (values.where === "self" ? values.baseUrl : null));
  return (
    <div className="fg-token-help">
      <p>
        {withParts(t("forge.token.gl.scope"), { scope: <code>read_api</code> })}{" "}
        <Make href={href}>{t("forge.token.makeOn", { host: href ? new URL(href).host : "GitLab" })}</Make>
      </p>
      <p>{t("forge.token.gl.expire")}</p>
    </div>
  );
}
