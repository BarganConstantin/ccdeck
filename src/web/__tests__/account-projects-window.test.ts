import { describe, expect, it } from "vitest";
import { emptyWindowSentence, showsDayChart, widerWindow, windowPhrase } from "../account-projects-window";

describe("the Projects report's windows in words", () => {
  it("names each window the way a sentence needs it", () => {
    expect(windowPhrase(1)).toBe("today");
    expect(windowPhrase(7)).toBe("the last 7 days");
    expect(windowPhrase(0)).toBe("all time");
  });

  it("says an empty today is not over yet, and never 'in today'", () => {
    expect(emptyWindowSentence(1)).toBe("No work attributed to this account yet today.");
    expect(emptyWindowSentence(30)).toBe("No work attributed to this account in the last 30 days.");
  });

  it("offers the next wider window from an empty one, and nothing from all time", () => {
    expect(widerWindow(1)).toBe(7);
    expect(widerWindow(7)).toBe(30);
    expect(widerWindow(30)).toBe(0);
    expect(widerWindow(0)).toBeNull();
  });

  it("drops the by-day chart for today, where its one bar repeats the total", () => {
    expect(showsDayChart(1, 1)).toBe(false);
    expect(showsDayChart(7, 1)).toBe(true);
    expect(showsDayChart(7, 0)).toBe(false);
  });
});
