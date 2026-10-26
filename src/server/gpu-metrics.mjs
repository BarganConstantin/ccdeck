// shortcut: NVIDIA via nvidia-smi only; add another backend when AMD/Intel support is needed.
import { run } from "./metrics-run.mjs";

const INTERVAL_MS = 3_000;
const TIMEOUT_MS = 2_000;
const GIVE_UP = 3;
const QUERY = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw",
  "--format=csv,noheader,nounits",
];

let timer = null;
let generation = 0;
let inFlight = false;
let misses = 0;
let everAnswered = false;
let gpus = null;

function numberOrNull(value, min = 0, max = Infinity) {
  const text = value.trim();
  if (!text || /^(?:n\/a|not supported|\[not supported\]|-)$/i.test(text)) return null;
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null;
  const n = Number(text);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function csvFields(line) {
  const fields = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (char === "," && !quoted) {
      fields.push(field.trim());
      field = "";
    } else field += char;
  }
  if (quoted) return null;
  fields.push(field.trim());
  return fields;
}

export function parseNvidiaSmi(text) {
  if (typeof text !== "string") return null;
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const fields = csvFields(line);
    if (!fields || fields.length !== 7) continue;
    const index = numberOrNull(fields[0], 0, Number.MAX_SAFE_INTEGER);
    const name = fields[1].trim();
    if (index == null || !Number.isInteger(index) || !name) continue;
    rows.push({
      index, name,
      utilization: numberOrNull(fields[2], 0, 100),
      memoryUsedMiB: numberOrNull(fields[3]),
      memoryTotalMiB: numberOrNull(fields[4]),
      temperatureC: numberOrNull(fields[5]),
      powerW: numberOrNull(fields[6]),
    });
  }
  return rows.length ? rows : null;
}

export function gpuSnapshot() { return gpus; }

async function sample(generationAtStart) {
  if (inFlight || (!everAnswered && misses >= GIVE_UP)) return;
  inFlight = true;
  let next = null;
  try { next = parseNvidiaSmi(await run("nvidia-smi", QUERY, TIMEOUT_MS)); }
  catch { /* no current reading */ }
  try {
    if (generation !== generationAtStart) return;
    gpus = next;
    if (next) {
      everAnswered = true;
      misses = 0;
    } else {
      misses++;
      if (!everAnswered && misses >= GIVE_UP && timer) {
        clearInterval(timer);
        timer = null;
      }
    }
  } finally {
    if (generation === generationAtStart) inFlight = false;
  }
}

export function startGpuTimer() {
  if (timer || (!everAnswered && misses >= GIVE_UP)) return;
  const current = generation;
  void sample(current);
  timer = setInterval(() => { void sample(current); }, INTERVAL_MS);
  timer.unref?.();
}

export function stopGpu() {
  if (timer) clearInterval(timer);
  timer = null;
  generation++;
  inFlight = false;
  misses = 0;
  everAnswered = false;
  gpus = null;
}
