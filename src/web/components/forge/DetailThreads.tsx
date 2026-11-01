// A merge request's discussions and an issue's comments, as the forge's page
// shows them (#2179): a review thread says where it is — `path:line`, no code
// snippet, since the code is read in the editor — then its comments, each
// with who wrote it, when, and the forge's own rendering of what they said.
import type { ForgeComment, ForgeKind, ReviewThread } from "../../forge-types";
import { forgeWords } from "../../forge-types";
import type { TFunction } from "../../i18n";
import { pathParts, threadPlace } from "../../forge-detail";
import { useT } from "../../i18n";
import ForgeHtml from "../ForgeHtml";
import { useForge } from "./ForgeContext";
import { Ago, Person } from "./ForgeParts";
import { PathDir, useForgeNodes } from "./DetailParts";

function linkWords(kind: ForgeKind, t: TFunction): string {
  return t("forge.comment.openIn", { name: forgeWords[kind].name });
}

/** One comment: its author, when, a link to it, and its body. */
export function Comment({ comment }: { comment: ForgeComment }) {
  const { kind } = useForge();
  const t = useT();
  const nodes = useForgeNodes(comment.bodyHtml);
  return (
    <li className="fd-comment">
      <div className="fd-comment-head">
        {comment.author ? <Person user={comment.author} size={20} /> : <span className="fd-none">{t("forge.comment.someone")}</span>}
        {comment.createdAt != null && <span className="fd-comment-time"><Ago at={comment.createdAt} /></span>}
        {comment.webUrl && (
          <a className="fd-comment-link" href={comment.webUrl} target="_blank" rel="noreferrer noopener" aria-label={linkWords(kind, t)} title={linkWords(kind, t)}>
            <span aria-hidden="true">↗</span>
          </a>
        )}
      </div>
      {nodes.length ? <ForgeHtml className="fd-comment-body" nodes={nodes} /> : <p className="fd-comment-body fd-none">{t("forge.comment.noText")}</p>}
    </li>
  );
}

/** A thread: where it is on the diff, when it has a place, then its comments. */
export function Thread({ thread }: { thread: ReviewThread }) {
  const t = useT();
  const place = thread.path ? pathParts(thread.path) : null;
  return (
    <li className="fd-thread">
      {place && (
        <div className="fd-thread-head">
          <code className="fd-path" title={threadPlace(thread) ?? undefined}>
            <PathDir dir={place.dir} />
            <span className="fd-path-name">{place.name}{thread.line != null && <span className="fd-path-line">:{thread.line}</span>}</span>
          </code>
          {thread.outdated && <span className="fg-badge fd-outdated">{t("forge.thread.outdated")}</span>}
        </div>
      )}
      <ol className="fd-comments">
        {thread.comments.map(c => <Comment key={c.id} comment={c} />)}
      </ol>
    </li>
  );
}

export function ThreadList({ threads }: { threads: ReviewThread[] }) {
  return <ol className="fd-threads">{threads.map(t => <Thread key={t.id} thread={t} />)}</ol>;
}
