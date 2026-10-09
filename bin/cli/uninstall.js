// `--uninstall`, and `--purge` with it: every trace of the deck that is not
// somebody's data, taken off the machine, and every one that could not be,
// named.
//
// Lifted out of bin/deck.js, which still answers it before the migration and
// well before the heavy imports, exactly where the block used to sit. Every
// module the uninstall touches is still imported off PKG_ROOT at the moment it
// is needed, so `--uninstall` loads only what it uses and starts nothing.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PRODUCT } from "../../src/server/brand.mjs";
import { COMMAND, PKG_ROOT } from "./package.js";
import { G } from "./screen.js";
import { removedRecord } from "./login-item.js";
import { sayGoodbye } from "./leaving.js";

/**
 * Remove this deck's hooks and its login item, stop every deck still running
 * and, with `flags.purge`, remove the files holding its LAN private key — and
 * say what happened to each.
 *
 * Resolves to the exit code rather than exiting, so the caller owns the
 * process: 1 when any half of it refused, 0 otherwise.
 */
export async function uninstall(flags) {
  const { uninstallHooks, hasCodexInstalled } = await import(pathToFileURL(join(PKG_ROOT, "src/server/installer.mjs")).href);
  // Anything that could not be taken out. An uninstall that removed nothing
  // because it could not read the file has not uninstalled anything, and both
  // the wording and the exit code have to say so: a user who is told it worked
  // and still has our hooks firing on every event is worse off than one who is
  // told it failed, because they have stopped looking.
  let refused = false;
  // Files already reported as unparseable. The Claude hooks and the sound hook
  // live in the SAME settings.json, so a stray comma refuses both, and printing
  // the whole path-plus-parser-error twice buries the one line that differs —
  // which of our two installations is still in there.
  const named = new Set();
  // The screen's dash, by the name every line below uses: bin/cli/screen.js
  // answers it when it loads, so it is there before the boot draws anything.
  const { dash: gDash } = G;
  /** Report one provider's outcome. `ok` first — see uninstallHooks. */
  const report = (res, label) => {
    if (res.ok === false) {
      refused = true;
      named.add(res.settingsPath);
      console.error(`${PRODUCT}: ${label} hooks NOT removed ${gDash} ${res.settingsPath} could not be read as JSON (${res.why}).`);
      console.error(`${PRODUCT}: the __agent-dag hook entries are still in that file and keep firing on every ${label} event.`);
      return;
    }
    console.log(res.changed
      ? `${PRODUCT}: hooks removed from ${res.settingsPath}`
      : `${PRODUCT}: no ${label} hooks to remove`);
  };
  report(await uninstallHooks({ provider: "claude" }), "Claude");
  // The old finish sound was a second entry in the same file, marked
  // __agent-dag-sound rather than __agent-dag, and uninstallHooks does not know
  // that mark — so it used to be left behind, playing on every turn after the
  // deck was supposedly gone. #704 retired the mechanism outright, but the entry
  // is still on every machine that had it, so removing it is still this
  // command's job. So is the other half: turning the sound on parked the user's
  // own afplay/PowerShell Stop hooks, and once the deck is uninstalled nothing
  // else on the machine knows where they went.
  // The login item goes too, and this is the one place the uninstall's
  // documented narrowness has to bend. "Hook entries only" is right for the
  // event log and the port registry, which are data somebody may still want —
  // but a login item left behind after an uninstall is not data, it is a
  // machine that keeps starting a deck whose hooks were just removed.
  {
    const svc = await import(pathToFileURL(join(PKG_ROOT, "src/server/login-service.mjs")).href);
    const { deckDataDir: dataDir } = await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-home.mjs")).href);
    if (svc.readServiceRecord(dataDir()) !== null) {
      const gone = svc.uninstallService();
      svc.writeServiceRecord(dataDir(), removedRecord());
      // Silent when there was nothing on the machine: an uninstall that reports
      // removing a login item this deck never had is the same lie the explicit
      // command used to tell, in the place a reader is least able to check it.
      if (!gone.ok) {
        // `gDash`, not an em dash: this runs before the boot, on a console that
        // may be the legacy Windows one, and #797 is the rule that a printed
        // string never carries punctuation the terminal may not have.
        console.error(`${PRODUCT}: could NOT remove the login item ${gDash} ${gone.reason} (${gone.path})`);
      } else if (gone.existed) {
        console.log(`${PRODUCT}: no longer starts at login`);
      }
      if (!gone.ok) refused = true;
    }
  }

  const { retireSoundHook } = await import(pathToFileURL(join(PKG_ROOT, "src/server/retire-sound-hook.mjs")).href);
  const sound = await retireSoundHook();
  if (sound.removed) console.log(`${PRODUCT}: sound hook removed`);
  if (sound.restored) console.log(`${PRODUCT}: restored ${sound.restored} of your own sound hook(s)`);
  if (sound.ok === false) {
    refused = true;
    // Two different refusals, and saying the wrong one sends the user to the
    // wrong file. `settings_unreadable` means nothing was touched at all — and
    // when the forwarders already named that same file, the whole path and
    // parser error would only bury the one line that differs. `parked_unreadable`
    // is the other file: our entry IS out (the lines above said so), and what is
    // still owed is the user's own hooks, which stay parked until they repair it.
    if (sound.reason === "settings_unreadable") {
      console.error(named.has(sound.settingsPath)
        ? `${PRODUCT}: the sound hook is still in that file too.`
        // `gDash`, like every other line here (#797, #1431).
        : `${PRODUCT}: sound hook left in place ${gDash} ${sound.message}`);
      named.add(sound.settingsPath);
    } else {
      console.error(`${PRODUCT}: your own sound hooks were NOT restored ${gDash} ${sound.message}`);
    }
  }
  if (await hasCodexInstalled()) {
    report(await uninstallHooks({ provider: "codex" }), "Codex");
  }
  // ── THE DECKS STILL RUNNING ────────────────────────────────────────────────
  //
  // Since 3.20 the deck runs in the background, and an uninstall that left it
  // running was undone by it (#1736). On an npx install the idle auto-update
  // relaunches through `npx -y ccdeck@latest`, which is a new supervisor and a
  // full first boot, and a first boot installs every hook again — the argument
  // the login item above is removed on, made by the deck itself. With --purge it
  // also went on pairing and answering peers under a key the user had just been
  // told was deleted.
  //
  // HERE, and the position is the point: after every hook is out, and before
  // --purge takes the key files, so no deck is left running to write them back.
  if (!(await stopLiveDecks())) refused = true;
  // The reporter the goodbye at the end goes out through, loaded HERE rather
  // than where it is used. Importing reports.mjs is what reads prefs.json into
  // memory, install id and all, and `--purge` just below deletes that file:
  // read after it, the reporter found no id, decided nothing would go out, and
  // the uninstall that most meant it was the one never counted or asked why.
  // Null when no goodbye can go out — see goodbyeReporter for why that is
  // decided before the import rather than by it.
  const reporter = await goodbyeReporter();
  // ── THE PRIVATE KEY ────────────────────────────────────────────────────────
  //
  // The one thing left on the disk that is a CREDENTIAL rather than data. Every
  // deck paired with this one has pinned the key in prefs.json, and until #959
  // nothing in this command — or in the `--help` text, or in the README's
  // uninstall paragraph — named the file, so somebody who followed the
  // instructions to the letter believed the machine was clean and it was not.
  //
  // NAMED, NOT REMOVED, unless somebody asked. prefs.json also holds the
  // pairings, the aliases and which accounts this deck offers, and deleting a
  // user's settings out from under a command documented as "hook entries only"
  // is a different complaint of the same size. So the default is to say exactly
  // where the key is — resolved for THIS machine, both copies, because
  // `migrateDeckFiles` copies rather than moves and the old one is in a
  // directory nothing calls the deck's state — and `--purge` is the sentence
  // somebody types when they mean it.
  {
    const { keyDirs, findKeyFiles, purgeKeyFiles } =
      await import(pathToFileURL(join(PKG_ROOT, "src/server/purge-key.mjs")).href);
    const found = await findKeyFiles(keyDirs());
    if (flags.purge) {
      const { removed, failed } = await purgeKeyFiles(found);
      for (const path of removed) console.log(`${PRODUCT}: removed ${path}`);
      for (const f of failed) {
        refused = true;
        // `gDash`, not an em dash: before the boot, possibly the legacy Windows
        // console (#797).
        console.error(`${PRODUCT}: could NOT remove ${f.path} ${gDash} ${f.why}`);
        console.error(`${PRODUCT}: this deck's LAN private key is still in that file.`);
      }
      if (removed.length === 0 && failed.length === 0) {
        console.log(`${PRODUCT}: no ${PRODUCT} state to purge`);
      }
    } else {
      // "no-key" files are not mentioned. Telling somebody their private key is
      // on the machine when the file has none is the same defect as the silence,
      // pointing the other way. "unknown" IS mentioned: an unparseable file is
      // the one nobody can rule a key out of.
      const holding = found.filter(f => f.holds !== "no-key");
      if (holding.length > 0) {
        console.log(`${PRODUCT}: this deck's LAN private key is still on this machine:`);
        for (const f of holding) {
          console.log(`${PRODUCT}:   ${f.path}${f.holds === "unknown" ? `  (unreadable ${gDash} ${f.why})` : ""}`);
        }
        console.log(`${PRODUCT}: every deck you paired with has pinned that key. \`${COMMAND} --uninstall --purge\` removes the file(s) above.`);
      }
    }
  }

  // The remedy last and once, after every symptom above it, rather than once
  // per refusal in the middle of the list.
  if (named.size > 0) {
    console.error(`${PRODUCT}: repair the JSON (or move the file aside), then run \`${COMMAND} --uninstall\` again.`);
  }

  // Last, once everything above is done, and only while reports are on: the
  // usage reports hear that this install left, with a reason if the person at
  // the terminal picks one. See bin/cli/leaving.js, and the reporter's own
  // comment above the key section for why it was loaded there.
  await sayGoodbye({ reporter });
  // Non-zero when any half of it refused, so `ccdeck --uninstall && …` and every
  // CI step that runs this stops on the failure instead of continuing past it.
  return refused ? 1 : 0;
}

/**
 * The usage reporter the goodbye goes out through, with the install id already
 * read into memory — or null, when no goodbye can go out.
 *
 * NOT A BARE IMPORT. Importing reports.mjs reads prefs.json with the deck's own
 * boot read (prefs-state.mjs), and that read MOVES ASIDE a file it cannot parse
 * or that another user owns, and announces that the deck is starting with fresh
 * settings. In an uninstall that is a rename, under the user, of the very file
 * the key section names as the one to remove, by a command that promises to
 * leave their data where it is. So with reports vetoed nothing is read at all,
 * and otherwise the file is read here first, touching nothing: a file the boot
 * read would not take as it is has no install id to say goodbye under either.
 */
async function goodbyeReporter() {
  const { normalise, prefsPath, reportsVetoed } =
    await import(pathToFileURL(join(PKG_ROOT, "src/server/deck-prefs.mjs")).href);
  if (reportsVetoed(process.env)) return null;
  const { stripBom } = await import(pathToFileURL(join(PKG_ROOT, "src/server/atomic-write.mjs")).href);
  try {
    normalise(JSON.parse(stripBom(await readFile(prefsPath(), "utf8"))));
  } catch {
    return null;
  }
  const { reporter } = await import(pathToFileURL(join(PKG_ROOT, "src/server/reports.mjs")).href);
  // willReport() waits for the import's read, so the id is held from here on.
  await reporter.willReport();
  return reporter;
}

/**
 * Stop every live deck on this machine, one line per deck, and answer whether
 * all of them went.
 *
 * `--stop`'s own list and its own ladder — liveDecks, which challenges every
 * record, and stopDeck, which asks, then signals, then kills — so the two
 * commands cannot disagree about which decks exist or how one is ended. Silent
 * when none is running. A stop that throws is one that failed, never a reason
 * for the rest of the uninstall not to happen.
 */
export async function stopLiveDecks({
  list = async () => (await import(pathToFileURL(join(PKG_ROOT, "src/server/running-deck.mjs")).href)).liveDecks(),
  stop = async (d) => (await import(pathToFileURL(join(PKG_ROOT, "src/server/stop-deck.mjs")).href)).stopDeck(d),
  out = (line) => console.log(line),
  err = (line) => console.error(line),
} = {}) {
  const decks = await list().catch(() => []);
  let all = true;
  for (const d of decks) {
    const res = await stop(d).catch((e) => ({ ok: false, reason: e?.message ?? String(e) }));
    if (res?.ok) {
      out(`${PRODUCT}: stopped the deck on port ${d.port} (pid ${d.pid})`);
      continue;
    }
    all = false;
    // `G.dash`, like every other line here (#797).
    err(`${PRODUCT}: could NOT stop the deck on port ${d.port} (pid ${d.pid}) ${G.dash} ${res?.reason ?? "unknown"}; while it runs it can put the hooks back.`);
  }
  return all;
}
