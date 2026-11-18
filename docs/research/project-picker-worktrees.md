# Worktree discovery in New session

Git records linked checkouts in the common repository's `worktrees` directory.
Each checkout has a `.git` pointer and each registration has a pointer back to
that checkout. ccdeck verifies both links and the common directory before
offering the folder. This avoids confusing independent clones, stale registrations
and submodules that also use a `.git` file.
[Git repository layout](https://git-scm.com/docs/gitrepository-layout)
[Git worktree details](https://git-scm.com/docs/git-worktree#_details)

Discovery works from repositories found in the usual project folders. It
resolves absolute and relative pointers using the host's filesystem paths,
preserves the checkout's own launch path, and reads a branch label only when
the checkout's HEAD names a branch. Registration reads share the project
scanner's bounds and do not require starting Git for every repository.
[Git worktree relative paths](https://git-scm.com/docs/git-worktree)
[Node path API](https://nodejs.org/api/path.html#windows-vs-posix)

Worktrees are optional in the unfiltered list so a repository with many
checkouts does not bury other projects. Search can find the project, folder,
branch or path. Each group has a repository label and its options share the
picker's keyboard sequence.
[WAI-ARIA grouped listbox pattern](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/examples/listbox-grouped/)
