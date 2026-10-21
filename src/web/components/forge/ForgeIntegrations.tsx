// GitHub and GitLab as the integrations host offers them (#2178, #2179): the
// connect form's fields for each, and the words on its token. Their one panel
// is in integrations/panels.tsx, which loads with the modal rather than with
// the page.
import { createElement } from "react";
import type { FieldDef, IntegrationConnection } from "../../integrations/types";
import ForgeTokenHelp from "./ForgeTokenHelp";

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
