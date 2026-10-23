// A GitHub or GitLab description, as something this page may draw (#2179).
//
// Both forges render their own Markdown — GitHub's bodyHTML, GitLab's
// descriptionHtml — with what no renderer of ours could match: tables, task
// lists, references (`!5073`, `#12`), mentions, emoji, and on GitLab the link
// its Jira integration puts on `PROJ-123`. So the panel draws the forge's HTML
// rather than the Markdown under it. But that HTML is someone else's string:
// whoever can write a description can put markup in it, and an instance can
// be anyone's.
//
// A TOKEN TREE, NOT AN HTML STRING — the rule inline-markdown.ts set for this
// codebase, which has no dangerouslySetInnerHTML anywhere. The browser parses
// the forge's HTML into an inert document (DOMParser runs no script and loads
// nothing), this file walks it, and what comes out is a tree of the elements
// on an allow-list with only their allowed attributes, which ForgeHtml.tsx
// turns into React elements. Nothing is ever serialised back to HTML, so there
// is no second parse for a crafted string to change meaning in.
//
// WHAT IS KEPT. Structure and emphasis (headings, lists, tables, quotes, code,
// details), links with a web or mail scheme — made absolute, because GitLab
// writes its own as paths — task-list checkboxes, and images. Classes, ids,
// styles and every event attribute go; so does anything that runs or embeds
// (script, style, iframe, object, svg, forms) WITH its content. An element not
// on the list is unwrapped: its text stays, its tag does not.
//
// IMAGES GO THROUGH THE DECK. A private repository's attachment or a GitLab
// upload needs the token, and the page must never hold it, so an image's
// address is handed to `asset`, which returns the deck's own proxied URL for
// it (the integrations core's asset route, pinned to the connection's
// origins) — or null, and the image is drawn as a link instead.

/** What a node of the parsed document offers; a DOM Node satisfies it, and so
 *  does the plain object a test builds. */
export interface NodeLike {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<NodeLike>;
  getAttribute?(name: string): string | null;
}

export type ForgeNode =
  | { t: "text"; text: string }
  | { t: "el"; tag: string; attrs: Record<string, string>; kids: ForgeNode[] }
  | { t: "link"; href: string; title: string | null; kids: ForgeNode[] }
  | { t: "img"; src: string | null; href: string; alt: string; width: number | null; height: number | null }
  | { t: "check"; checked: boolean };

export interface ForgeHtmlOptions {
  /** The connection's address; relative links and images resolve against its origin. */
  baseUrl: string;
  /** The deck's URL for an image at this absolute address, or null to draw a link. */
  asset: (absoluteUrl: string) => string | null;
  /** A title: only inline marks, every block unwrapped. */
  inline?: boolean;
  /** Past this many nodes the rest is cut, with an ellipsis. */
  maxNodes?: number;
}

const ELEMENT = 1;
const TEXT = 3;

/** Tags kept, each with the attributes it keeps. */
const BLOCK_TAGS: Record<string, readonly string[]> = {
  p: [], div: [], h1: [], h2: [], h3: [], h4: [], h5: [], h6: [],
  ul: [], ol: ["start"], li: [], blockquote: [], pre: [], hr: [], br: [],
  table: [], caption: [], thead: [], tbody: [], tfoot: [], tr: [],
  th: ["align", "colspan", "rowspan"], td: ["align", "colspan", "rowspan"],
  details: ["open"], summary: [], dl: [], dt: [], dd: [],
};
const INLINE_TAGS: Record<string, readonly string[]> = {
  code: [], em: [], strong: [], b: [], i: [], u: [], s: [], del: [], ins: [], mark: [],
  sup: [], sub: [], kbd: [], small: [], abbr: ["title"], q: [], cite: [],
};

/** Gone with everything inside them: they run, embed, or are not content. */
const DROPPED = new Set([
  "script", "style", "template", "noscript", "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "form", "button", "textarea", "select", "option", "canvas", "link", "meta", "base",
  "head", "title", "portal", "track", "source",
]);

const LINK_SCHEMES = new Set(["http:", "https:", "mailto:"]);
const MEDIA_SCHEMES = new Set(["http:", "https:"]);
const MAX_ATTR = 2048;
const MAX_DEPTH = 48;

/** An address as an absolute URL with an allowed scheme, or null. */
function absolute(raw: string | null | undefined, base: string, schemes: Set<string>): string | null {
  const value = (raw ?? "").trim();
  if (!value || value.length > MAX_ATTR) return null;
  let url: URL;
  try {
    // GitLab writes its links as paths from the instance's root (with any
    // relative-URL prefix already in them), so the origin is the base.
    url = new URL(value, new URL(base).origin + "/");
  } catch {
    return null;
  }
  return schemes.has(url.protocol) ? url.toString() : null;
}

function attr(node: NodeLike, name: string): string | null {
  const v = node.getAttribute?.(name);
  return typeof v === "string" ? v : null;
}

function dimension(v: string | null): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 && n < 10_000 ? n : null;
}

/**
 * The allow-listed tree for a parsed document's body (or any node's children).
 */
export function forgeTree(root: NodeLike, opts: ForgeHtmlOptions): ForgeNode[] {
  const budget = { left: opts.maxNodes ?? 5000, cut: false };
  const out = walkChildren(root, opts, budget, 0);
  if (budget.cut) out.push({ t: "text", text: " …" });
  return out;
}

function walkChildren(node: NodeLike, opts: ForgeHtmlOptions, budget: { left: number; cut: boolean }, depth: number): ForgeNode[] {
  const out: ForgeNode[] = [];
  const kids = node.childNodes;
  for (let i = 0; i < kids.length; i++) {
    if (budget.left <= 0) {
      budget.cut = true;
      break;
    }
    out.push(...walk(kids[i], opts, budget, depth));
  }
  return out;
}

function walk(node: NodeLike, opts: ForgeHtmlOptions, budget: { left: number; cut: boolean }, depth: number): ForgeNode[] {
  budget.left--;
  if (node.nodeType === TEXT) return node.nodeValue ? [{ t: "text", text: node.nodeValue }] : [];
  if (node.nodeType !== ELEMENT) return [];
  const tag = node.nodeName.toLowerCase();
  if (DROPPED.has(tag)) return [];
  // Past a sane depth the structure is not worth keeping, only the words.
  if (depth >= MAX_DEPTH) return walkChildren(node, opts, budget, depth);
  const kids = () => walkChildren(node, opts, budget, depth + 1);

  if (tag === "a") {
    const href = absolute(attr(node, "href"), opts.baseUrl, LINK_SCHEMES);
    // An in-page anchor (the "#" beside every heading) leads nowhere here.
    if (!href || attr(node, "href")?.trim().startsWith("#")) return kids();
    return [{ t: "link", href, title: attr(node, "title")?.slice(0, 300) ?? null, kids: kids() }];
  }

  if (tag === "img") {
    // GitLab lazy-loads: the real address is data-src and src is a blank GIF.
    // GitHub's camo proxy keeps the author's original in data-canonical-src,
    // but its own src is the one that loads.
    const href = absolute(attr(node, "data-src") ?? attr(node, "src"), opts.baseUrl, MEDIA_SCHEMES);
    if (!href) return [];
    const alt = (attr(node, "alt") ?? "").slice(0, 300);
    if (opts.inline) return [{ t: "text", text: alt }];
    return [{
      t: "img", src: opts.asset(href), href, alt,
      width: dimension(attr(node, "width")), height: dimension(attr(node, "height")),
    }];
  }

  if (tag === "video" || tag === "audio") {
    // Not played here: a link to it, so it is not lost either.
    const href = absolute(attr(node, "data-src") ?? attr(node, "src"), opts.baseUrl, MEDIA_SCHEMES);
    return href && !opts.inline ? [{ t: "link", href, title: null, kids: [{ t: "text", text: `${tag} ↗` }] }] : [];
  }

  if (tag === "input") {
    return attr(node, "type")?.toLowerCase() === "checkbox" && !opts.inline
      ? [{ t: "check", checked: node.getAttribute?.("checked") != null }]
      : [];
  }

  const allowed = INLINE_TAGS[tag] ?? (opts.inline ? undefined : BLOCK_TAGS[tag]);
  if (!allowed) return kids();
  const attrs: Record<string, string> = {};
  for (const name of allowed) {
    const v = attr(node, name);
    if (v != null && v.length <= MAX_ATTR) attrs[name] = v;
  }
  if (attrs.start != null && !/^\d{1,6}$/.test(attrs.start)) delete attrs.start;
  for (const span of ["colspan", "rowspan"]) {
    if (attrs[span] != null && !/^\d{1,3}$/.test(attrs[span])) delete attrs[span];
  }
  if (attrs.align != null && !/^(?:left|right|center)$/i.test(attrs.align)) delete attrs.align;
  return [{ t: "el", tag, attrs, kids: kids() }];
}

/** The tree for a forge's HTML string. Browser-only: DOMParser builds a
 *  document that runs no script and loads no image. */
export function parseForgeHtml(html: string | null | undefined, opts: ForgeHtmlOptions): ForgeNode[] {
  if (!html) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return forgeTree(doc.body as unknown as NodeLike, opts);
}
