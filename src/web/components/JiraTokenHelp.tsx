// What a Jira token is and where to make one (#2178), under the connect form's
// fields: Atlassian's token page and, for a token made with scopes, the read
// scopes the deck needs on Cloud; the personal access token page on the
// server itself for Server and Data Center.
import { useT } from "../i18n";
import { rich } from "../integrations/rich";
import { useIntegrationForm } from "./IntegrationConnectionForm";

const CLOUD_TOKENS = "https://id.atlassian.com/manage-profile/security/api-tokens";
const CLOUD_DOCS = "https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/";
const SERVER_DOCS = "https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html";

/** The read scopes a Cloud token made "with scopes" needs, as Atlassian's
 *  token page lists them. */
export const JIRA_CLOUD_SCOPES: readonly { scope: string; why: string; whyKey: string }[] = [
  { scope: "read:jira-work", why: "issues, comments, search", whyKey: "integrations.token.why.work" },
  { scope: "read:jira-user", why: "your account and avatars", whyKey: "integrations.token.why.user" },
  { scope: "read:board-scope:jira-software", why: "boards and backlogs", whyKey: "integrations.token.why.board" },
  { scope: "read:board-scope.admin:jira-software", why: "a board's estimation and quick filters", whyKey: "integrations.token.why.boardAdmin" },
  { scope: "read:sprint:jira-software", why: "sprints", whyKey: "integrations.token.why.sprint" },
  { scope: "read:epic:jira-software", why: "epic names and colours", whyKey: "integrations.token.why.epic" },
  { scope: "read:issue-details:jira", why: "issue lists", whyKey: "integrations.token.why.issueDetails" },
  { scope: "read:jql:jira", why: "filtered lists", whyKey: "integrations.token.why.jql" },
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
  const t = useT();
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
            {rich(t("integrations.token.cloud.intro"), {
              link: <a href={CLOUD_TOKENS} target="_blank" rel="noreferrer noopener">id.atlassian.com → Security → API tokens</a>,
              scoped: <em>{t("integrations.token.cloud.scoped")}</em>,
            })}
          </p>
          <ul className="ig-scopes">
            {JIRA_CLOUD_SCOPES.map(s => <li key={s.scope}><code>{s.scope}</code> <span>{t(s.whyKey)}</span></li>)}
          </ul>
          <p><a href={CLOUD_DOCS} target="_blank" rel="noreferrer noopener">{t("integrations.token.cloud.docs")}</a></p>
        </>
      ) : (
        <>
          <p>
            {rich(t("integrations.token.server.intro"), {
              profile: <strong>Profile</strong>,
              pats: <strong>Personal Access Tokens</strong>,
              create: <strong>Create token</strong>,
              page: page ? rich(t("integrations.token.server.page"), {
                link: <a href={page} target="_blank" rel="noreferrer noopener">{t("integrations.token.server.openOn", { host })}</a>,
              }) : "",
            })}
          </p>
          <p><a href={SERVER_DOCS} target="_blank" rel="noreferrer noopener">{t("integrations.token.server.docs")}</a></p>
        </>
      )}
      <p className="ig-dim">{t("integrations.token.reads")}</p>
      {cloud && <p className="ig-dim">{rich(t("integrations.token.scopedWrite"), {
        rank: <code>write:issue:jira-software</code>,
        sprint: <code>write:sprint:jira-software</code>,
        backlog: <code>write:board-scope:jira-software</code>,
      })}</p>}
    </>
  );
}
