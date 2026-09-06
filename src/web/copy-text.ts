/**
 * Put a string on the clipboard, and say whether it landed.
 *
 * ONE COPY OF THIS, because there are now two callers — the version banner's
 * upgrade command and the Browser Watch killswitch — and both are showing the
 * user a command they are about to run in a terminal. A second hand-rolled copy
 * of the fallback ladder is exactly the class of duplication #798 was about.
 *
 * THE LADDER, AND WHY EACH RUNG IS THERE.
 *
 *   `navigator.clipboard` is undefined outside a secure context, and inside one
 *   it can sit unresolved while the browser decides on permission — which would
 *   leave the button silently dead. So the promise is RACED against a short
 *   timer rather than awaited.
 *
 *   The selection trick is the fallback. `document.execCommand("copy")` is
 *   deprecated and still works everywhere, and it needs no permission.
 *
 *   `false` is a real answer, not an error. Every caller renders the command as
 *   selectable text, so a failed copy leaves the user exactly where they were:
 *   able to select it by hand. Throwing would take the button down with it.
 */
export async function copyText(text: string, timeoutMs = 500): Promise<boolean> {
  if (!text) return false;
  let ok = false;
  try {
    ok = await Promise.race([
      navigator.clipboard?.writeText(text).then(() => true) ?? Promise.resolve(false),
      new Promise<boolean>(r => window.setTimeout(() => r(false), timeoutMs)),
    ]);
  } catch { ok = false; }
  if (ok) return true;
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand("copy");
    ta.remove();
  } catch { ok = false; }
  return ok;
}
