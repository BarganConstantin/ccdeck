// A forge's rendered description, drawn as React elements (#2179).
//
// forge-html.ts has already reduced the forge's HTML to an allow-listed tree;
// this turns that tree into elements, so nothing a description says reaches
// the page as markup. Links open outside the deck (the desktop app hands them
// to the system browser); images load from the deck's own proxy and, when one
// will not load, fall back to the link it stood for.
import { useState } from "react";
import type { ForgeNode } from "../forge-html";

/** React's spelling of the few attributes the tree keeps. */
function props(attrs: Record<string, string>): Record<string, unknown> {
  const p: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(attrs)) {
    if (name === "colspan") p.colSpan = Number(value);
    else if (name === "rowspan") p.rowSpan = Number(value);
    else if (name === "start") p.start = Number(value);
    else if (name === "open") p.open = true;
    else if (name === "align") p.style = { textAlign: value.toLowerCase() };
    else p[name] = value;
  }
  return p;
}

function ForgeImage({ node }: { node: Extract<ForgeNode, { t: "img" }> }) {
  const [failed, setFailed] = useState(false);
  const label = node.alt.trim() || "image";
  if (!node.src || failed) {
    return (
      <a className="fh-image-link" href={node.href} target="_blank" rel="noreferrer noopener">
        {label} ↗
      </a>
    );
  }
  return (
    <a className="fh-image" href={node.href} target="_blank" rel="noreferrer noopener">
      <img
        src={node.src}
        alt={node.alt}
        width={node.width ?? undefined}
        height={node.height ?? undefined}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    </a>
  );
}

/** The elements for a tree. Keys are positions: a tree is built once from one
 *  answer and never reordered. */
export function renderForgeNodes(nodes: ForgeNode[]): React.ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case "text":
        return n.text;
      case "link":
        return (
          <a key={i} href={n.href} title={n.title ?? undefined} target="_blank" rel="noreferrer noopener">
            {renderForgeNodes(n.kids)}
          </a>
        );
      case "img":
        return <ForgeImage key={i} node={n} />;
      case "check":
        return <input key={i} type="checkbox" className="fh-check" checked={n.checked} disabled readOnly />;
      case "el": {
        const Tag = n.tag as keyof JSX.IntrinsicElements;
        // hr and br take no children; React throws on void elements given any.
        if (n.tag === "hr" || n.tag === "br") return <Tag key={i} />;
        return <Tag key={i} {...props(n.attrs)}>{renderForgeNodes(n.kids)}</Tag>;
      }
    }
  });
}

export default function ForgeHtml({ nodes, className }: { nodes: ForgeNode[]; className?: string }) {
  return <div className={className ? `forge-html ${className}` : "forge-html"}>{renderForgeNodes(nodes)}</div>;
}
