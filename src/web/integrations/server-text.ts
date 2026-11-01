// The English sentences the deck's integration routes put in an error's
// `message` (src/server/integrations/*.mjs), by the key each is shown under.
// The server sends text, not codes, and stays untouched: a sentence it is
// known to send is shown in the language on show, and any other (a message the
// provider wrote itself, a new sentence) is shown as it arrives, so nothing is
// lost or invented. Sentences with a variable part (the provider, a status, an
// origin) are matched by a pattern and keep the part as it came.
//
// Not here, on purpose: the sentences for an HTTP misuse a person cannot cause
// from the screen ("No such integrations route.", "Not a board id.", a move
// body that is not JSON, ...), and the image routes, whose failure is an
// <img> that does not load rather than a sentence.
import { t as translateNow, type TFunction } from "../i18n";

const EXACT: Record<string, string> = {
  "The deck failed while reading the tracker.": "integrations.srv.deckFailed",
  "The answer was larger than the deck accepts.": "integrations.srv.tooLarge",
  "Enter a token.": "integrations.srv.enterToken",
  "Enter an API token.": "integrations.srv.enterApiToken",
  "Enter a personal access token.": "integrations.srv.enterPat",
  "The token has a space in it. Paste it again.": "integrations.srv.tokenSpace",
  "Enter the email address of your Atlassian account.": "integrations.srv.enterEmail",
  "Choose Jira Cloud or Jira Server / Data Center.": "integrations.srv.chooseDeployment",
  "Enter your Jira site URL.": "integrations.srv.enterSiteUrl",
  "Enter your Jira URL.": "integrations.srv.enterJiraUrl",
  "Enter your GitLab's address.": "integrations.srv.enterGitlabUrl",
  "Your Jira site URL is not a valid URL.": "integrations.srv.badSiteUrl",
  "Your Jira URL is not a valid URL.": "integrations.srv.badJiraUrl",
  "Your GitLab's address is not a valid URL.": "integrations.srv.badGitlabUrl",
  "Leave the user name and password out of the address.": "integrations.srv.urlUser",
  "Use an https:// address. Plain http is only accepted for a server on this machine.": "integrations.srv.httpsOnly",
  "Use an https:// address.": "integrations.srv.httpsAddress",
  "That connection is not there any more.": "integrations.srv.connectionGone",
  "No token is saved for this connection. Edit it and enter one.": "integrations.srv.noTokenEdit",
  "No token is saved for this connection. Reconnect it in Settings.": "integrations.srv.noTokenReconnect",
  "Enter a comment of up to 10,000 characters.": "integrations.srv.commentLength",
  "This Jira write is outside the connection's token origins.": "integrations.srv.writeOutside",
  "Jira redirected the comment. Refresh the issue before sending again.": "integrations.srv.commentRedirected",
  "The comment could not be confirmed. Refresh the issue before sending again.": "integrations.srv.commentUnconfirmed",
  "Jira redirected the write. It was not replayed; refresh the board before trying again.": "integrations.srv.writeRedirected",
  "Jira's rank result was too large. Refresh the board to check its position.": "integrations.srv.rankTooLarge",
  "Jira did not confirm every requested issue update. Some issues may have changed; refresh the board to check them.": "integrations.srv.updateUnconfirmed",
  "Jira did not confirm the write. Refresh the board to check the issue.": "integrations.srv.writeUnconfirmed",
  "Jira refused the move: the account or token needs permission to edit and schedule this issue.": "integrations.srv.moveRefused",
  "Jira did not return its available transitions.": "integrations.srv.transitionsMissing",
  "Choose a valid transition.": "integrations.srv.transitionChoose",
  "This transition is unavailable or requires additional fields in Jira.": "integrations.srv.transitionUnavailable",
  "Jira redirected the transition. Refresh the issue before trying again.": "integrations.srv.transitionRedirected",
  "Jira did not confirm the transition. Refresh the issue.": "integrations.srv.transitionUnconfirmed",
  "There is no Jira REST API at this address. Check the URL — some servers live under a path such as /jira.": "integrations.srv.noRestApi",
  "This is a Jira Cloud site. Choose Jira Cloud and connect with your email and an API token.": "integrations.srv.isCloud",
  "This is Jira Server or Data Center, not Cloud. Choose Jira Server / Data Center and use a personal access token.": "integrations.srv.isServer",
  "Jira did not accept this email and API token, on the site or through api.atlassian.com. Check both, and that the token has not expired.": "integrations.srv.emailTokenRefused",
  "Jira wants a CAPTCHA after too many failed sign-ins. Sign in to Jira once in your browser, then test the connection again.": "integrations.srv.captcha",
  "Jira did not accept this personal access token: it answered as an anonymous visitor. Check that the token is right and has not expired or been revoked.": "integrations.srv.patAnonymous",
  "That quick filter is not on this board any more. Refresh the board.": "integrations.srv.quickFilterGone",
  "Jira writes are unavailable because this system cannot safely coordinate them.": "integrations.srv.writesUnavailable",
  "Supply either one issueKey or 2–50 ordered issueKeys and a sprint or backlog target.": "integrations.srv.moveWhere",
  "Supply unique, valid issue keys (2–50 for a batch).": "integrations.srv.moveKeys",
  "Not a valid issue key or move target.": "integrations.srv.moveTarget",
  "Use at most one other issue as the rank anchor.": "integrations.srv.moveAnchor",
  "The issues and anchor must all belong to this board.": "integrations.srv.moveSameBoard",
  "The issues and rank anchor must be top-level issues.": "integrations.srv.moveTopLevel",
  "Only top-level non-epic issues with a known status can be moved.": "integrations.srv.moveEpicStatus",
  "Done issues cannot be moved to the backlog because Jira hides them there. Change the status first.": "integrations.srv.moveDone",
  "Every issue must be in the backlog or one active or future sprint.": "integrations.srv.moveSource",
  "The source and target must be active or future sprints on this board.": "integrations.srv.moveSprints",
  "An issue's source changed or is a closed sprint. Refresh the board.": "integrations.srv.moveSourceChanged",
  "Could not determine the destination's last issue. Refresh and try again.": "integrations.srv.moveLastIssue",
  "Could not verify the destination order. Refresh and try again.": "integrations.srv.moveOrder",
  "The destination is too large to determine the last issue. Refresh and try again.": "integrations.srv.moveDestinationLarge",
  "The rank anchor must be in the target group. Refresh the board.": "integrations.srv.moveAnchorGroup",
  "This server runs Jira of an unknown version. Personal access tokens need Jira Server or Data Center 8.14 or newer, so the deck cannot connect to it.": "integrations.srv.serverOldUnknown",
  "too many redirects": "forge.srv.redirects",
  "answer too large": "forge.srv.answerLarge",
  "answer cut off": "forge.srv.answerCut",
  "unreadable JSON": "forge.srv.badJson",
  "log too large to read the end of": "forge.srv.logLarge",
  "image too large": "forge.srv.imageLarge",
  "image cut off": "forge.srv.imageCut",
  "that cursor is not a page of this list": "forge.srv.cursorPage",
  "that cursor is not one of this list": "forge.srv.cursorList",
};

const PATTERNS: Array<[RegExp, string, string[]]> = [
  [/^The deck could not verify (Jira|GitHub|GitLab)'s HTTPS certificate \((.+?)\)\. Check that the address is right and that the server's certificate is valid for it\.$/, "integrations.srv.tlsCert", ["provider", "code"]],
  [/^(Jira|GitHub|GitLab) did not answer in time\.$/, "integrations.srv.timeout", ["provider"]],
  [/^The deck could not find (Jira|GitHub|GitLab)'s address\. Check the URL and your network\.$/, "integrations.srv.noAddress", ["provider"]],
  [/^The deck could not reach (Jira|GitHub|GitLab) \((.+?)\)\. Check the URL, your network or VPN\.$/, "integrations.srv.cannotReachCode", ["provider", "code"]],
  [/^The deck could not reach (Jira|GitHub|GitLab)\. Check the URL, your network or VPN\.$/, "integrations.srv.cannotReach", ["provider"]],
  [/^(Jira|GitHub|GitLab) did not accept these credentials\.$/, "integrations.srv.noCredentials", ["provider"]],
  [/^(Jira|GitHub|GitLab) no longer accepts the saved token\. It may have expired or been revoked — reconnect with a new one\.$/, "integrations.srv.tokenGone", ["provider"]],
  [/^(Jira|GitHub|GitLab) refused: the account or token is not allowed to read this\.$/, "integrations.srv.notAllowed", ["provider"]],
  [/^(Jira|GitHub|GitLab) is limiting requests\. Try again in (\d+) s\.$/, "integrations.srv.limiting", ["provider", "n"]],
  [/^(Jira|GitHub|GitLab) has no such page or record, or this account cannot see it\.$/, "integrations.srv.noSuchPage", ["provider"]],
  [/^(Jira|GitHub|GitLab) refused the request\.$/, "integrations.srv.refusedRequest", ["provider"]],
  [/^(Jira|GitHub|GitLab) is not answering right now \((\d+)\)\. Try again shortly\.$/, "integrations.srv.notAnswering", ["provider", "status"]],
  [/^(Jira|GitHub|GitLab) answered (\d+)\.$/, "integrations.srv.answered", ["provider", "status"]],
  [/^The deck only sends this connection's token to (.+)\.$/, "integrations.srv.tokenOrigins", ["origins"]],
  [/^(Jira|GitHub|GitLab) redirected to (\S+?), and the deck does not send the token there\. Check the address you connected\.$/, "integrations.srv.redirectedAway", ["provider", "origin"]],
  [/^(Jira|GitHub|GitLab) redirected too many times\.$/, "integrations.srv.redirectedMany", ["provider"]],
  [/^(Jira|GitHub|GitLab) answered with something that is not JSON\. Check that the address is the \1 site itself\.$/, "integrations.srv.notJson", ["provider"]],
  [/^The deck will not send a token to (\S+?)\.$/, "integrations.srv.noTokenTo", ["origin"]],
  [/^This server runs Jira (.+?)\. Personal access tokens need Jira Server or Data Center 8\.14 or newer, so the deck cannot connect to it\.$/, "integrations.srv.serverOld", ["version"]],
  [/^(Jira|GitHub|GitLab) is not available on this deck\.$/, "integrations.srv.notOnDeck", ["provider"]],
  [/^(\S+?) did not answer in time$/, "forge.srv.timeout", ["origin"]],
  [/^(\S+?): the certificate is not trusted \((.+?)\)$/, "forge.srv.cert", ["origin", "code"]],
  [/^(\S+?): no answer$/, "forge.srv.noAnswer", ["origin"]],
  [/^(\S+?) is not a host this connection reads from$/, "forge.srv.notHost", ["origin"]],
  [/^(\S+?) sent this read to (\S+?), not to this connection's address$/, "forge.srv.sentElsewhere", ["origin", "next"]],
  [/^(\S+?) answered (.+?), not the API$/, "forge.srv.notApi", ["origin", "type"]],
  [/^not an image \((.+?)\)$/, "forge.srv.notImage", ["type"]],
];

/** A sentence from the deck's integration routes in the language on show; any other text as it came. */
export function integrationText(text: string | null | undefined, tr: TFunction = translateNow): string {
  if (!text) return "";
  const plain = text.replace(/\u2019/g, "'");
  const key = Object.hasOwn(EXACT, plain) ? EXACT[plain] : undefined;
  if (key) return tr(key);
  for (const [pattern, patternKey, names] of PATTERNS) {
    const found = pattern.exec(plain);
    if (!found) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => { params[name] = found[i + 1]; });
    return tr(patternKey, params);
  }
  return text;
}
