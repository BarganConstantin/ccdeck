// The trackers the page knows how to show (#2178), keyed by kind: a static,
// typed map. Each entry is the provider's whole page half — its name and rail
// glyph, the key that opens it, the fields of its connect form and the words
// on its token, and the panel the host draws under its header. The server's
// half is src/server/integrations/registry.mjs; a provider registers in both.
//
// Everything that is not a provider's own — the list of connections, Settings
// → Integrations, the rail slot, the large modal and its header, the split
// between a list and a detail, the remembered view — is the core's, and takes
// the provider's parts from here.
import { createElement } from "react";
import { JiraGlyph } from "../components/rail-glyphs";
import JiraPanel from "../components/JiraPanel";
import JiraTokenHelp from "../components/JiraTokenHelp";
import type { IntegrationConnection, IntegrationKind, IntegrationWebDef } from "./types";

export type {
  FieldDef, IntegrationConnection, IntegrationKind, IntegrationPanelProps, IntegrationPrefs, IntegrationWebDef,
} from "./types";

const deploymentOf = (conn?: IntegrationConnection) => (conn?.meta?.deployment === "cloud" ? "cloud" : "server");

const jira: IntegrationWebDef = {
  kind: "jira",
  label: "Jira",
  Glyph: JiraGlyph,
  // J is the canvas's next agent (with K), so the other free letter in the name.
  shortcut: "I",
  detail: "Your board, sprint first",
  blurb: "Jira Cloud, or Jira Server / Data Center 8.14 and newer.",
  fields: [
    {
      name: "deployment", label: "Which Jira", type: "choice",
      options: [{ value: "server", label: "Jira Server / Data Center" }, { value: "cloud", label: "Jira Cloud" }],
      initial: deploymentOf,
    },
    {
      name: "baseUrl", label: "Jira URL", type: "url", initial: conn => conn?.baseUrl ?? "",
      variants: {
        field: "deployment",
        by: {
          server: { label: "Jira URL", placeholder: "https://jira.example.com", hint: "The address you open Jira at, with its path if it has one (…/jira). https only." },
          cloud: { label: "Site URL", placeholder: "your-site.atlassian.net", hint: "The address you open Jira at. Your site name alone is enough." },
        },
      },
    },
    {
      name: "email", label: "Atlassian account email", type: "email", placeholder: "you@example.com",
      autoComplete: "username", secret: true, when: { field: "deployment", is: ["cloud"] },
    },
    {
      name: "token", label: "Personal access token", type: "password", secret: true,
      variants: {
        field: "deployment",
        by: {
          server: { label: "Personal access token", placeholder: "Paste the token" },
          cloud: { label: "API token", placeholder: "Paste the API token" },
        },
      },
    },
  ],
  tokenHelp: createElement(JiraTokenHelp),
  Panel: JiraPanel,
};

/** Every provider the page has, by kind. GitHub and GitLab arrive with #2179. */
export const INTEGRATIONS: Readonly<Partial<Record<IntegrationKind, IntegrationWebDef>>> = { jira };

/** The providers, in the order Settings lists them. */
export const integrationDefs = (): IntegrationWebDef[] => Object.values(INTEGRATIONS).filter((d): d is IntegrationWebDef => Boolean(d));

export function integrationDef(kind: string): IntegrationWebDef | null {
  return (Object.hasOwn(INTEGRATIONS, kind) ? INTEGRATIONS[kind as IntegrationKind] : undefined) ?? null;
}
