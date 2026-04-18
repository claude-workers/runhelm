import type { ReactNode } from "react";

const IMAGE_EXTS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "ico",
]);
const HTML_EXTS = new Set(["html", "htm"]);

type Token =
  | { kind: "text"; text: string }
  | { kind: "preview"; path: string; alt?: string };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  const combined = /\[\[preview:([^\]]+)\]\]|!\[([^\]]*)\]\(([^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = combined.exec(text)) !== null) {
    if (match.index > cursor) {
      tokens.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    if (match[1] !== undefined) {
      tokens.push({ kind: "preview", path: match[1].trim() });
    } else {
      tokens.push({
        kind: "preview",
        path: match[3].trim(),
        alt: match[2] || undefined,
      });
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) {
    tokens.push({ kind: "text", text: text.slice(cursor) });
  }
  return tokens;
}

function normalizePath(path: string): string {
  let p = path.trim();
  // strip common absolute prefixes that Claude might use
  p = p.replace(/^\/workspace\//, "");
  p = p.replace(/^\.\//, "");
  p = p.replace(/^\/+/, "");
  return p;
}

function isLocalPath(path: string): boolean {
  if (!path) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false; // http:, https:, data:, …
  if (path.startsWith("//")) return false;
  return true;
}

function extOf(path: string): string {
  const m = path.match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : "";
}

function Preview({
  projectId,
  path,
  alt,
}: {
  projectId: string;
  path: string;
  alt?: string;
}) {
  const src = `/api/projects/${projectId}/files/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const ext = extOf(path);
  if (IMAGE_EXTS.has(ext)) {
    return (
      <a href={src} target="_blank" className="preview-wrap">
        <img src={src} alt={alt ?? path} className="preview-img" />
        <span className="preview-caption">{alt ?? path}</span>
      </a>
    );
  }
  if (HTML_EXTS.has(ext)) {
    return (
      <div className="preview-wrap">
        <div className="preview-head">
          <span className="preview-caption">{alt ?? path}</span>
          <a href={src} target="_blank" className="preview-open">
            in neuem Tab öffnen ↗
          </a>
        </div>
        <iframe
          src={src}
          className="preview-iframe"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </div>
    );
  }
  return (
    <a href={src} target="_blank" className="preview-link">
      📎 {alt ?? path}
    </a>
  );
}

export function renderMessageContent(
  text: string,
  projectId: string
): ReactNode[] {
  const tokens = tokenize(text ?? "");
  return tokens.map((t, i) => {
    if (t.kind === "text") {
      return <span key={i}>{t.text}</span>;
    }
    if (!isLocalPath(t.path)) {
      // external image/link — just render as a plain link
      return (
        <a key={i} href={t.path} target="_blank">
          {t.alt ?? t.path}
        </a>
      );
    }
    const norm = normalizePath(t.path);
    return <Preview key={i} projectId={projectId} path={norm} alt={t.alt} />;
  });
}
