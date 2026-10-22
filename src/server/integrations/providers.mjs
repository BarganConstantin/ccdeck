// Every tracker the deck can connect to, registered once (#2178). A new
// provider is one import and one registerProvider call here, plus its web half
// (src/web/integrations/registry.ts). registry.mjs has the contract, and
// docs/features/jira-integration-2178.md walks through it.
import { registerProvider } from "./registry.mjs";
import { jiraProvider } from "./jira.mjs";
import { githubProvider, gitlabProvider } from "./forge.mjs";

registerProvider(jiraProvider);
registerProvider(githubProvider);
registerProvider(gitlabProvider);
