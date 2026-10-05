// The git view's reads for a resolved repository, as the routes ask for them.
import { filterNames, readUpstream, resolveRepo } from "./git-repo.mjs";
import { readCommit, readCommitFileDiff, readFileDiff, readLog, readStatus } from "./git-reads.mjs";

/** The repository `folder` is in, with its upstream distance, or why not. */
export async function repoOf(folder) {
  const r = await resolveRepo(folder);
  if (r.state !== "repo") return r;
  return { ...r, upstream: await readUpstream(r.topLevel, r.head.branch), stale: 0 };
}

export const logOf = (repo) => readLog(repo.topLevel, repo.head);

export async function statusOf(repo) {
  return readStatus(repo.topLevel, { filters: await filterNames(repo.topLevel) });
}

export async function fileDiffOf(repo, entry) {
  return readFileDiff(repo.topLevel, entry, { filters: await filterNames(repo.topLevel), hasHead: !repo.head.unborn });
}

export const commitOf = (repo, sha) => readCommit(repo.topLevel, sha);

export const commitFileDiffOf = (repo, commit, file) => readCommitFileDiff(repo.topLevel, commit, file);
