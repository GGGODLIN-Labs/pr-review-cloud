import { lexer, Marked, Renderer, type Tokens } from "marked";

const htmlEntities: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => htmlEntities[char]);

export interface TocHeading {
  depth: 2 | 3;
  id: string;
  text: string;
}

export interface ContinuityCounts {
  status: string;
  fixed: number;
  stillOpen: number;
  stale: number;
  total: number;
  raw: string;
}

export interface RenderedReport {
  html: string;
  toc: TocHeading[];
  continuity: ContinuityCounts | null;
  hasStillOpenRows: boolean;
  hasResolvedOrStaleRows: boolean;
  stillOpenRowCount: number;
  totalStatusRowCount: number;
  stillOpenTitles: string[];
}

const exactStatusRe = /^(FIXED|STILL_OPEN|STALE)$/;
const safeFragmentRe = /^#[A-Za-z0-9一-鿿_-]{1,80}$/;

function safeUrl(href: string): string | undefined {
  if (safeFragmentRe.test(href)) return href;
  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:") return escapeHtml(url.href);
  } catch {
    return undefined;
  }
}

function slugifyHeading(text: string, seen: Map<string, number>): string {
  const base = text
    .toLowerCase()
    .replace(/[`*_~()[\]{}.,:;!?/\\]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-鿿-]/g, "")
    .slice(0, 48) || "section";
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? `sec-${base}` : `sec-${base}-${count}`;
}

export function extractContinuityCounts(body: string): ContinuityCounts | null {
  const normalized = body.replace(/^﻿/, "");
  const tokens = lexer(normalized);
  const fields = tokens.flatMap((token) =>
    token.type === "paragraph" && typeof token.text === "string" ? token.text.split(/\r?\n/) : []);
  const hasSchema = fields.some((line) => /^\*\*Report projection schema\*\*:\s*[23]\s*$/.test(line));
  if (!hasSchema) return null;
  const match = fields
    .map((line) =>
      line.match(/^\*\*Prior review continuity\*\*:\s*([A-Z_]+)\s*\(fixed\s+(\d+)\s*\/\s*still-open\s+(\d+)\s*\/\s*stale\s+(\d+)\)\s*$/))
    .find(Boolean);
  if (!match) return null;
  const [, status, fixedStr, openStr, staleStr] = match;
  const fixed = Number.parseInt(fixedStr, 10);
  const stillOpen = Number.parseInt(openStr, 10);
  const stale = Number.parseInt(staleStr, 10);
  return {
    status,
    fixed,
    stillOpen,
    stale,
    total: fixed + stillOpen + stale,
    raw: `${status} (fixed ${fixed} / still-open ${stillOpen} / stale ${stale})`,
  };
}

class SafeRenderer extends Renderer {
  readonly toc: TocHeading[] = [];
  readonly headingSlugs = new Map<string, number>();
  readonly stillOpenTitles: string[] = [];
  stillOpenRowCount = 0;
  resolvedOrStaleRowCount = 0;

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

  override heading({ tokens, depth }: Tokens.Heading): string {
    const rendered = this.parser.parseInline(tokens);
    if (depth === 2 || depth === 3) {
      const plain = this.parser.parseInline(tokens, this.parser.textRenderer).trim();
      const id = slugifyHeading(plain, this.headingSlugs);
      this.toc.push({ depth, id, text: plain });
      return `<h${depth} id="${id}">${rendered}</h${depth}>\n`;
    }
    return `<h${depth}>${rendered}</h${depth}>\n`;
  }

  override table(token: Tokens.Table): string {
    let header = "";
    let cell = "";
    for (let j = 0; j < token.header.length; j++) {
      cell += this.tablecell(token.header[j]);
    }
    header += this.tablerow({ text: cell });

    let body = "";
    for (let j = 0; j < token.rows.length; j++) {
      const row = token.rows[j];
      cell = "";
      let rowStatus: string | null = null;
      for (let k = 0; k < row.length; k++) {
        const plain = row[k].text.trim();
        if (!rowStatus && exactStatusRe.test(plain)) {
          rowStatus = plain;
        }
        cell += this.tablecell(row[k]);
      }
      if (rowStatus === "STILL_OPEN") {
        this.stillOpenRowCount += 1;
        const firstCell = row[0]?.text?.trim();
        if (firstCell && this.stillOpenTitles.length < 5) {
          this.stillOpenTitles.push(firstCell);
        }
      } else if (rowStatus === "FIXED" || rowStatus === "STALE") {
        this.resolvedOrStaleRowCount += 1;
      }
      const statusAttr = rowStatus ? ` data-row-status="${rowStatus}"` : "";
      body += `<tr${statusAttr}>\n${cell}</tr>\n`;
    }
    const tbody = body ? `<tbody>${body}</tbody>` : "";
    return `<div class="table-scroll"><table>\n<thead>\n${header}</thead>\n${tbody}</table></div>\n`;
  }

  override tablecell(token: Tokens.TableCell): string {
    const content = this.parser.parseInline(token.tokens);
    const type = token.header ? "th" : "td";
    const alignAttr = token.align ? ` align="${token.align}"` : "";
    const trimmed = content.trim();
    const statusAttr = !token.header && exactStatusRe.test(trimmed) ? ` data-status="${trimmed}"` : "";
    return `<${type}${alignAttr}${statusAttr}>${content}</${type}>\n`;
  }

  override link({ href, tokens, text, autolink }: Tokens.Link): string {
    const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
    const url = safeUrl(href);
    if (!url) return label;
    if (url.startsWith("#")) return `<a href="${url}">${label}</a>`;
    return `<a href="${url}" rel="noopener noreferrer">${label}</a>`;
  }

  override image({ href, tokens }: Tokens.Image): string {
    const alt = escapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer));
    const url = safeUrl(href);
    if (!url) return alt;
    return `<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`;
  }
}

export function renderReportWithMeta(body: string): RenderedReport {
  const renderer = new SafeRenderer();
  const parser = new Marked().setOptions({ renderer });
  let html: string;
  try {
    html = parser.parse(body, { async: false });
  } catch {
    html = `<pre>${escapeHtml(body)}</pre>`;
  }
  const continuity = extractContinuityCounts(body);
  return {
    html,
    toc: renderer.toc,
    continuity,
    hasStillOpenRows: renderer.stillOpenRowCount > 0,
    hasResolvedOrStaleRows: renderer.resolvedOrStaleRowCount > 0,
    stillOpenRowCount: renderer.stillOpenRowCount,
    totalStatusRowCount: renderer.stillOpenRowCount + renderer.resolvedOrStaleRowCount,
    stillOpenTitles: renderer.stillOpenTitles,
  };
}

export function renderReport(body: string): string {
  return renderReportWithMeta(body).html;
}
