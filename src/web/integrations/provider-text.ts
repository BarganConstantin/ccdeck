// The words the provider registries write in English (registry.ts and the forge
// field lists), said in the language on show.
import type { TFunction } from "../i18n";

/** The provider words the registries (and the forge field lists) write
 *  in English, by their English text, so a form or a row can say them in the
 *  language on show. A text not listed is somebody's own and stays as written. */
const PROVIDER_TEXT: Readonly<Record<string, string>> = {
  "Boards, sprints, and issues": "integrations.provider.jira.detail",
  "Jira Cloud, or Jira Server / Data Center 8.14 and newer.": "integrations.provider.jira.blurb",
  "Repositories, pull requests, and Actions": "integrations.provider.github.detail",
  "github.com, read-only, with a personal access token.": "integrations.provider.github.blurb",
  "Projects, merge requests, and pipelines": "integrations.provider.gitlab.detail",
  "GitLab.com or your own instance, read-only.": "integrations.provider.gitlab.blurb",
  "Which Jira": "integrations.field.whichJira",
  "Jira URL": "integrations.field.jiraUrl",
  "The address you open Jira at, with its path if it has one (…/jira). https only.": "integrations.field.jiraUrlHint",
  "Site URL": "integrations.field.siteUrl",
  "The address you open Jira at. Your site name alone is enough.": "integrations.field.siteUrlHint",
  "Atlassian account email": "integrations.field.email",
  "Personal access token": "integrations.field.pat",
  "API token": "integrations.field.apiToken",
  "Paste the token": "integrations.field.pasteToken",
  "Paste the API token": "integrations.field.pasteApiToken",
  "Which GitLab": "integrations.field.whichGitlab",
  "Self-managed": "integrations.field.selfManaged",
  "GitLab URL": "integrations.field.gitlabUrl",
  "The address you open GitLab at, with its path if it has one. https only.": "integrations.field.gitlabUrlHint",
};

/** A registry text in the language on show; a text with no entry (a host, a
 *  name, a placeholder address) comes back as it was. */
export function providerText(t: TFunction, text: string): string;
export function providerText(t: TFunction, text: string | undefined): string | undefined;
export function providerText(t: TFunction, text: string | undefined): string | undefined {
  const key = text === undefined ? undefined : PROVIDER_TEXT[text];
  return key ? t(key) : text;
}
