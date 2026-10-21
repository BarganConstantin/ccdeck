// Jira's rendered HTML — an issue's description and its comments — drawn as
// React elements (#2178), never as markup.
//
// Jira answers `renderedFields` as HTML it rendered from wiki markup or from
// Atlassian's document format. That HTML is the tracker's, written by whoever
// can edit an issue, so it is treated as hostile: it is parsed into an inert
// document (DOMParser runs no script and loads nothing), walked, and rebuilt
// from an allowlist of elements and attributes. Nothing is ever handed to
// innerHTML or dangerouslySetInnerHTML — there is none in src/web, and this
// keeps it that way.
//
//   ELEMENTS   text structure only (paragraphs, lists, tables, quotes, code,
//              emphasis, links, images). Script, style, frames, embeds, forms
//              and the like go with everything inside them; any other unknown
//              element is unwrapped and keeps its text.
//   ATTRIBUTES none, except a link's http(s) href, an image's source and alt,
//              a cell's colspan and rowspan, and a few of Jira's own classes
//              mapped to the deck's (a panel, a code block).
//   LINKS      http and https only, resolved against the connection's site,
//              opened in a new tab with no referrer. `javascript:`, `data:`
//              and every other scheme leave just the text.
//   IMAGES     loaded only through the deck's asset route, which reads them
//              from the connection's own origins (with the token) or Jira's
//              public image hosts (without), and serves raster images only.
//              Any other image, or one that will not load, is a link to it
//              instead; an emoticon is its own text (":)").

import { createElement, Fragment, useMemo, useState, type ReactNode } from "react";

/** The part of a DOM node the walk reads — what DOMParser gives, and what a
 *  suite's own parser can give. */
export interface HtmlNode {
  nodeType: number;
  nodeName: string;
  nodeValue?: string | null;
  childNodes: ArrayLike<HtmlNode>;
  getAttribute?: (name: string) => string | null;
}

export interface HtmlContext {
  /** Where relative links and images resolve from: the connection's site. */
  baseUrl: string;
  /** The deck's address for an image at this absolute URL, or null when the
   *  image is not the connection's to load. */
  image: (absoluteUrl: string) => string | null;
}

const ELEMENT = 1;
const TEXT = 3;
const MAX_DEPTH = 48;
const MAX_NODES = 20_000;

/** Dropped with everything inside them. */
const DROP = new Set([
  "SCRIPT", "STYLE", "IFRAME", "FRAME", "FRAMESET", "OBJECT", "EMBED", "APPLET", "PARAM", "NOSCRIPT", "TEMPLATE",
  "SVG", "MATH", "FORM", "INPUT", "BUTTON", "SELECT", "OPTION", "TEXTAREA", "LABEL", "FIELDSET", "LINK", "META",
  "TITLE", "HEAD", "BASE", "AUDIO", "VIDEO", "SOURCE", "TRACK", "PICTURE", "CANVAS", "MAP", "AREA", "DIALOG", "SLOT",
]);

/** Kept, as the element it is drawn as. Headings step down to h5 and h6: the
 *  detail pane's own headings (h3, h4) sit above an issue's. */
const KEEP: Record<string, string> = {
  P: "p", BR: "br", HR: "hr", DIV: "div", SPAN: "span",
  STRONG: "strong", B: "strong", EM: "em", I: "em", U: "u", S: "s", STRIKE: "s", DEL: "del", INS: "ins",
  SUB: "sub", SUP: "sup", SMALL: "small", MARK: "mark", ABBR: "abbr", CITE: "cite", Q: "q", FONT: "span",
  CODE: "code", TT: "code", KBD: "kbd", SAMP: "samp", PRE: "pre", BLOCKQUOTE: "blockquote",
  UL: "ul", OL: "ol", LI: "li", DL: "dl", DT: "dt", DD: "dd",
  H1: "h5", H2: "h6", H3: "h6", H4: "h6", H5: "h6", H6: "h6",
  TABLE: "table", CAPTION: "caption", THEAD: "thead", TBODY: "tbody", TFOOT: "tfoot", TR: "tr", TH: "th", TD: "td",
  A: "a", IMG: "img",
};
const VOID = new Set(["br", "hr", "img"]);

/** Jira's own classes the deck draws, as the deck's. */
const CLASSES: Record<string, string> = {
  panel: "jr-html-panel", panelHeader: "jr-html-panel-head", panelContent: "jr-html-panel-body",
  code: "jr-html-code", codeContent: "jr-html-code-body", preformatted: "jr-html-pre", preformattedContent: "jr-html-pre-body",
  emoticon: "jr-emoticon", "user-hover": "jr-mention", error: "jr-html-error",
};

function classOf(node: HtmlNode): string | undefined {
  const raw = node.getAttribute?.("class") ?? "";
  const mapped = raw.split(/\s+/).map(c => CLASSES[c]).filter(Boolean);
  return mapped.length ? [...new Set(mapped)].join(" ") : undefined;
}

/** An http(s) URL resolved against the site, or null. */
export function safeHref(raw: string | null | undefined, baseUrl: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let u: URL;
  try { u = new URL(value, `${baseUrl.replace(/\/+$/, "")}/`); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  return u.href;
}

function span(raw: string | null | undefined): number | undefined {
  const n = Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(n) && n > 1 && n <= 100 ? n : undefined;
}

/** What an image is drawn as when it cannot be: an emoticon as its own text
 *  (":)"), anything else as a link to it. */
function ImageFallback({ href, alt, emoticon }: { href: string; alt: string; emoticon: boolean }) {
  if (emoticon) return <>{alt}</>;
  return <a className="jr-image-link" href={href} target="_blank" rel="noreferrer noopener">{alt || "Image"}</a>;
}

/** An image the deck loads, which falls back when it will not. */
function JiraImage({ src, href, alt, emoticon }: { src: string; href: string; alt: string; emoticon: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <ImageFallback href={href} alt={alt} emoticon={emoticon} />;
  return <img className={emoticon ? "jr-emoticon" : "jr-image"} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer"
    draggable={false} onError={() => setFailed(true)} />;
}

/** The parsed body of `html`, inert. */
export function parseWithDom(html: string): HtmlNode | null {
  if (typeof DOMParser === "undefined") return null;
  return new DOMParser().parseFromString(html, "text/html").body as unknown as HtmlNode;
}

/**
 * Jira's HTML as React elements, through the allowlist. `parse` is DOMParser
 * in the browser; the suite hands in its own.
 */
export function htmlToReact(html: string, ctx: HtmlContext, parse: (html: string) => HtmlNode | null = parseWithDom): ReactNode {
  if (!html || !html.trim()) return null;
  const root = parse(html);
  if (!root) return html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  let budget = MAX_NODES;

  const walk = (node: HtmlNode, key: string, depth: number): ReactNode => {
    if (--budget < 0) return null;
    if (node.nodeType === TEXT) return node.nodeValue ?? "";
    if (node.nodeType !== ELEMENT) return null;
    const name = String(node.nodeName).toUpperCase();
    if (DROP.has(name)) return null;
    const children = (): ReactNode[] => {
      if (depth >= MAX_DEPTH) return [];
      const out: ReactNode[] = [];
      const list = node.childNodes;
      for (let i = 0; i < list.length; i++) {
        const child = walk(list[i], `${key}.${i}`, depth + 1);
        if (child !== null && child !== "") out.push(child);
      }
      return out;
    };
    const tag = KEEP[name];
    if (!tag) {
      // An element the deck does not draw keeps its text.
      const inner = children();
      return inner.length ? createElement(Fragment, { key }, ...inner) : null;
    }
    const className = classOf(node);
    if (tag === "img") {
      const href = safeHref(node.getAttribute?.("src"), ctx.baseUrl);
      if (!href) return null;
      const alt = (node.getAttribute?.("alt") ?? node.getAttribute?.("title") ?? "").slice(0, 200);
      const src = ctx.image(href);
      const emoticon = className === "jr-emoticon";
      if (!src) return <ImageFallback key={key} href={href} alt={alt} emoticon={emoticon} />;
      return <JiraImage key={key} src={src} href={href} alt={alt} emoticon={emoticon} />;
    }
    if (tag === "a") {
      const href = safeHref(node.getAttribute?.("href"), ctx.baseUrl);
      const inner = children();
      if (!href) return inner.length ? createElement(Fragment, { key }, ...inner) : null;
      return createElement("a", { key, href, target: "_blank", rel: "noreferrer noopener", className }, ...(inner.length ? inner : [href]));
    }
    const props: Record<string, unknown> = { key };
    if (className) props.className = className;
    if (tag === "td" || tag === "th") {
      const colSpan = span(node.getAttribute?.("colspan"));
      const rowSpan = span(node.getAttribute?.("rowspan"));
      if (colSpan) props.colSpan = colSpan;
      if (rowSpan) props.rowSpan = rowSpan;
    }
    if (tag === "table") {
      // A wide table scrolls inside its own frame, not the pane.
      return <div key={key} className="jr-table-wrap">{createElement("table", { className }, ...children())}</div>;
    }
    if (VOID.has(tag)) return createElement(tag, props);
    return createElement(tag, props, ...children());
  };

  const out: ReactNode[] = [];
  for (let i = 0; i < root.childNodes.length; i++) {
    const child = walk(root.childNodes[i], String(i), 0);
    if (child !== null && child !== "") out.push(child);
  }
  return out.length ? out : null;
}

/** An issue's description or a comment, drawn. */
export default function JiraHtml({ html, ctx, className = "jr-html", empty }: { html: string; ctx: HtmlContext; className?: string; empty?: ReactNode }) {
  const body = useMemo(() => htmlToReact(html, ctx), [html, ctx]);
  if (!body) return empty ? <>{empty}</> : null;
  return <div className={className}>{body}</div>;
}
