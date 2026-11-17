// The engine's install, as the page asks the deck about it (the server half is
// engine-install.mjs, the routes terminal-routes.mjs):
//
//   GET  /api/terminal/engine               which engine is here, an install's progress
//   POST /api/terminal/engine/install       download the pinned package and install it
//   POST /api/terminal/engine/install-file  install a package file sent as the body
//   POST /api/terminal/engine/cancel        cancel a download
//   POST /api/terminal/engine/remove        remove the installed engine
//
// The status reads only the deck's machine, never the network: a download
// starts from an Install press and nothing else. Every answer is a value, as in
// terminal-api.ts: a refusal, a network failure and the switch-off's 404 all
// come back as `{ ok: false, code }`.

export const ENGINE_ROUTES = {
  status: "/api/terminal/engine",
  install: "/api/terminal/engine/install",
  installFile: "/api/terminal/engine/install-file",
  cancel: "/api/terminal/engine/cancel",
  remove: "/api/terminal/engine/remove",
} as const;

/** Why nothing can be downloaded here: no engine for this platform, no key
 *  to check one with, no package this ccdeck pins, or downloads turned off. */
export type EngineBlock = "unsupported" | "no-keys" | "not-published" | "download-disabled";

export type EnginePhase = "downloading" | "verifying" | "installing";

/** Why an install failed: the codes engine-install.mjs answers. */
export type EngineFailureCode =
  | "offline" | "download-failed" | "not-published" | "check-failed" | "wrong-machine" | "downgrade"
  | "no-permission" | "no-space" | "elsewhere" | "failed";

export interface EngineJob {
  id: string;
  phase: EnginePhase;
  received: number;
  total: number | null;
  source: "download" | "file";
  startedAt: number;
}

export type EngineLast =
  | { id: string; outcome: "done"; version: string | null; at: number }
  | { id: string; outcome: "cancelled"; at: number }
  | { id: string; outcome: "failed"; code: EngineFailureCode; step: string; received?: number; total?: number | null; version?: string | null; at: number };

export interface EngineStatus {
  /** `<platform>-<arch>` of the deck's machine. */
  platform: string;
  /** The deck's own version, or null when it cannot say. */
  app: string | null;
  /** The data folder as `~/…`, for the one command that gives it back to its
   *  user; null where there is no such line. */
  fixPath: string | null;
  supported: boolean;
  blocked: EngineBlock | null;
  canInstallFile: boolean;
  installed: { version: string; bytes: number } | null;
  /** Something stands in the engine folder, verified or not. */
  present: boolean;
  /** The engine version this ccdeck pins, or null when it pins none. */
  pinned: string | null;
  job: EngineJob | null;
  last: EngineLast | null;
  /** An install cut short was put right a moment ago. */
  recovered: boolean;
  /** Another ccdeck on this machine is installing now. */
  elsewhere: boolean;
}

export type EngineAnswer = { ok: true; id?: string } | { ok: false; code: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A status the deck sent, or null for anything else. */
export function engineStatusOf(v: unknown): EngineStatus | null {
  if (!isObject(v) || typeof v.platform !== "string" || typeof v.supported !== "boolean") return null;
  const installed = isObject(v.installed) && typeof v.installed.version === "string"
    ? { version: v.installed.version, bytes: typeof v.installed.bytes === "number" ? v.installed.bytes : 0 }
    : null;
  const job = isObject(v.job) && typeof v.job.id === "string" && typeof v.job.phase === "string"
    ? {
      id: v.job.id,
      phase: v.job.phase as EnginePhase,
      received: typeof v.job.received === "number" ? v.job.received : 0,
      total: typeof v.job.total === "number" ? v.job.total : null,
      source: v.job.source === "file" ? "file" as const : "download" as const,
      startedAt: typeof v.job.startedAt === "number" ? v.job.startedAt : 0,
    }
    : null;
  const last = isObject(v.last) && typeof v.last.id === "string" && typeof v.last.outcome === "string" ? v.last as unknown as EngineLast : null;
  return {
    platform: v.platform,
    app: typeof v.app === "string" ? v.app : null,
    fixPath: typeof v.fixPath === "string" ? v.fixPath : null,
    supported: v.supported,
    blocked: typeof v.blocked === "string" ? v.blocked as EngineBlock : null,
    canInstallFile: v.canInstallFile === true,
    installed,
    present: v.present === true,
    pinned: typeof v.pinned === "string" ? v.pinned : null,
    job,
    last,
    recovered: v.recovered === true,
    elsewhere: v.elsewhere === true,
  };
}

type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;
const defaultFetch: FetchFn = (input, init) => fetch(input, init);

/** The engine's install state, or null when the deck cannot say (the panel
 *  is off, the deck is gone, or its engine has no installer). */
export async function engineStatus(fetchFn: FetchFn = defaultFetch): Promise<EngineStatus | null> {
  try {
    const res = await fetchFn(ENGINE_ROUTES.status, { method: "GET" });
    if (!res.ok) return null;
    const body: unknown = await res.json().catch(() => null);
    return isObject(body) && body.ok === true ? engineStatusOf(body.engine) : null;
  } catch {
    return null;
  }
}

async function act(path: string, init: RequestInit, fetchFn: FetchFn): Promise<EngineAnswer> {
  try {
    const res = await fetchFn(path, { method: "POST", ...init });
    const body: unknown = await res.json().catch(() => null);
    if (isObject(body) && body.ok === true) return { ok: true, ...(typeof body.id === "string" ? { id: body.id } : {}) };
    return { ok: false, code: isObject(body) && typeof body.code === "string" ? body.code : res.status === 404 ? "turned-off" : "failed" };
  } catch {
    return { ok: false, code: "unreachable" };
  }
}

const json = (): RequestInit => ({ headers: { "Content-Type": "application/json" }, body: "{}" });

export const installEngine = (fetchFn: FetchFn = defaultFetch) => act(ENGINE_ROUTES.install, json(), fetchFn);
export const cancelEngineInstall = (fetchFn: FetchFn = defaultFetch) => act(ENGINE_ROUTES.cancel, json(), fetchFn);
export const removeEngine = (fetchFn: FetchFn = defaultFetch) => act(ENGINE_ROUTES.remove, json(), fetchFn);
/** Sends the package file the person picked, as it is. */
export const installEngineFile = (file: Blob, fetchFn: FetchFn = defaultFetch) =>
  act(ENGINE_ROUTES.installFile, { headers: { "Content-Type": "application/octet-stream" }, body: file }, fetchFn);

/** The platform as people say it: "macOS · Apple silicon". */
export function platformLabel(platform: string): string {
  const [os, arch] = platform.split("-");
  const osName = os === "darwin" ? "macOS" : os === "win32" ? "Windows" : os === "linux" ? "Linux" : os;
  const archName = os === "darwin"
    ? (arch === "arm64" ? "Apple silicon" : arch === "x64" ? "Intel" : arch)
    : arch === "arm64" ? "ARM64" : arch === "arm" ? "ARM 32-bit" : arch === "ia32" ? "x86 32-bit" : arch;
  return archName ? `${osName} · ${archName}` : osName;
}

/** Whether `a` is older than `b`, comparing x.y.z (a pre-release counts as
 *  older than its release). False for anything it cannot read. */
export function olderVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(v);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ? 0 : 1] : null;
  };
  if (!a || !b) return false;
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

/** Megabytes with one decimal, as the bar says them. */
export const mb = (bytes: number) => (bytes / 1_000_000).toFixed(1);
