// The pixels of a tracked PNG, for the cases that have to measure the art
// rather than trust a source drawing beside it.
//
// The icons under src/web/public/ are copied unchanged from the brand kit,
// which ships no editable source for them, so what the browser receives is
// the only thing there is to measure. Deliberately narrow: 8-bit RGB or RGBA,
// not interlaced — the kit's own exports — and anything else fails loudly
// instead of being decoded wrong.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

export interface Pixels {
  width: number;
  height: number;
  channels: 3 | 4;
  /** Row-major, `channels` bytes per pixel, no filter bytes. */
  data: Uint8Array;
}

const SIGNATURE = "89504e470d0a1a0a";
const CHANNELS: Record<number, 3 | 4> = { 2: 3, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function pngPixels(path: string): Pixels {
  const buf = readFileSync(path);
  if (buf.subarray(0, 8).toString("hex") !== SIGNATURE) throw new Error(`${path} is not a PNG`);
  let width = 0, height = 0, channels: 3 | 4 | undefined;
  const idat: Buffer[] = [];
  for (let at = 8; at < buf.length;) {
    const length = buf.readUInt32BE(at);
    const kind = buf.subarray(at + 4, at + 8).toString("latin1");
    const body = buf.subarray(at + 8, at + 8 + length);
    if (kind === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const [depth, colour, , , interlace] = body.subarray(8, 13);
      channels = CHANNELS[colour];
      if (depth !== 8 || !channels || interlace !== 0) {
        throw new Error(`${path}: only 8-bit RGB/RGBA, non-interlaced, is decoded here`);
      }
    } else if (kind === "IDAT") {
      idat.push(body);
    }
    at += 12 + length;
  }
  if (!channels) throw new Error(`${path} has no IHDR`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const left = x >= channels ? data[y * stride + x - channels] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= channels ? data[(y - 1) * stride + x - channels] : 0;
      const predictor = [0, left, up, (left + up) >> 1, paeth(left, up, upLeft)][filter];
      if (predictor === undefined) throw new Error(`${path}: unknown PNG filter ${filter}`);
      data[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return { width, height, channels, data };
}
