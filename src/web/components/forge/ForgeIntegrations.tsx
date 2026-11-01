// GitHub and GitLab as the integrations host offers them (#2178, #2179): the
// connect form's fields for each, and the words on its token. Their one panel
// is in integrations/panels.tsx, which loads with the modal rather than with
// the page.
import { createElement } from "react";
import type { FieldDef, IntegrationConnection } from "../../integrations/types";
import { t } from "../../i18n";
import ForgeTokenHelp from "./ForgeTokenHelp";

// The labels are read when the form draws, not when this file loads, so they
// follow the language on show: each one is a getter that asks t() at that
// moment (the form re-renders on a language change).
const TOKEN: FieldDef = {
  name: "token", type: "password", secret: true,
  get label() { return t("forge.field.token"); },
  get placeholder() { return t("forge.field.tokenPlaceholder"); },
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
    name: "where", type: "choice",
    get label() { return t("forge.field.which"); },
    get options() { return [{ value: "cloud", label: "GitLab.com" }, { value: "self", label: t("forge.field.selfManaged") }]; },
    initial: conn => (selfManaged(conn) ? "self" : "cloud"),
  },
  {
    name: "baseUrl", type: "url", placeholder: "https://gitlab.example.com",
    get label() { return t("forge.field.url"); },
    get hint() { return t("forge.field.urlHint"); },
    when: { field: "where", is: ["self"] },
    initial: conn => (selfManaged(conn) ? conn!.baseUrl : ""),
  },
  TOKEN,
];

export const githubTokenHelp = createElement(ForgeTokenHelp, { kind: "github" });
export const gitlabTokenHelp = createElement(ForgeTokenHelp, { kind: "gitlab" });
