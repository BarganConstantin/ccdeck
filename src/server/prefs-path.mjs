// Where prefs.json lives. Its own module because two do the arithmetic:
// deck-prefs.mjs, which reads and writes the file, and the half that moves a
// file nobody can use out of its way.
import { join } from "node:path";
import { deckDataDir } from "./deck-home.mjs";

/* WHERE THIS FILE LIVES, AND WHY IT MOVED. It sat in ~/.claude/agent-dag — the
   directory Claude Code owns — which meant a person clearing Claude Code's
   configuration cleared this deck's private key, and every machine that had
   pinned it had to be told to trust this one again. deck-home.mjs owns the new
   answer and the reasons; what matters here is that the parameter is still a
   DIRECTORY, so every caller that passes one is unchanged. */
export const prefsDir = (home = deckDataDir()) => home;
export const prefsPath = (home = deckDataDir()) => join(prefsDir(home), "prefs.json");
