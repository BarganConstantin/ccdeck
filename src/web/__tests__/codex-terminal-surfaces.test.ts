import { describe, expect, it } from 'vitest';
import { codexTerminalSurfaces } from '../codex-terminal-surfaces';

const enc = new TextEncoder(), dec = new TextDecoder();
const band = '\x1b[48;5;237m';
const composer = '\x1b[48;2;54;55;57m'; // Captured from an actual native Codex TUI.
const display = (chunks: string[]) => {
  const filter = codexTerminalSurfaces();
  return chunks.map(chunk => dec.decode(filter.write(enc.encode(chunk)))).join('');
};

describe('native Codex surfaces follow the terminal palette', () => {
  it('uses a theme-owned band for the composer and submitted prompts', () => {
    expect(display([`${composer}Ask Codex\x1b[49m\r\n${composer}Submitted prompt\x1b[0m`]))
      .toBe(`${band}Ask Codex\x1b[49m\r\n${band}Submitted prompt\x1b[0m`);
    expect(display(['\x1b[48;2;244;244;242mLight-started prompt\x1b[0m']))
      .toBe(`${band}Light-started prompt\x1b[0m`);
  });

  it('works at every stream boundary, including colon SGR and combined attributes', () => {
    const input = '\x1b[1;38;2;48;2;54;48;2;54;55;57;4mText';
    const expected = '\x1b[1;38;2;48;2;54;48;5;237;4mText';
    for (let i = 0; i <= input.length; i++) expect(display([input.slice(0, i), input.slice(i)])).toBe(expected);
    expect(display(['\x1b[48:2::54:55:57mText'])).toBe(`${band}Text`);
  });

  it('keeps foregrounds, colored fills, indexed colors and terminal controls intact', () => {
    const input = '\x1b[38;2;54;55;57mSyntax\x1b[48;2;20;80;40mDiff\x1b[48;5;22m\x1b[0m\x1b[2J\x1b[?25l';
    expect(display([input])).toBe(input);
  });

  it('keeps dim prompt text readable on the band and restores native dimming afterwards', () => {
    expect(display([`${composer}\x1b[2mPlaceholder\x1b[49mOutside\x1b[22m`]))
      .toBe(`${band}\x1b[22mPlaceholder\x1b[49;2mOutside\x1b[22m`);
    expect(display([`\x1b[1;2m${composer}Bold prompt\x1b[0m`]))
      .toBe(`\x1b[1;2m\x1b[48;5;237;22;1mBold prompt\x1b[0m`);
    expect(display(['\x1b[2mDim normal output\x1b[22m'])).toBe('\x1b[2mDim normal output\x1b[22m');
  });

  it('never interprets a color-looking sequence inside OSC or DCS strings', () => {
    for (const input of [`\x1b]0;${composer}Title\x07`, `\x1bPq${composer}\x07data\x1b\\`]) {
      for (let i = 0; i <= input.length; i++) expect(display([input.slice(0, i), input.slice(i)])).toBe(input);
    }
  });

  it('preserves split UTF-8 bytes and bounds incomplete escape sequences', () => {
    const filter = codexTerminalSurfaces(), bytes = enc.encode(`${composer}Bună 😀`);
    const output = Array.from(bytes).flatMap(byte => [...filter.write(Uint8Array.of(byte))]);
    expect(dec.decode(Uint8Array.from(output))).toBe(`${band}Bună 😀`);
    const oversized = '\x1b[' + '1;'.repeat(1000) + 'm';
    expect(display([oversized, composer])).toBe(oversized + band);
  });

  it('drops an incomplete sequence when a fresh terminal seed begins', () => {
    const filter = codexTerminalSurfaces();
    filter.write(enc.encode('\x1b[48;2;54;'));
    filter.reset();
    expect(dec.decode(filter.write(enc.encode('Fresh seed')))).toBe('Fresh seed');
  });
});
