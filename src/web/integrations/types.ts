// The page's half of the integrations contract (#2178, #2179): what a
// connection is, what the host hands a provider's panel, and what a provider
// gives the host. registry.ts holds the providers; the server's half is
// src/server/integrations/registry.mjs.
import type { ComponentType, ReactNode } from "react";

export type IntegrationKind = "jira" | "github" | "gitlab";

/** What can go wrong, as the server says it (src/server/integrations/errors.mjs).
 *  `invalid` is a form or a parameter the deck refused; `network` is the
 *  page failing to reach the deck at all. */
export type IntegrationErrorKind =
  | "auth" | "expired" | "permission" | "unreachable" | "tls" | "rate-limit" | "incompatible"
  | "not-found" | "upstream" | "invalid" | "network";

export interface IntegrationAccount {
  id: string;
  login: string;
  name: string;
  /** Loadable as it is: the deck's asset route, a public https image, or "". */
  avatarUrl: string;
}

export interface IntegrationMeta {
  scopes?: string[];
  serverVersion?: string;
  deployment?: string;
  warnings?: string[];
  [key: string]: unknown;
}

/** One connection, as the deck answers it. Never a token: only whether one is
 *  saved. */
export interface IntegrationConnection {
  id: string;
  kind: IntegrationKind;
  name: string;
  baseUrl: string;
  account: IntegrationAccount;
  meta: IntegrationMeta;
  allowedOrigins: string[];
  createdAt: string;
  updatedAt: string;
  tokenSaved: boolean;
}

/** A panel's own memory, kept per browser for one connection
 *  (`${kind}:${connId}`) through storage.ts. A value read back is whatever the
 *  store held, so it is checked, never cast. */
export interface IntegrationPrefs {
  read<T>(key: string, check: (value: unknown) => value is T): T | undefined;
  write(key: string, value: unknown): void;
}

/** What the host hands a provider's panel. The host draws the frame and the
 *  header — the provider's glyph and name, the connection selector, Close —
 *  and the panel everything under it, its own toolbar included. */
export interface IntegrationPanelProps {
  /** The connection on show. A new one remounts the panel. */
  connection: IntegrationConnection;
  /** Every connection of this kind, in the order they were made. */
  connections: IntegrationConnection[];
  /** A request under /api/integrations/<kind>/<connId>/: `api("board/1")`. */
  api(path: string, init?: RequestInit): Promise<Response>;
  /** An image the tracker serves, as the page loads it: the asset route. */
  assetUrl(url: string): string;
  prefs: IntegrationPrefs;
  /** Under ~900px: the detail is a screen of its own (IntegrationSplit). */
  narrow: boolean;
  /** Settings → Integrations, at this connection: the way back from a refused
   *  or expired token. */
  onReconnect(): void;
}

/** One field of a provider's connect form, drawn by the host's form. */
export interface FieldDef {
  /** The key in the input the server's parseInput reads. */
  name: string;
  label: string;
  /** "choice" is a segmented control over `options`. */
  type: "text" | "url" | "email" | "password" | "choice";
  options?: readonly { value: string; label: string }[];
  placeholder?: string;
  /** One line under the field. */
  hint?: string;
  /** Shown only while another field has one of these values. */
  when?: { field: string; is: readonly string[] };
  /** Labels, placeholders and hints that depend on another field's value. */
  variants?: { field: string; by: Readonly<Record<string, Partial<Pick<FieldDef, "label" | "placeholder" | "hint">>>> };
  /** Part of the saved secret: left blank on an edit, the saved one stays —
   *  and the field is never filled in. */
  secret?: boolean;
  optional?: boolean;
  autoComplete?: string;
  /** The value a new form starts with, or one read off the connection being
   *  edited (never a secret). */
  initial?: (existing?: IntegrationConnection) => string;
}

export interface IntegrationWebDef {
  kind: IntegrationKind;
  label: string;
  /** The rail's 13px glyph (rail-glyphs.tsx's spec), monochrome. */
  Glyph: ComponentType;
  /** One key that opens the panel once a connection exists: "I". */
  shortcut?: string;
  /** The rail hint's second line. */
  detail?: string;
  /** One line under the provider's name in Add integration. */
  blurb?: string;
  fields: readonly FieldDef[];
  /** What the token is and where to make one, under the fields. Drawn inside
   *  the form, so it can read the values typed so far (useIntegrationForm). */
  tokenHelp: ReactNode;
  Panel: ComponentType<IntegrationPanelProps>;
}
