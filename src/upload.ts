import { lexer, type Token, type Tokens } from "marked";
import { readBoundedBody } from "./body.ts";
import { isSafeToParseMarkdown } from "./markdown.ts";
import { errorPage } from "./page.ts";

const maxBytes = 131_072;
const maxMetaLength = 200;
const auditFile = "不接受 .audit.md 稽核副檔，請改傳不含完整原始證據的主報告 .md。";
const tooLarge = "報告檔案超過 128 KB（131,072 bytes）上限，請精簡非必要內容後重新上傳。";
const auditRole = /^\*\*Report\s+artifact\s+role\*\*:[ \t]*audit\b/i;
const markdownMediaTypes = new Set([
  "text/markdown", "text/plain", "application/octet-stream", "application/x-www-form-urlencoded",
]);
const quotaLimitSql = "CASE users.plan WHEN 'pro' THEN 500 WHEN 'pro_pass' THEN 500 ELSE 20 END";

function cleanMetadataText(value: string | null | undefined, maxLength = maxMetaLength): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function basenameOf(filename: string | null | undefined): string | null {
  if (!filename) return null;
  const trimmed = filename.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(/[/\\]/);
  return cleanMetadataText(segments[segments.length - 1]);
}

function isAuditFilename(filename: string | null | undefined): boolean {
  if (!filename) return false;
  const cleaned = filename.replace(/[\u0000-\u001f\u007f]+/g, "").trim();
  return /\.audit\.md$/i.test(filename.trim()) || /\.audit\.md$/i.test(cleaned);
}

function looksLikeAuditSidecar(markdown: string): boolean {
  const head = markdown.replace(/^[\uFEFF\u0000-\u0020\u007f\s]+/, "").split(/\r\n|\r|\n/, 40).join("\n");
  if (/^\*\*Report projection schema\*\*:\s*[23]\s*$/m.test(head)) return false;
  return /^(?:#\s+PR\s+Review\s+Audit\s+Sidecar\b|\*\*Audit\s+sidecar\*\*:|\*\*Report\s+artifact\s+role\*\*:\s*audit\b)/im.test(head);
}

function uploadError(fromCLI: boolean, title: string, message: string, status: number): Response {
  if (fromCLI) return status === 413 ? new Response(null, { status }) : new Response(message, { status });
  return errorPage(title, message, status, { signedIn: true, backHref: "/workspace", backLabel: "返回工作區" });
}

export async function uploadReport(request: Request, db: D1Database, userId: string, fromCLI: boolean): Promise<Response> {
  const type = (request.headers.get("Content-Type") ?? "").trim();
  const mediaType = type.split(";", 1)[0].trim().toLowerCase();
  const multipart = mediaType === "multipart/form-data";
  if (!multipart && !fromCLI) return uploadError(false, "上傳格式錯誤", "請從選檔表單上傳報告。", 400);
  if (!multipart && type && !markdownMediaTypes.has(mediaType)) {
    return uploadError(fromCLI, "上傳格式錯誤", "請上傳 Markdown 報告。", 415);
  }
  const queryFilenames = new URL(request.url).searchParams.getAll("filename");
  const queryFilename = queryFilenames[0] ?? null;
  const headerFilename = request.headers.get("X-Filename");
  if (queryFilenames.some(isAuditFilename) || isAuditFilename(headerFilename)) {
    return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);
  }
  let filename = multipart ? null : basenameOf(queryFilename) ?? basenameOf(headerFilename);

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request, maxBytes + (multipart ? 16_384 : 0));
    if (!bytes) return uploadError(fromCLI, "檔案超過上限", tooLarge, 413);
    if (multipart) {
      const form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
      const files = form.getAll("file");
      if (files.length > 1) {
        return uploadError(fromCLI, "報告檔案數量不符", "請選擇一份報告檔案。", 400);
      }
      const [file] = files;
      if (!file || typeof file === "string" || !file.name || !file.name.trim()) {
        return uploadError(fromCLI, "未選取檔案", "請選擇報告檔案。", 400);
      }
      if (isAuditFilename(file.name)) return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);
      filename = basenameOf(file.name);
      if (file.size > maxBytes) return uploadError(fromCLI, "檔案超過上限", tooLarge, 413);
      bytes = new Uint8Array(await file.arrayBuffer());
    }
  } catch {
    return uploadError(fromCLI, "讀取檔案失敗", "無法讀取上傳檔案。", 400);
  }

  let markdown: string;
  try {
    markdown = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return uploadError(fromCLI, "編碼格式不符", "報告必須使用 UTF-8 編碼。", 400);
  }
  if (!markdown.replace(/[\u0000-\u001f\u007f]+/g, "").trim()) {
    return uploadError(fromCLI, "報告內容空白", "報告內容不可空白。", 400);
  }
  if (looksLikeAuditSidecar(markdown)) return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);

  const normalized = markdown.replace(/^\uFEFF/, "");
  let tokens: Token[] | null = null;
  if (isSafeToParseMarkdown(normalized)) {
    try {
      tokens = lexer(normalized);
    } catch {
      tokens = null;
    }
  }
  const headings = (tokens ?? []).filter((token): token is Tokens.Heading => token.type === "heading" && Boolean(token.text.trim()));
  const fields = tokens?.flatMap((token) => token.type === "paragraph" && typeof token.text === "string" ? token.text.split(/\r?\n/) : []) ?? [];
  // An explicit role still takes precedence when the parser falls back to plain text.
  const auditFields = tokens ? fields : normalized.split(/\r\n|\r|\n/);
  if (auditFields.some((line) => auditRole.test(line.trimStart()))) {
    return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);
  }
  const schemaLine = fields.map((line) => line.match(/^\*\*Report projection schema\*\*:\s*([23])\s*$/)?.[1]).find(Boolean);
  const schemaVersion = schemaLine ? Number.parseInt(schemaLine, 10) : null;
  const prs = fields.flatMap((line) => line.match(/^\*\*PR\*\*:\s*(\S.*)$/)?.slice(1) ?? []);
  const reviewSets = fields.flatMap((line) => line.match(/^\*\*Review set identity\*\*:\s*(\S.*)$/)?.slice(1) ?? []);
  const rawPrRef = schemaVersion === 2 && prs.length === 1
    ? prs[0]
    : schemaVersion === 3 && reviewSets.length === 1
      ? reviewSets[0]
      : schemaVersion === 3 && prs.length === 1
        ? prs[0]
        : null;
  const prRef = cleanMetadataText(rawPrRef);
  const projection = schemaVersion !== null && prRef !== null;
  const continuity = projection
    ? cleanMetadataText(fields.map((line) => line.match(/^\*\*Prior review continuity\*\*:\s*(\S.*)$/)?.[1]).find(Boolean))
    : null;
  const rawTitle = (projection ? headings.find((heading) => heading.depth === 1)?.text : undefined)
    ?? headings[0]?.text ?? filename ?? "未命名報告";
  const unwrappedTitle = rawTitle.trim().replace(/^`([^`]+)`$/, "$1");
  const title = cleanMetadataText(unwrappedTitle) ?? "未命名報告";

  const id = crypto.randomUUID();
  // Count the other rows plus this insert so the receipt does not depend on when RETURNING sees the new row.
  let usage: { count: number; quota_limit: number } | null;
  try {
    usage = await db.prepare(`
      INSERT INTO reports (id, user_id, title, pr_ref, schema_version, continuity_summary, markdown_body, size_bytes)
      SELECT ?, users.id, ?, ?, ?, ?, ?, ? FROM users
      WHERE users.id = ? AND (SELECT COUNT(*) FROM reports WHERE user_id = users.id) < ${quotaLimitSql}
      RETURNING (SELECT COUNT(*) + 1 FROM reports WHERE user_id = ? AND id <> ?) AS count,
        (SELECT ${quotaLimitSql} FROM users WHERE id = ?) AS quota_limit
    `).bind(id, title, prRef, projection ? schemaVersion : null, continuity, markdown, bytes.byteLength, userId, userId, id, userId)
      .first<{ count: number; quota_limit: number }>();
  } catch (error) {
    if (error instanceof Error && /full|quota|space|storage|capacity/i.test(error.message)) {
      return uploadError(fromCLI, "儲存空間已滿", "雲端資料庫儲存空間已達平台容量上限，請稍後再試或刪除舊報告。", 507);
    }
    throw error;
  }
  if (!usage) {
    return uploadError(fromCLI, "已達報告數量上限", "報告已達配額，請刪除舊報告或升級方案。", 409);
  }
  const location = `/workspace/reports/${id}`;
  if (!fromCLI) {
    return new Response(null, { status: 303, headers: { Location: location } });
  }
  const origin = new URL(request.url).origin;
  return Response.json(
    {
      id,
      url: `${origin}${location}`,
      raw_url: `${origin}${location}/raw`,
      count: usage.count,
      limit: usage.quota_limit,
    },
    { status: 201, headers: { Location: location } },
  );
}
