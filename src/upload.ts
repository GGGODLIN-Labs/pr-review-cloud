import { lexer, type Tokens } from "marked";
import { readBoundedBody } from "./body.ts";
import { errorPage } from "./page.ts";

const maxBytes = 131_072;
const auditFile = "不接受 .audit.md 稽核副檔，請改傳不含完整原始證據的主報告 .md。";
const tooLarge = "報告檔案超過 128 KB（131,072 bytes）上限，請精簡非必要內容後重新上傳。";

function uploadError(fromCLI: boolean, title: string, message: string, status: number): Response {
  if (fromCLI) return status === 413 ? new Response(null, { status }) : new Response(message, { status });
  return errorPage(title, message, status, { signedIn: true, backHref: "/workspace", backLabel: "返回工作區" });
}

export async function uploadReport(request: Request, db: D1Database, userId: string, fromCLI: boolean): Promise<Response> {
  const type = request.headers.get("Content-Type") ?? "";
  const multipart = /^multipart\/form-data(?:\s*;|$)/i.test(type);
  if (!multipart && !fromCLI) return uploadError(false, "上傳格式錯誤", "請從選檔表單上傳報告。", 400);
  let filename = multipart ? null : new URL(request.url).searchParams.get("filename") ?? request.headers.get("X-Filename");
  if (filename && /\.audit\.md$/i.test(filename)) return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);

  // Multipart needs a separate allowance for framing before we can measure the file itself.
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request, maxBytes + (multipart ? 16_384 : 0));
    if (!bytes) return uploadError(fromCLI, "檔案超過上限", tooLarge, 413);
    if (multipart) {
      const form = await new Response(bytes, { headers: { "Content-Type": type } }).formData();
      const file = form.get("file");
      if (!file || typeof file === "string" || !file.name) return uploadError(fromCLI, "未選取檔案", "請選擇報告檔案。", 400);
      filename = file.name;
      if (/\.audit\.md$/i.test(filename)) return uploadError(fromCLI, "不支援稽核副檔", auditFile, 400);
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
  if (!markdown.trim()) return uploadError(fromCLI, "報告內容空白", "報告內容不可空白。", 400);

  const tokens = lexer(markdown.replace(/^﻿/, ""));
  const headings = tokens.filter((token): token is Tokens.Heading => token.type === "heading" && Boolean(token.text.trim()));
  const fields = tokens.flatMap((token) => token.type === "paragraph" && typeof token.text === "string" ? token.text.split(/\r?\n/) : []);
  const prs = fields.flatMap((line) => line.match(/^\*\*PR\*\*:\s*(\S.*)$/)?.slice(1) ?? []);
  const projection = prs.length === 1 && fields.some((line) => /^\*\*Report projection schema\*\*:\s*2\s*$/.test(line));
  const continuity = projection
    ? fields.map((line) => line.match(/^\*\*Prior review continuity\*\*:\s*(\S.*)$/)?.[1]).find(Boolean) ?? null
    : null;
  const title = (projection ? headings.find((heading) => heading.depth === 1)?.text : undefined)
    ?? headings[0]?.text ?? filename?.trim() ?? "未命名報告";

  const id = crypto.randomUUID();
  // A separate count and insert could admit two uploads competing for the remaining slot.
  let result: D1Result;
  try {
    result = await db.prepare(`
      INSERT INTO reports (id, user_id, title, pr_ref, schema_version, continuity_summary, markdown_body, size_bytes)
      SELECT ?, users.id, ?, ?, ?, ?, ?, ? FROM users
      WHERE users.id = ? AND (SELECT COUNT(*) FROM reports WHERE user_id = users.id)
        < CASE users.plan WHEN 'pro' THEN 500 WHEN 'pro_pass' THEN 500 ELSE 20 END
    `).bind(id, title, projection ? prs[0] : null, projection ? 2 : null, continuity, markdown, bytes.byteLength, userId).run();
  } catch (error) {
    if (error instanceof Error && /full|quota|space|storage|capacity/i.test(error.message)) {
      return uploadError(fromCLI, "儲存空間已滿", "雲端資料庫儲存空間已達平台容量上限，請稍後再試或刪除舊報告。", 507);
    }
    throw error;
  }
  if (!result.meta.changes) {
    return uploadError(fromCLI, "已達報告數量上限", "報告已達配額，請刪除舊報告或升級方案。", 409);
  }
  const location = `/workspace/reports/${id}`;
  return fromCLI
    ? Response.json({ id }, { status: 201, headers: { Location: location } })
    : new Response(null, { status: 303, headers: { Location: location } });
}
