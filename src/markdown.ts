import { Marked, Renderer, type Token, type Tokens } from "marked";

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => htmlEntities[char]);

function safeUrl(href: string): string | undefined {
  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:") return escapeHtml(url.href);
  } catch {
    return undefined;
  }
}

function titleAttribute(title: string | null | undefined): string {
  return title ? ` title="${escapeHtml(title)}"` : "";
}

class SafeRenderer extends Renderer {
  override html({ text, block }: Tokens.HTML | Tokens.Tag): string {
    const escaped = escapeHtml(text);
    return block ? `<pre class="raw-html">${escaped}</pre>\n` : escaped;
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    // Marked's raw HTML context can mark text as already escaped, even though we render that context as plain text.
    return "escaped" in token && token.escaped ? escapeHtml(token.text) : super.text(token);
  }

  override code(token: Tokens.Code): string {
    return super.code({ ...token, escaped: false });
  }

  override link({ href, tokens, text, title, autolink }: Tokens.Link): string {
    const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return label;
    return `<a href="${url}" rel="noopener noreferrer"${titleAttribute(title)}>${label}</a>`;
  }

  override image({ href, tokens, title }: Tokens.Image): string {
    const alt = escapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer));
    const url = safeUrl(href);
    if (!url) return alt;
    return `<img src="${url}" alt="${alt}"${titleAttribute(title)} loading="lazy" referrerpolicy="no-referrer">`;
  }
}

const markdown = new Marked().setOptions({ renderer: new SafeRenderer() });

function reportHeader(tokens: Token[]) {
  const [first, ...rest] = tokens.filter((token) => token.type !== "space");
  if (first?.type !== "heading" || first.depth !== 1) return;

  const lines: string[] = [];
  for (const token of rest) {
    if (token.type !== "paragraph") break;
    lines.push(...token.raw.split("\n").map((line) => line.trimEnd()));
  }

  if (!lines.includes("**Report projection schema**: 2")) return;
  const continuity = lines.find((line) =>
    /^\*\*Prior review continuity\*\*: CHECKED \(fixed \d+ \/ still-open \d+ \/ stale \d+\)$/.test(line),
  );
  const prPrefix = "**PR**:";
  const pr = lines.find((line) => line.startsWith(prPrefix))?.slice(prPrefix.length).trim();

  return {
    title: escapeHtml(first.text),
    continuity: continuity?.slice("**Prior review continuity**: ".length),
    pr: pr ? markdown.parseInline(pr, { async: false }) : undefined,
  };
}

export function renderReport(body: string) {
  try {
    const tokens = markdown.lexer(body);
    return { html: markdown.parser(tokens), header: reportHeader(tokens) };
  } catch {
    return { html: `<pre>${escapeHtml(body)}</pre>`, header: undefined };
  }
}
