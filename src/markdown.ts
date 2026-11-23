import { lexer, Marked, Renderer, type Token, type Tokens } from "marked";

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
const safeFragmentRe = /^#[A-Za-z0-9\u4e00-\u9fff_-]{1,80}$/;
const maxParseChars = 262_144;
const maxRenderedChars = 1_048_576;
const maxBlockNesting = 32;
const maxInlineNesting = 32;
const maxParenNesting = 64;
const maxLineEmRuns = 128;
const maxParaEmRuns = 256;
const maxTotalEmWork = 500_000;
const maxInlineBacktickLen = 32;
const maxLineBacktickRuns = 128;
const maxParaBacktickRuns = 256;
const maxTotalBacktickWork = 500_000;
const maxParaOpenBackticks = 16;
const maxBacktickScanChars = 524_288;
const maxRefUrlChars = 2048;
const maxTableCols = 128;
const maxListItems = 4000;
const maxTaskListItems = 500;
const maxInlineLinks = 2000;
const maxSpecialHtmlTags = 128;
const maxAngleOpens = 4000;
const maxEmailLookaheadWork = 250_000;
const maxTotalAutolinkWork = 250_000;
const maxHeadings = 1000;
const maxNonFenceLines = 8000;

interface BacktickIndex {
  runs: number;
  positions: Map<number, number[]>;
  cursors: Map<number, number>;
}

type RefTitleDelim = '"' | "'" | "(";

function visualIndent(prefix: string): number {
  let width = 0;
  for (let i = 0; i < prefix.length; i++) {
    width += prefix[i] === "\t" ? 4 : 1;
  }
  return width;
}

function detectHtmlBlockEnd(line: string): RegExp | "blank" | "same-line" | null {
  const rawTag = /^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i.exec(line);
  if (rawTag) {
    const endRe = new RegExp(`</${rawTag[1]}>`, "i");
    return endRe.test(line) ? "same-line" : endRe;
  }
  if (/^ {0,3}<!--/.test(line)) {
    return /^ {0,3}<!--(?:-?>|[\s\S]*?-->)/.test(line) ? "same-line" : /-->/;
  }
  if (/^ {0,3}<\?/.test(line)) {
    return /\?>/.test(line) ? "same-line" : /\?>/;
  }
  if (/^ {0,3}<![A-Za-z]/.test(line)) {
    return />/.test(line) ? "same-line" : />/;
  }
  if (/^ {0,3}<!\[CDATA\[/i.test(line)) {
    return /\]\]>/.test(line) ? "same-line" : /\]\]>/;
  }
  if (
    /^ {0,3}<\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\/?>|$)/i
      .test(line)
  ) {
    return "blank";
  }
  if (
    /^ {0,3}(?:<[A-Za-z][A-Za-z0-9-]*(?: +[A-Za-z:_][\w.:-]*(?: *= *(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)* *\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)[ \t]*$/
      .test(line)
  ) {
    return "blank";
  }
  return null;
}

function isEmailLocalChar(code: number): boolean {
  if ((code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122)) return true;
  switch (code) {
    case 33:
    case 35:
    case 36:
    case 37:
    case 38:
    case 39:
    case 42:
    case 43:
    case 45:
    case 46:
    case 47:
    case 61:
    case 63:
    case 94:
    case 95:
    case 96:
    case 123:
    case 124:
    case 125:
    case 126:
      return true;
    default:
      return false;
  }
}

function isEmailTriggerChar(ch: string): boolean {
  return ch === "_" || ch === "!" || ch === "*" || ch === "~" || ch === "`";
}

function isBackpedalPunct(ch: string): boolean {
  return (
    ch === "?" || ch === "!" || ch === "." || ch === "," || ch === ":" || ch === ";" ||
    ch === "*" || ch === "_" || ch === "'" || ch === '"' || ch === "~" || ch === ")"
  );
}

function measureAutolink(line: string, start: number): { len: number; backpedalSteps: number } {
  let end = start;
  while (end < line.length && !/\s/.test(line[end]) && line[end] !== "<") end++;
  const len = end - start;
  let pos = end;
  let backpedalSteps = 0;
  while (pos > start) {
    const ch = line[pos - 1];
    if (isBackpedalPunct(ch)) {
      backpedalSteps += 1;
      pos -= 1;
      continue;
    }
    if (ch === ";") {
      let scan = pos - 2;
      while (scan >= start && /[A-Za-z0-9]/.test(line[scan])) scan--;
      if (scan >= start && scan < pos - 2 && line[scan] === "&") {
        backpedalSteps += 1;
        pos = scan;
        continue;
      }
    }
    break;
  }
  return { len, backpedalSteps };
}

function isAutolinkAt(line: string, i: number, pos: number): boolean {
  const ch = line[i];
  if (ch === "h" || ch === "H") {
    return /^https?:\/\//i.test(line.slice(i, i + 8));
  }
  if (ch === "f" || ch === "F") {
    return /^ftp:\/\//i.test(line.slice(i, i + 6));
  }
  if (ch === "w" || ch === "W") {
    if (!/^www\./i.test(line.slice(i, i + 4))) return false;
    if (i === pos) return true;
    const prev = line[i - 1];
    return /\s/.test(prev) || prev === "*" || prev === "_" || prev === "~" || prev === "(";
  }
  return false;
}

function stripLeadingBlockquotes(line: string): { bqDepth: number; afterBq: string } {
  let bqDepth = 0;
  let pos = 0;
  while (pos < line.length) {
    let scan = pos;
    while (scan < line.length && (line[scan] === " " || line[scan] === "\t")) scan++;
    if (line[scan] === ">") {
      bqDepth += 1;
      pos = scan + 1;
      continue;
    }
    break;
  }
  return { bqDepth, afterBq: line.slice(pos) };
}

function stripBlockPrefix(line: string): { pos: number; prefixMarkers: number } | null {
  let prefixMarkers = 0;
  let pos = 0;
  while (pos < line.length) {
    while (pos < line.length && (line[pos] === " " || line[pos] === "\t")) pos++;
    if (line[pos] === ">") {
      prefixMarkers += 1;
      pos += 1;
      if (prefixMarkers > maxBlockNesting) return null;
      continue;
    }
    const listStep = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(line.slice(pos));
    if (listStep) {
      prefixMarkers += 1;
      pos += listStep[0].length;
      if (prefixMarkers > maxBlockNesting) return null;
      continue;
    }
    break;
  }
  return { pos, prefixMarkers };
}

function countTableCells(content: string): number {
  let trimmed = content.trim();
  if (!trimmed) return 0;
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|") && !trimmed.endsWith("\\|")) trimmed = trimmed.slice(0, -1);
  let count = 1;
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] === "\\") {
      i += 1;
      continue;
    }
    if (trimmed[i] === "|") count += 1;
  }
  return count;
}

function tableDelimiterCellCount(content: string): number {
  const trimmed = content.trim();
  if (!trimmed) return 0;
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  const cells = body.split("|");
  if (cells.length === 0) return 0;
  for (const cell of cells) {
    if (!/^:?-{1,}:?$/.test(cell.trim())) return 0;
  }
  return cells.length;
}

function startsTableAt(lines: string[], idx: number, content: string, prefixMarkers: number): number {
  const nextLine = lines[idx + 1];
  if (nextLine === undefined) return 0;
  const nextPrefix = stripBlockPrefix(nextLine);
  if (!nextPrefix || nextPrefix.prefixMarkers !== prefixMarkers) return 0;
  const nextContent = nextLine.slice(nextPrefix.pos);
  if (!content.includes("|") && !nextContent.includes("|")) return 0;
  const delimCells = tableDelimiterCellCount(nextContent);
  if (delimCells === 0) return 0;
  return countTableCells(content) === delimCells ? delimCells : 0;
}

function scanRefLabelClose(
  content: string,
  start: number,
): { status: "closed"; closeIdx: number } | { status: "open" } | { status: "invalid" } {
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "[") return { status: "invalid" };
    if (ch === "]") return { status: "closed", closeIdx: i };
  }
  return { status: "open" };
}

function hasClosingRefTitleDelim(text: string, start: number, delim: RefTitleDelim): boolean {
  const closeChar = delim === "(" ? ")" : delim;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === closeChar) return true;
  }
  return false;
}

function parseRefPayload(trimmed: string): {
  length: number;
  openTitle: RefTitleDelim | null;
  canHaveNextLineTitle: boolean;
} {
  if (!trimmed) return { length: 0, openTitle: null, canHaveNextLineTitle: false };
  let destEnd = 0;
  if (trimmed[0] === "<") {
    destEnd = trimmed.length;
    for (let i = 1; i < trimmed.length; i++) {
      if (trimmed[i] === "\\") {
        i += 1;
        continue;
      }
      if (trimmed[i] === ">") {
        destEnd = i + 1;
        break;
      }
    }
  } else {
    while (destEnd < trimmed.length && !/\s/.test(trimmed[destEnd])) destEnd++;
  }
  const rest = trimmed.slice(destEnd).trim();
  if (!rest) return { length: destEnd, openTitle: null, canHaveNextLineTitle: true };
  const first = rest[0];
  if (first === '"' || first === "'" || first === "(") {
    const closed = hasClosingRefTitleDelim(rest, 1, first);
    return {
      length: destEnd + rest.length,
      openTitle: closed ? null : first,
      canHaveNextLineTitle: false,
    };
  }
  return { length: destEnd, openTitle: null, canHaveNextLineTitle: false };
}

function indexBacktickRuns(line: string, start: number): BacktickIndex | null {
  let found = line.indexOf("`", start);
  if (found === -1) return null;
  const positions = new Map<number, number[]>();
  const cursors = new Map<number, number>();
  let runs = 0;
  while (found !== -1) {
    let end = found + 1;
    while (end < line.length && line[end] === "`") end++;
    const ticks = end - found;
    if (ticks > maxInlineBacktickLen) {
      return { runs: maxLineBacktickRuns + 1, positions, cursors };
    }
    runs += 1;
    if (runs > maxLineBacktickRuns) {
      return { runs, positions, cursors };
    }
    const list = positions.get(ticks);
    if (list) list.push(found);
    else positions.set(ticks, [found]);
    found = line.indexOf("`", end);
  }
  return { runs, positions, cursors };
}

function nextClosingBackticks(index: BacktickIndex, afterPos: number, ticks: number): number {
  const list = index.positions.get(ticks);
  if (!list) return -1;
  let cursor = index.cursors.get(ticks) ?? 0;
  while (cursor < list.length && list[cursor] < afterPos) cursor++;
  index.cursors.set(ticks, cursor);
  return cursor < list.length ? list[cursor] : -1;
}

export function isSafeToParseMarkdown(body: string): boolean {
  if (body.length > maxParseChars) return false;
  const lines = body.split(/\r\n|\r|\n/);
  let fenceChar = "";
  let fenceLength = 0;
  let fenceMinIndent = 0;
  let htmlBlockEnd: RegExp | "blank" | null = null;
  const listIndents: number[] = [];
  let listBqDepth = 0;
  let totalListItems = 0;
  let totalTaskItems = 0;
  let totalInlineLinks = 0;
  let totalSpecialHtmlTags = 0;
  let totalAngleOpens = 0;
  let totalEmailLookaheadWork = 0;
  let totalAutolinkWork = 0;
  let totalHeadings = 0;
  let nonFenceLines = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let starDepth = 0;
  let underDepth = 0;
  let tildeDepth = 0;
  let paraEmRuns = 0;
  let totalEmWork = 0;
  let paraBacktickRuns = 0;
  let totalBacktickWork = 0;
  let paraChars = 0;
  const paraOpenBackticks = new Map<number, number>();
  let totalBacktickScanChars = 0;
  let maxRefDefLen = 0;
  let totalBrackets = 0;
  let refState: "none" | "label" | "dest" = "none";
  let refLabelChars = 0;
  let pendingRefTitle = false;
  let refTitleDelim: RefTitleDelim | null = null;
  let refTitleChars = 0;
  let inTable = false;
  let tablePrefixMarkers = 0;

  const flushParagraph = (): boolean => {
    totalEmWork += paraEmRuns * paraEmRuns;
    if (totalEmWork > maxTotalEmWork) return false;
    totalBacktickWork += paraBacktickRuns * paraBacktickRuns;
    if (totalBacktickWork > maxTotalBacktickWork) return false;
    for (const openOffset of paraOpenBackticks.values()) {
      totalBacktickScanChars += Math.max(0, paraChars - openOffset);
      if (totalBacktickScanChars > maxBacktickScanChars) return false;
    }
    bracketDepth = 0;
    parenDepth = 0;
    starDepth = 0;
    underDepth = 0;
    tildeDepth = 0;
    paraEmRuns = 0;
    paraBacktickRuns = 0;
    paraChars = 0;
    paraOpenBackticks.clear();
    return true;
  };

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (fenceChar) {
      if (fenceMinIndent > 0 && line.trim().length > 0) {
        const leadMatch = /^[ \t]*/.exec(line);
        const leadIndent = visualIndent(leadMatch ? leadMatch[0] : "");
        if (leadIndent < fenceMinIndent) {
          fenceChar = "";
          fenceLength = 0;
          fenceMinIndent = 0;
        }
      }
      if (fenceChar) {
        const closeMatch = fenceMinIndent > 0
          ? line.match(/^[ \t]*(`{3,}|~{3,}) *$/)
          : line.match(/^ {0,3}(`{3,}|~{3,}) *$/);
        if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLength) {
          fenceChar = "";
          fenceLength = 0;
          fenceMinIndent = 0;
        }
        continue;
      }
    }

    nonFenceLines += 1;
    if (nonFenceLines > maxNonFenceLines) return false;

    if (!line.trim()) {
      if (!flushParagraph()) return false;
      if (htmlBlockEnd === "blank") htmlBlockEnd = null;
      refState = "none";
      refLabelChars = 0;
      pendingRefTitle = false;
      refTitleDelim = null;
      refTitleChars = 0;
      inTable = false;
      continue;
    }

    let inHtmlBlockLine = htmlBlockEnd !== null;
    if (htmlBlockEnd instanceof RegExp) {
      if (htmlBlockEnd.test(line)) htmlBlockEnd = null;
    } else if (htmlBlockEnd === null) {
      const detectedHtml = detectHtmlBlockEnd(line);
      if (detectedHtml !== null) {
        inHtmlBlockLine = true;
        if (detectedHtml !== "same-line") htmlBlockEnd = detectedHtml;
      }
    }

    if (!inHtmlBlockLine && refState === "none" && refTitleDelim === null) {
      const openFence = /^( {0,3})(`{3,}|~{3,})/.exec(line);
      if (openFence && !(openFence[2][0] === "`" && line.slice(openFence[0].length).includes("`"))) {
        if (!flushParagraph()) return false;
        const fenceIndent = openFence[1].length;
        fenceChar = openFence[2][0];
        fenceLength = openFence[2].length;
        fenceMinIndent = listIndents.length > 0 && fenceIndent > 0 ? fenceIndent : 0;
        if (fenceMinIndent === 0) listIndents.length = 0;
        refState = "none";
        refLabelChars = 0;
        pendingRefTitle = false;
        refTitleDelim = null;
        refTitleChars = 0;
        inTable = false;
        continue;
      }
    }

    const stripped = stripBlockPrefix(line);
    if (!stripped) return false;
    const { pos, prefixMarkers } = stripped;
    const content = line.slice(pos);
    const trimmedContent = content.trim();

    if (refTitleDelim !== null) {
      refTitleChars += 1 + content.length;
      if (refTitleChars > maxRefUrlChars) return false;
      if (refTitleChars > maxRefDefLen) maxRefDefLen = refTitleChars;
      if (hasClosingRefTitleDelim(content, 0, refTitleDelim)) {
        refTitleDelim = null;
        refTitleChars = 0;
      }
    } else if (pendingRefTitle) {
      pendingRefTitle = false;
      if (trimmedContent.length > 0) {
        const first = trimmedContent[0];
        if (first === '"' || first === "'" || first === "(") {
          if (trimmedContent.length > maxRefUrlChars) return false;
          if (trimmedContent.length > maxRefDefLen) maxRefDefLen = trimmedContent.length;
          if (!hasClosingRefTitleDelim(trimmedContent, 1, first)) {
            refTitleDelim = first;
            refTitleChars = trimmedContent.length;
          }
        }
      }
    }

    if (refState === "dest") {
      refState = "none";
      const payload = parseRefPayload(trimmedContent);
      if (payload.length > maxRefUrlChars) return false;
      if (payload.length > maxRefDefLen) maxRefDefLen = payload.length;
      if (payload.openTitle !== null) {
        refTitleDelim = payload.openTitle;
        refTitleChars = payload.length;
      } else if (payload.canHaveNextLineTitle) {
        pendingRefTitle = true;
      }
    }

    if (refState === "label") {
      const scanned = scanRefLabelClose(content, 0);
      if (scanned.status === "closed") {
        refState = "none";
        refLabelChars = 0;
        if (content[scanned.closeIdx + 1] === ":") {
          const afterColon = content.slice(scanned.closeIdx + 2).trim();
          if (afterColon.length > 0) {
            const payload = parseRefPayload(afterColon);
            if (payload.length > maxRefUrlChars) return false;
            if (payload.length > maxRefDefLen) maxRefDefLen = payload.length;
            if (payload.openTitle !== null) {
              refTitleDelim = payload.openTitle;
              refTitleChars = payload.length;
            } else if (payload.canHaveNextLineTitle) {
              pendingRefTitle = true;
            }
          } else {
            refState = "dest";
          }
        }
      } else if (scanned.status === "open") {
        refLabelChars += 1 + content.length;
        if (refLabelChars > 1000) {
          refState = "none";
          refLabelChars = 0;
        }
      } else {
        refState = "none";
        refLabelChars = 0;
      }
    }

    if (refState === "none" && refTitleDelim === null && content.startsWith("[")) {
      const scanned = scanRefLabelClose(content, 1);
      if (scanned.status === "closed") {
        if (content[scanned.closeIdx + 1] === ":") {
          const afterColon = content.slice(scanned.closeIdx + 2).trim();
          if (afterColon.length > 0) {
            const payload = parseRefPayload(afterColon);
            if (payload.length > maxRefUrlChars) return false;
            if (payload.length > maxRefDefLen) maxRefDefLen = payload.length;
            if (payload.openTitle !== null) {
              refTitleDelim = payload.openTitle;
              refTitleChars = payload.length;
            } else if (payload.canHaveNextLineTitle) {
              pendingRefTitle = true;
            }
          } else {
            refState = "dest";
          }
        }
      } else if (scanned.status === "open" && content.length <= 1000) {
        refState = "label";
        refLabelChars = content.length;
      }
    }

    const { bqDepth, afterBq } = stripLeadingBlockquotes(line);
    if (bqDepth !== listBqDepth) {
      listIndents.length = 0;
      listBqDepth = bqDepth;
    }
    const listMatch = /^([ \t]*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/.exec(afterBq);
    if (listMatch) {
      totalListItems += 1;
      if (totalListItems > maxListItems) return false;
      if (/^\[[ xX]\](?:[ \t]|$)/.test(content)) {
        totalTaskItems += 1;
        if (totalTaskItems > maxTaskListItems) return false;
      }
      const indent = visualIndent(listMatch[1]);
      while (listIndents.length > 0 && listIndents[listIndents.length - 1] >= indent) {
        listIndents.pop();
      }
      listIndents.push(indent);
      if (listIndents.length + bqDepth > maxBlockNesting) return false;
      if (listIndents.length + Math.max(0, prefixMarkers - 1) > maxBlockNesting) return false;
    } else if (afterBq[0] !== " " && afterBq[0] !== "\t") {
      listIndents.length = 0;
    }

    const isHeading = /^#{1,6}(?:[ \t]|$)/.test(content);
    if (inTable) {
      if (prefixMarkers !== tablePrefixMarkers || isHeading || !content.includes("|")) {
        inTable = false;
      }
    }
    if (!inTable && !isHeading) {
      const tableCols = startsTableAt(lines, lineIdx, content, prefixMarkers);
      if (tableCols > maxTableCols) return false;
      if (tableCols > 0) {
        if (!flushParagraph()) return false;
        inTable = true;
        tablePrefixMarkers = prefixMarkers;
      }
    }
    if (isHeading) {
      totalHeadings += 1;
      if (totalHeadings > maxHeadings) return false;
      if (!flushParagraph()) return false;
    }

    const backticks = indexBacktickRuns(line, pos);
    if (backticks && backticks.runs > maxLineBacktickRuns) return false;
    if (backticks && !inTable) {
      paraBacktickRuns += backticks.runs;
      if (paraBacktickRuns > maxParaBacktickRuns) return false;
      if (totalBacktickWork + paraBacktickRuns * paraBacktickRuns > maxTotalBacktickWork) return false;
    }

    let lineEmRuns = 0;
    let emailRunLen = 0;
    let emailRunTriggers = 0;
    const flushEmailRun = (): boolean => {
      if (emailRunLen > 0) {
        totalEmailLookaheadWork += emailRunLen * emailRunTriggers;
        emailRunLen = 0;
        emailRunTriggers = 0;
        if (totalEmailLookaheadWork > maxEmailLookaheadWork) return false;
      }
      return true;
    };

    // An alphanumeric line without an HTTP prefix cannot add inline or email lookahead work.
    let i = /^[A-Za-z0-9]+$/.test(content) && !/http/i.test(content) ? line.length : pos;
    while (i < line.length) {
      const ch = line[i];
      if (ch === "\\") {
        if (!flushEmailRun()) return false;
        i += 2;
        continue;
      }
      if (ch === "`") {
        let ticks = 1;
        while (i + ticks < line.length && line[i + ticks] === "`") ticks++;
        if (ticks > maxInlineBacktickLen) return false;
        const closer = backticks ? nextClosingBackticks(backticks, i + ticks, ticks) : -1;
        if (closer === -1) {
          emailRunLen += ticks;
          emailRunTriggers += ticks;
          if (totalEmailLookaheadWork + emailRunLen * emailRunTriggers > maxEmailLookaheadWork) return false;
          if (inTable) {
            totalBacktickScanChars += line.length - (i + ticks);
            if (totalBacktickScanChars > maxBacktickScanChars) return false;
          } else if (paraOpenBackticks.has(ticks)) {
            paraOpenBackticks.delete(ticks);
          } else {
            paraOpenBackticks.set(ticks, paraChars + (i - pos));
            if (paraOpenBackticks.size > maxParaOpenBackticks) return false;
          }
          i += ticks;
        } else {
          if (!flushEmailRun()) return false;
          i = closer + ticks;
        }
        continue;
      }
      if (ch === "<") {
        if (!flushEmailRun()) return false;
        totalAngleOpens += 1;
        if (totalAngleOpens > maxAngleOpens) return false;
        const nextCh = line[i + 1];
        if (
          nextCh === "?" ||
          (nextCh === "!" && (line.startsWith("<!--", i) || line.startsWith("<![", i) || /[A-Za-z]/.test(line[i + 2] ?? "")))
        ) {
          totalSpecialHtmlTags += 1;
          if (totalSpecialHtmlTags > maxSpecialHtmlTags) return false;
        }
        i += 1;
        continue;
      }
      if (ch === "[") {
        if (!flushEmailRun()) return false;
        bracketDepth += 1;
        totalBrackets += 1;
        if (bracketDepth > maxInlineNesting) return false;
        i += 1;
        continue;
      }
      if (ch === "]") {
        if (!flushEmailRun()) return false;
        if (bracketDepth > 0) bracketDepth -= 1;
        if (line[i + 1] === "(") {
          totalInlineLinks += 1;
          if (totalInlineLinks > maxInlineLinks) return false;
        }
        i += 1;
        continue;
      }
      if (ch === "(") {
        if (!flushEmailRun()) return false;
        parenDepth += 1;
        if (parenDepth > maxParenNesting) return false;
        i += 1;
        continue;
      }
      if (ch === ")") {
        if (!flushEmailRun()) return false;
        if (parenDepth > 0) parenDepth -= 1;
        i += 1;
        continue;
      }
      if (isAutolinkAt(line, i, pos)) {
        const auto = measureAutolink(line, i);
        if (auto.len > maxRefUrlChars) return false;
        totalAutolinkWork += auto.len * auto.backpedalSteps;
        if (totalAutolinkWork > maxTotalAutolinkWork) return false;
      }
      if (ch === "*" || ch === "_" || ch === "~") {
        let end = i + 1;
        while (end < line.length && line[end] === ch) end++;
        const runLen = end - i;
        emailRunLen += runLen;
        emailRunTriggers += runLen;
        if (totalEmailLookaheadWork + emailRunLen * emailRunTriggers > maxEmailLookaheadWork) return false;
        const prev = i > 0 ? line[i - 1] : " ";
        const next = end < line.length ? line[end] : " ";
        const canOpen = !/\s/.test(next) && (ch !== "_" || !/[A-Za-z0-9]/.test(prev));
        const canClose = !/\s/.test(prev) && (ch !== "_" || !/[A-Za-z0-9]/.test(next));
        if ((canOpen || canClose) && runLen > maxInlineNesting) return false;
        if (canOpen || canClose) {
          lineEmRuns += 1;
          if (lineEmRuns > maxLineEmRuns) return false;
          if (!inTable) {
            paraEmRuns += 1;
            if (paraEmRuns > maxParaEmRuns) return false;
            if (totalEmWork + paraEmRuns * paraEmRuns > maxTotalEmWork) return false;
          }
        }
        if (ch === "*") {
          if (canOpen && !canClose) starDepth += 1;
          else if (canClose && !canOpen && starDepth > 0) starDepth -= 1;
          else if (canOpen && canClose) starDepth = starDepth > 0 ? starDepth - 1 : starDepth + 1;
        } else if (ch === "_") {
          if (canOpen && !canClose) underDepth += 1;
          else if (canClose && !canOpen && underDepth > 0) underDepth -= 1;
          else if (canOpen && canClose) underDepth = underDepth > 0 ? underDepth - 1 : underDepth + 1;
        } else {
          if (canOpen && !canClose) tildeDepth += 1;
          else if (canClose && !canOpen && tildeDepth > 0) tildeDepth -= 1;
          else if (canOpen && canClose) tildeDepth = tildeDepth > 0 ? tildeDepth - 1 : tildeDepth + 1;
        }
        if (starDepth + underDepth + tildeDepth > maxInlineNesting) return false;
        i = end;
        continue;
      }
      if (isEmailLocalChar(ch.charCodeAt(0))) {
        emailRunLen += 1;
        if (isEmailTriggerChar(ch)) {
          emailRunTriggers += 1;
        } else if ((ch === "h" || ch === "H") && /^http/i.test(line.slice(i, i + 4))) {
          emailRunTriggers += 1;
        } else if ((ch === "w" || ch === "W") && /^www\./i.test(line.slice(i, i + 4))) {
          emailRunTriggers += 1;
        }
        if (totalEmailLookaheadWork + emailRunLen * emailRunTriggers > maxEmailLookaheadWork) return false;
      } else {
        if (!flushEmailRun()) return false;
      }
      i += 1;
    }
    if (!flushEmailRun()) return false;

    if (inTable) {
      totalEmWork += lineEmRuns * lineEmRuns;
      if (totalEmWork > maxTotalEmWork) return false;
      if (backticks) {
        totalBacktickWork += backticks.runs * backticks.runs;
        if (totalBacktickWork > maxTotalBacktickWork) return false;
      }
      bracketDepth = 0;
      parenDepth = 0;
      starDepth = 0;
      underDepth = 0;
      tildeDepth = 0;
    } else if (isHeading) {
      if (!flushParagraph()) return false;
    } else {
      paraChars += content.length + 1;
    }
  }
  if (!flushParagraph()) return false;
  if (maxRefDefLen > 0 && (maxRefDefLen + 64) * totalBrackets > maxRenderedChars) return false;
  return true;
}

function safeUrl(href: string, allowFragment = false): string | undefined {
  if (allowFragment && safeFragmentRe.test(href)) return href;
  try {
    const url = new URL(href);
    if (url.protocol === "https:" || url.protocol === "http:") return escapeHtml(url.href);
  } catch {
    return undefined;
  }
}

function slugifyHeading(text: string, seen: Map<string, number>): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[`*_~()[\]{}.,:;!?/\\]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-鿿-]/g, "")
    .slice(0, 48);
  const base = cleaned.length > 0 ? cleaned : "section";
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count === 1 ? `sec-${base}` : `sec-${base}-${count}`;
}

function extractContinuityFromTokens(tokens: Token[]): ContinuityCounts | null {
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
  const total = fixed + stillOpen + stale;
  if (
    !Number.isSafeInteger(fixed) ||
    !Number.isSafeInteger(stillOpen) ||
    !Number.isSafeInteger(stale) ||
    !Number.isSafeInteger(total)
  ) {
    return null;
  }
  return {
    status,
    fixed,
    stillOpen,
    stale,
    total,
    raw: `${status} (fixed ${fixed} / still-open ${stillOpen} / stale ${stale})`,
  };
}

export function extractContinuityCounts(body: string): ContinuityCounts | null {
  const normalized = body.replace(/^\uFEFF/, "");
  if (!isSafeToParseMarkdown(normalized)) return null;
  try {
    return extractContinuityFromTokens(lexer(normalized));
  } catch {
    return null;
  }
}

class SafeRenderer extends Renderer {
  readonly toc: TocHeading[] = [];
  readonly headingSlugs = new Map<string, number>();
  readonly stillOpenTitles: string[] = [];
  stillOpenRowCount = 0;
  resolvedOrStaleRowCount = 0;
  private emittedChars = 0;

  private track(chunk: string): string {
    this.emittedChars += chunk.length;
    if (this.emittedChars > maxRenderedChars) {
      throw new Error("Rendered output exceeded limit");
    }
    return chunk;
  }

  override html({ text, block }: Tokens.HTML | Tokens.Tag): string {
    const escaped = escapeHtml(text);
    return this.track(block ? `<pre class="raw-html">${escaped}</pre>\n` : escaped);
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    return this.track("escaped" in token && token.escaped ? escapeHtml(token.text) : super.text(token));
  }

  override codespan(token: Tokens.Codespan): string {
    return this.track(super.codespan(token));
  }

  override code(token: Tokens.Code): string {
    return this.track(super.code({ ...token, escaped: false }));
  }

  override heading({ tokens, depth }: Tokens.Heading): string {
    const rendered = this.parser.parseInline(tokens);
    if (depth === 2 || depth === 3) {
      const plain = this.parser.parseInline(tokens, this.parser.textRenderer).trim();
      const id = slugifyHeading(plain, this.headingSlugs);
      this.toc.push({ depth, id, text: plain });
      this.track(`<h${depth} id="${id}"></h${depth}>\n<li class="toc-h${depth}"><a href="#${id}">${plain}</a></li>`);
      return `<h${depth} id="${id}">${rendered}</h${depth}>\n`;
    }
    this.track(`<h${depth}></h${depth}>\n`);
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
    const alignAttr = token.align === "left" || token.align === "center" || token.align === "right"
      ? ` align="${token.align}"`
      : "";
    const trimmed = content.trim();
    const statusAttr = !token.header && exactStatusRe.test(trimmed) ? ` data-status="${trimmed}"` : "";
    return this.track(`<${type}${alignAttr}${statusAttr}>${content}</${type}>\n`);
  }

  override link({ href, tokens, text, autolink }: Tokens.Link): string {
    const label = autolink ? escapeHtml(text) : this.parser.parseInline(tokens);
    const url = safeUrl(href, true);
    if (!url) return this.track(label);
    if (url.startsWith("#")) return this.track(`<a href="${url}">${label}</a>`);
    return this.track(`<a href="${url}" rel="noopener noreferrer">${label}</a>`);
  }

  override image({ href, tokens }: Tokens.Image): string {
    const alt = escapeHtml(this.parser.parseInline(tokens, this.parser.textRenderer));
    const url = safeUrl(href, false);
    if (!url) return this.track(alt);
    return this.track(`<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`);
  }
}

function fallbackRenderedReport(normalized: string): RenderedReport {
  return {
    html: `<pre>${escapeHtml(normalized)}</pre>`,
    toc: [],
    continuity: null,
    hasStillOpenRows: false,
    hasResolvedOrStaleRows: false,
    stillOpenRowCount: 0,
    totalStatusRowCount: 0,
    stillOpenTitles: [],
  };
}

export function renderReportWithMeta(body: string): RenderedReport {
  const normalized = body.replace(/^\uFEFF/, "");
  if (!isSafeToParseMarkdown(normalized)) {
    return fallbackRenderedReport(normalized);
  }
  const renderer = new SafeRenderer();
  try {
    const parser = new Marked().setOptions({ renderer });
    const tokens = parser.lexer(normalized);
    const continuity = extractContinuityFromTokens(tokens);
    const html = parser.parser(tokens);
    if (html.length > maxRenderedChars) {
      return fallbackRenderedReport(normalized);
    }
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
  } catch {
    return fallbackRenderedReport(normalized);
  }
}

export function renderReport(body: string): string {
  return renderReportWithMeta(body).html;
}
