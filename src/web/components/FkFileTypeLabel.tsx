import React, { useId } from "react";

// What kind of file a row is, the way Fork's file lists say it: a few bold
// letters in the language's own colour (C#, TS, JS…) in a 16px column, or a
// plain page for anything else; and the blue folder a folder row carries.
// Decoration beside a name, so hidden from a screen reader.

/** The label and its colour family, by file extension. */
const BY_EXT: Record<string, { label: string; kind: string }> = {};
const add = (label: string, kind: string, exts: string[]) => { for (const e of exts) BY_EXT[e] = { label, kind }; };
add("C#", "cs", ["cs", "csx"]);
add("TS", "ts", ["ts", "tsx", "mts", "cts"]);
add("JS", "js", ["js", "jsx", "mjs", "cjs"]);
add("{}", "json", ["json", "jsonc", "json5"]);
add("MD", "md", ["md", "mdx", "markdown"]);
add("RS", "rs", ["rs"]);
add("PY", "py", ["py", "pyi"]);
add("CSS", "css", ["css", "scss", "sass", "less"]);
add("<>", "html", ["html", "htm", "xhtml", "vue", "svelte"]);
add("SQL", "sql", ["sql"]);
add("YML", "yaml", ["yml", "yaml"]);
add("SH", "sh", ["sh", "bash", "zsh", "fish", "ps1"]);

/** The label a path is drawn with, or null for the plain page. */
export function fileTypeOf(path: string): { label: string; kind: string } | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return BY_EXT[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The light page Fork draws for a file it has no label for: 11×14 with a
 *  folded corner. */
export function FkPageIcon() {
  return (
    <svg className="fk-page" width="11" height="14" viewBox="0 0 11 14" aria-hidden="true" focusable="false">
      <path className="fk-page-sheet" d="M1 1.5C1 .95 1.45.5 2 .5h4.8L10 3.7v8.8c0 .55-.45 1-1 1H2c-.55 0-1-.45-1-1z" />
      <path className="fk-page-fold" d="M6.8.5v2.6c0 .33.27.6.6.6H10" />
    </svg>
  );
}

/** The 16px column a file row names its kind in. */
export default function FkFileTypeLabel({ path }: { path: string }) {
  const t = fileTypeOf(path);
  if (!t) return <span className="fk-ft is-page" aria-hidden="true"><FkPageIcon /></span>;
  return <span className="fk-ft" data-ft={t.kind} data-long={t.label.length > 2 || undefined} aria-hidden="true">{t.label}</span>;
}

/** Fork's blue folder, 16px: a back tab and a front lit from above. */
export function FkFolderIcon() {
  // One gradient per icon: an id the page can hold many of.
  const id = `fkfold${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  return (
    <svg className="fk-folder" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="fk-folder-top" />
          <stop offset="1" className="fk-folder-bottom" />
        </linearGradient>
      </defs>
      <path className="fk-folder-back" d="M1 4.2C1 3.54 1.54 3 2.2 3h3.6l1.5 1.5h6.5c.66 0 1.2.54 1.2 1.2V7H1z" />
      <path fill={`url(#${id})`} d="M1 6.4c0-.66.54-1.2 1.2-1.2h11.6c.66 0 1.2.54 1.2 1.2v6.4c0 .66-.54 1.2-1.2 1.2H2.2c-.66 0-1.2-.54-1.2-1.2z" />
    </svg>
  );
}
