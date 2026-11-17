// Codex caches its startup paper and paints prompt/composer bands as RGB.
// Keep those near-neutral fills in the terminal's existing theme-aware band
// slot (a quiet control wash), so old messages follow a theme flip too.
// Foregrounds and
// chromatic backgrounds stay native. Used only for Codex display output.
// See openai/codex, codex-rs/tui/src/{style,terminal_palette}.rs.
const encoder = new TextEncoder();

export function codexTerminalSurfaces() {
  const sgr = surfaceSgr();
  let state: 'text' | 'escape' | 'csi' | 'csi-pass' | 'string' | 'string-escape' = 'text';
  let pending: number[] = [];
  let osc = false;
  const reset = () => { state = 'text'; pending = []; osc = false; sgr.reset(); };
  return {
    reset,
    write(bytes: Uint8Array): Uint8Array {
      if (state === 'text' && !bytes.includes(27)) return bytes;
      const out: number[] = [];
      for (const byte of bytes) {
        if (state === 'string' || state === 'string-escape') {
          out.push(byte);
          if (osc && byte === 7 || state === 'string-escape' && byte === 92) state = 'text';
          else state = byte === 27 ? 'string-escape' : 'string';
        } else if (state === 'text') {
          if (byte === 27) { pending = [byte]; state = 'escape'; }
          else out.push(byte);
        } else if (state === 'escape') {
          pending.push(byte);
          if (byte === 91) state = 'csi';
          else {
            out.push(...pending); pending = [];
            osc = byte === 93;
            state = [80, 88, 93, 94, 95].includes(byte) ? 'string' : 'text';
          }
        } else if (state === 'csi-pass') {
          out.push(byte);
          if (byte >= 64 && byte <= 126 || byte === 24 || byte === 26) state = 'text';
        } else {
          pending.push(byte);
          if (byte >= 64 && byte <= 126) {
            const mapped = byte === 109 ? sgr.map(String.fromCharCode(...pending.slice(2, -1))) : null;
            if (mapped === null) out.push(...pending);
            else out.push(...encoder.encode(`\x1b[${mapped}m`));
            pending = []; state = 'text';
          } else if (pending.length >= 128 || byte === 24 || byte === 26) {
            out.push(...pending); pending = [];
            state = byte === 24 || byte === 26 ? 'text' : 'csi-pass';
          }
        }
      }
      return Uint8Array.from(out);
    },
  };
}

function neutralBand(rgb: string[]): boolean {
  if (!rgb.every(n => /^\d{1,3}$/.test(n) && Number(n) <= 255)) return false;
  const values = rgb.map(Number), lo = Math.min(...values), hi = Math.max(...values);
  // Dark/pale near-neutral chrome only; colored diff and selection fills
  // and mid-tone image/syntax backgrounds are not theme surfaces.
  return hi - lo <= 20 && (hi <= 128 || lo >= 192);
}

function surfaceSgr() {
  let bold = false, dim = false, band = false;
  return {
    reset() { bold = dim = band = false; },
    map(params: string): string | null {
      const parts = params.split(';'), out: string[] = [];
      // xterm deliberately halves its contrast floor for DIM. The prompt
      // must remain readable on a theme-owned band, with DIM restored when
      // that band ends. SGR 22 clears bold too, so retain it when requested.
      const intensity = () => band ? ['22', ...(bold ? ['1'] : [])] : ['2'];
      const background = (next: boolean) => {
        if (band !== next && dim) { band = next; out.push(...intensity()); }
        else band = next;
      };
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const colon = /^48:2:(?::|0:)?(\d+):(\d+):(\d+)$/.exec(p);
        if (colon) {
          const neutral = neutralBand(colon.slice(1));
          out.push(neutral ? '48;5;237' : p); background(neutral);
        } else if (['38', '48', '58'].includes(p) && parts[i + 1] === '2' && i + 4 < parts.length) {
          const neutral = p === '48' && neutralBand(parts.slice(i + 2, i + 5));
          out.push(...(neutral ? ['48;5;237'] : parts.slice(i, i + 5)));
          if (p === '48') background(neutral);
          i += 4;
        } else if (['38', '48', '58'].includes(p) && parts[i + 1] === '5' && i + 2 < parts.length) {
          out.push(...parts.slice(i, i + 3));
          if (p === '48') background(Number(parts[i + 2]) >= 232 && Number(parts[i + 2]) <= 239);
          i += 2;
        } else if (p === '2') { dim = true; out.push(...(band ? intensity() : [p])); }
        else {
          out.push(p);
          if (p === '0' || p === '') bold = dim = band = false;
          else if (p === '1') bold = true;
          else if (p === '22') bold = dim = false;
          else if (p === '49' || /^4\d$|^10\d$/.test(p)) background(false);
        }
      }
      const mapped = out.join(';');
      return mapped === params ? null : mapped;
    },
  };
}
