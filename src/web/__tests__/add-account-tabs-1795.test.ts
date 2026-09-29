// #1795: the add-account dialog's two tabs shared one `error` and one `busy`.
// A sign-in that failed to start printed its reason under the empty paste field,
// as if a paste had failed; and an import on the paste tab cleared that error,
// which left the Sign in tab on "Asking the claude CLI for a sign-in link…" with
// no button and nothing polling — only closing the dialog got out. An import
// that failed instead became the sign-in's "Sign-in failed" reason.
//
// What these pin: each tab shows only its own error and its own request in
// flight. Which branch the Sign in tab draws is login-flow.ts's loginTabView,
// which is handed the sign-in's error and request and nothing of the paste's;
// the placeholder is drawn only while a sign-in request is out or the server's
// flow is still moving; and the dialog keeps the two journeys' state apart.
import { describe, expect, it } from "vitest";
import { loginTabView } from "../login-flow";
import { sourceOf } from "./client-source";

const idle = { login: null, started: false, loginError: null, loginBusy: false };

describe("loginTabView", () => {
  it("keeps a sign-in that failed to start on its ending, with Try again", () => {
    expect(loginTabView({ login: null, started: true, loginError: "x", loginBusy: false })).toBe("ended");
  });

  it("never leaves a started sign-in on the placeholder with nothing in flight", () => {
    // The state the paste tab's import used to leave behind: the shared error
    // cleared, no login from the server, no request out. Nothing would ever
    // move it on.
    expect(loginTabView({ login: null, started: true, loginError: null, loginBusy: false })).not.toBe("asking");
  });

  it("asks only while a sign-in request is out or the server's flow is moving", () => {
    expect(loginTabView({ ...idle, started: true, loginBusy: true })).toBe("asking");
    expect(loginTabView({ ...idle, started: true, login: { state: "awaiting_url", account: null } })).toBe("asking");
    // Try again after a failure: the error is still set until the answer lands,
    // and the request is what is drawn.
    expect(loginTabView({ ...idle, started: true, loginError: "x", loginBusy: true })).toBe("asking");
  });

  it("draws the server's own ending, the code step and the success card", () => {
    expect(loginTabView({ ...idle, started: true, login: { state: "idle", account: null } })).toBe("ended");
    expect(loginTabView({ ...idle, started: true, login: { state: "failed", account: null } })).toBe("ended");
    expect(loginTabView({ ...idle, started: true, login: { state: "awaiting_code", account: null } })).toBe("code");
    // A rejected code does not end the sign-in: the CLI is still asking.
    expect(loginTabView({ ...idle, started: true, loginError: "x", login: { state: "awaiting_code", account: null } }))
      .toBe("code");
    expect(loginTabView({ ...idle, started: true, login: { state: "registering", account: null } })).toBe("code");
    expect(loginTabView({ ...idle, started: true, login: { state: "done", account: { num: "3" } } })).toBe("done");
  });

  it("opens on the primer, which is what nothing started looks like", () => {
    expect(loginTabView(idle)).toBe("primer");
  });
});

describe("the dialog keeps the two journeys apart", () => {
  const src = sourceOf("components/AddAccountDialog.tsx");

  it("has an error and a request in flight per tab, and no shared one", () => {
    expect(src).toMatch(/const \[loginError, setLoginError\] = useState<string \| null>\(null\);/);
    expect(src).toMatch(/const \[pasteError, setPasteError\] = useState<string \| null>\(null\);/);
    expect(src).not.toMatch(/const \[error, setError\]/);
    expect(src).not.toMatch(/\bsetError\(/);
    expect(src).toMatch(/const \[loginBusy, setLoginBusy\] = useState\(false\);/);
    expect(src).toMatch(/const \[pasteBusy, setPasteBusy\] = useState\(false\);/);
    expect(src).not.toMatch(/\bsetBusy\(/);
  });

  it("lets only the import write the paste tab's error, and only the sign-in the Sign in tab's", () => {
    const body = (name: string) => {
      const at = src.indexOf(`const ${name} = useCallback(`);
      expect(at, name).toBeGreaterThan(-1);
      return src.slice(at, src.indexOf("}, [", at));
    };
    for (const name of ["start", "submitCode"]) {
      expect(body(name), name).toMatch(/setLoginError\(/);
      expect(body(name), name).not.toMatch(/setPasteError\(|setPasteBusy\(/);
    }
    expect(body("submitBlob")).toMatch(/setPasteError\(/);
    expect(body("submitBlob")).not.toMatch(/setLoginError\(|setLoginBusy\(/);
    expect(body("forceOne")).not.toMatch(/setLoginError\(|setLoginBusy\(/);
  });

  it("prints the paste's error under the paste field and the sign-in's on the Sign in tab", () => {
    expect(src).toMatch(/\{pasteError && <p className="aa-err">\{pasteError\}<\/p>\}/);
    expect(src).toMatch(/\{\(loginError \|\| login\.error\) && <p className="aa-err">\{loginError \?\? login\.error\}<\/p>\}/);
    expect(src).toMatch(/localError: loginError \}\)/);
    // And the Import button's label says only an import is out.
    expect(src).toMatch(/\{pasteBusy \? "importing…" : "Import"\}/);
  });

  it("chooses the Sign in tab's branch through loginTabView, off the sign-in's own state", () => {
    expect(src).toMatch(
      /loginTabView\(\{ login, started: startedRef\.current, loginError, loginBusy \}\)/);
  });
});
