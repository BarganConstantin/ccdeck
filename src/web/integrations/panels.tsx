// The panel each provider draws under the modal's header (#2178, #2179), kept
// apart from registry.ts. The registry is what the rail, Settings and the
// keyboard sheet read, so it loads with the page; the panels are by far the
// larger half (the Jira backlog and issue, the forges' four tabs and four item
// pages, both HTML trees) and load with the modal, the first time one opens
// (IntegrationModalOnDemand.tsx). A deck that never opens one never fetches
// them.
import IntegrationSplit from "../components/IntegrationSplit";
import JiraPanel from "../components/JiraPanel";
import ForgePanel from "../components/forge/ForgePanel";
import type { IntegrationKind, IntegrationPanel, IntegrationPanelProps } from "./types";

// GitHub and GitLab: one panel, told which forge it is and handed the host's
// list/detail split.
function GithubPanel(props: IntegrationPanelProps) {
  return <ForgePanel kind="github" {...props} Split={IntegrationSplit} />;
}

function GitlabPanel(props: IntegrationPanelProps) {
  return <ForgePanel kind="gitlab" {...props} Split={IntegrationSplit} />;
}

/** Every provider's panel, by kind: one for each entry of the registry. */
export const INTEGRATION_PANELS: Readonly<Partial<Record<IntegrationKind, IntegrationPanel>>> = {
  jira: JiraPanel,
  github: GithubPanel,
  gitlab: GitlabPanel,
};
