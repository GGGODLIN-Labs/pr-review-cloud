import { Marked, Renderer, type Tokens } from "marked";

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

  override link({ href, tokens, text, autolink }: Tokens.Link): string {
    const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return label;
    return `<a href="${url}" rel="noopener noreferrer">${label}</a>`;
  }

  override image({ href, tokens }: Tokens.Image): string {
    const alt = escapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer));
    const url = safeUrl(href);
    if (!url) return alt;
    return `<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
  }
}

const markdown = new Marked().setOptions({ renderer: new SafeRenderer() });

export function renderReport(body: string): string {
  try {
    return markdown.parse(body, { async: false });
  } catch {
    return `<pre>${escapeHtml(body)}</pre>`;
  }
}
