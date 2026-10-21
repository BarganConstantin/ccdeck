// GitHub and GitLab as the integrations host draws them (#2178, #2179): one
// panel for both, told which forge it is and handed the host's list/detail
// split, and the connect form's fields for each.
import { createElement } from "react";
import type { FieldDef, IntegrationConnection, IntegrationPanelProps } from "../../integrations/types";
import IntegrationSplit from "../IntegrationSplit";
import ForgePanel from "./ForgePanel";
import ForgeTokenHelp from "./ForgeTokenHelp";

export function GithubPanel(props: IntegrationPanelProps) {
  return <ForgePanel kind="github" {...props} Split={IntegrationSplit} />;
}

export function GitlabPanel(props: IntegrationPanelProps) {
  return <ForgePanel kind="gitlab" {...props} Split={IntegrationSplit} />;
}

const TOKEN: FieldDef = {
  name: "token", label: "Personal access token", type: "password", secret: true, placeholder: "Paste the token",
};

export const GITHUB_FIELDS: readonly FieldDef[] = [TOKEN];

/** gitlab.com, or the user's own instance at the address they type. */
const selfManaged = (conn?: IntegrationConnection) => {
  try {
    return conn ? new URL(conn.baseUrl).host !== "gitlab.com" : false;
  } catch {
    return false;
  }
};

export const GITLAB_FIELDS: readonly FieldDef[] = [
  {
    name: "where", label: "Which GitLab", type: "choice",
    options: [{ value: "cloud", label: "GitLab.com" }, { value: "self", label: "Self-managed" }],
    initial: conn => (selfManaged(conn) ? "self" : "cloud"),
  },
  {
    name: "baseUrl", label: "GitLab URL", type: "url", placeholder: "https://gitlab.example.com",
    hint: "The address you open GitLab at, with its path if it has one. https only.",
    when: { field: "where", is: ["self"] },
    initial: conn => (selfManaged(conn) ? conn!.baseUrl : ""),
  },
  TOKEN,
];

export const githubTokenHelp = createElement(ForgeTokenHelp, { kind: "github" });
export const gitlabTokenHelp = createElement(ForgeTokenHelp, { kind: "gitlab" });
