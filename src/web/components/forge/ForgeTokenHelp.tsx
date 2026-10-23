// What a GitHub or GitLab token needs, beside the token field in Settings ›
// Integrations (#2179).
//
// The panels only read, so the help asks for read access and nothing more,
// and says what each permission is for: a token that hides something can then
// be fixed rather than guessed at. The links open the forge's own token page,
// filled in where the forge allows it.
import type { ForgeKind } from "../../forge-types";
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
  if (kind === "github") {
    return (
      <div className="fg-token-help">
        <p>A personal access token. Either kind works:</p>
        <ul>
          <li>
            <strong>Classic</strong> — the <code>repo</code> and <code>read:org</code> scopes.{" "}
            <Make href={forgeTokenUrl("github")}>Make one</Make>
          </li>
          <li>
            <strong>Fine-grained</strong> — the repositories you want to see, with read-only access to Actions, Checks,
            Commit statuses, Contents, Issues, Metadata and Pull requests. Contents is for branches and commits; the
            panel never opens your files.{" "}
            <Make href={forgeTokenUrl("github", null, "fine-grained")}>Make one</Make>
          </li>
        </ul>
        <p>An organization may have to approve a fine-grained token, or a classic one be authorized for its single sign-on, before its repositories show.</p>
      </div>
    );
  }
  const href = forgeTokenUrl("gitlab", baseUrl ?? (values.where === "self" ? values.baseUrl : null));
  return (
    <div className="fg-token-help">
      <p>
        A personal access token with the <code>read_api</code> scope, and nothing more.{" "}
        <Make href={href}>{`Make one on ${href ? new URL(href).host : "GitLab"}`}</Make>
      </p>
      <p>GitLab tokens expire. When this one does, the panel says so and brings you back here.</p>
    </div>
  );
}
