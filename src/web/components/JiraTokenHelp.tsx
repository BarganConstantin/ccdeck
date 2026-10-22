// What a Jira token is and where to make one (#2178), under the connect form's
// fields: Atlassian's token page and, for a token made with scopes, the read
// scopes the deck needs on Cloud; the personal access token page on the
// server itself for Server and Data Center.
import { useIntegrationForm } from "./IntegrationConnectionForm";

const CLOUD_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";
const CLOUD_DOCS = "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/";
const SERVER_DOCS = "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html";

/** The read scopes a Cloud token made "with scopes" needs, as Atlassian's
 *  token page lists them. */
export const JIRA_CLOUD_SCOPES: readonly { scope: string; why: string }[] = [
  { scope: "read:jira-work", why: "issues, comments, search" },
  { scope: "read:jira-user", why: "your account and avatars" },
  { scope: "read:board-scope:jira-software", why: "boards and backlogs" },
  { scope: "read:board-scope.admin:jira-software", why: "a board's estimation and quick filters" },
  { scope: "read:sprint:jira-software", why: "sprints" },
  { scope: "read:epic:jira-software", why: "epic names and colours" },
  { scope: "read:issue-details:jira", why: "issue lists" },
  { scope: "read:jql:jira", why: "filtered lists" },
];

/** A Server's own token page, when the address typed so far is one. */
export function serverTokenPage(baseUrl: string): string | null {
  const raw = baseUrl.trim();
  if (!raw) return null;
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !local) return null;
    if (!u.hostname.includes(".") && !local) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, "")}/secure/ViewProfile.jspa?selectedTab=com.atlassian.pats.pats-plugin:jira-user-personal-access-tokens`;
  } catch { return null; }
}

export default function JiraTokenHelp() {
  const { values } = useIntegrationForm();
  const cloud = values.deployment === "cloud";
  const page = cloud ? null : serverTokenPage(values.baseUrl ?? "");
  let host = "";
  try { host = page ? new URL(page).host : ""; } catch { /* no host */ }
  return (
    <>
      {cloud ? (
        <>
          <p>
            Make one at <a href={CLOUD_TOKENS} target="_blank" rel="noreferrer noopener">id.atlassian.com → Security → API tokens</a>.
            A classic token reads Jira as you. A token <em>with scopes</em> works too: the deck finds your site&rsquo;s
            api.atlassian.com address itself, and needs these read scopes:
          </p>
          <ul className="ig-scopes">
            {JIRA_CLOUD_SCOPES.map(s => <li key={s.scope}><code>{s.scope}</code> <span>{s.why}</span></li>)}
          </ul>
          <p><a href={CLOUD_DOCS} target="_blank" rel="noreferrer noopener">How Atlassian API tokens work</a></p>
        </>
      ) : (
        <>
          <p>
            In Jira, open your avatar → <strong>Profile</strong> → <strong>Personal Access Tokens</strong> → <strong>Create token</strong>
            {page && <> (<a href={page} target="_blank" rel="noreferrer noopener">open it on {host}</a>)</>}.
            The token reads what your account can read. Give it an expiry you are comfortable with. Needs Jira 8.14 or newer.
          </p>
          <p><a href={SERVER_DOCS} target="_blank" rel="noreferrer noopener">How personal access tokens work</a></p>
        </>
      )}
      <p className="ig-dim">The deck only reads: it sends Jira nothing but GET requests, keeps the token on this machine, and never shows it again.</p>
    </>
  );
}
