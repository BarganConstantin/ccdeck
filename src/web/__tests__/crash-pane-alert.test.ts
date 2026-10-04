// The crash pane's alert holds the crash message, and not the report dialog.
//
// role="alert" is an assertive live region, read out whole whenever anything
// in it changes. It sat on the pane's outermost box, and Send report opens its
// feedback dialog inside that box, so the whole dialog — the kinds, the
// question, the facts, the buttons — was added to the alert and read out over
// the dialog's own announcement, and every later change in it, the "Write
// something first." error or the sending status, interrupted the person again.
// The alert is the card that says what happened now, and the dialog opens
// beside it.
//
// The pane is drawn by react-dom/server from the boundary's own render, with
// the report open, and the markup is read for where the dialog landed.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import ErrorBoundary from "../components/ErrorBoundary";

/** Each element with role="alert": where it starts and ends in `html`. */
function alertsIn(html: string): Array<{ start: number; end: number; text: string }> {
  const found: Array<{ start: number; end: number; text: string }> = [];
  for (let at = html.indexOf('role="alert"'); at !== -1; at = html.indexOf('role="alert"', at + 1)) {
    const start = html.lastIndexOf("<", at);
    const tag = /^<([a-z0-9]+)/.exec(html.slice(start))![1];
    const tags = new RegExp(`<(/?)${tag}\\b[^>]*>`, "g");
    tags.lastIndex = start;
    let depth = 0;
    let end = html.length;
    for (let m = tags.exec(html); m; m = tags.exec(html)) {
      depth += m[1] ? -1 : 1;
      if (depth === 0) {
        end = m.index + m[0].length;
        break;
      }
    }
    found.push({ start, end, text: html.slice(start, end).replace(/<[^>]+>/g, " ") });
  }
  return found;
}

function crashPane(reportOpen: boolean): string {
  const boundary = new ErrorBoundary({ children: null });
  boundary.state = { error: new Error("Cannot read properties of undefined (reading 'agents')"), componentStack: null, reportOpen };
  return renderToStaticMarkup(boundary.render() as ReactElement);
}

describe("the crash pane's alert", () => {
  it("says what happened", () => {
    const alerts = alertsIn(crashPane(false));
    expect(alerts.length).toBe(1);
    expect(alerts[0].text).toMatch(/Something went wrong/);
    expect(alerts[0].text).toMatch(/could not draw past/);
  });

  it("does not take in the report dialog when Send report opens it", () => {
    const html = crashPane(true);
    const dialog = html.indexOf('role="dialog"');
    expect(dialog).toBeGreaterThan(-1);
    for (const { start, end } of alertsIn(html)) {
      expect(dialog > start && dialog < end).toBe(false);
    }
  });

  it("still says what happened with the dialog open", () => {
    const alerts = alertsIn(crashPane(true));
    expect(alerts.some(a => /Something went wrong/.test(a.text))).toBe(true);
  });
});
