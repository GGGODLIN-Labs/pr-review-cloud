import { randomToken, redirect, tokenHash } from "./auth.ts";
import { readBoundedBody } from "./body.ts";
import { escapeHtml } from "./markdown.ts";
import { htmlResponse, reportPage } from "./page.ts";

export const reportRoute = /^\/workspace\/reports\/([A-Za-z0-9-]+)(?:\/(raw|share|unshare|delete))?$/;
export const revokeRoute = /^\/workspace\/keys\/([A-Za-z0-9-]+)\/revoke$/;
export const sharedRoute = /^\/s\/([A-Za-z0-9_-]{43})$/;

interface ReportSummary {
  id: string;
  title: string;
  size_bytes: number;
  created_at: string;
  continuity_summary: string | null;
  share_token: string | null;
}

export async function workspacePage(db: D1Database, user: { id: string; github_login: string }): Promise<Response> {
  const [reports, keys] = await Promise.all([
    db.prepare(`
      SELECT id, title, size_bytes, created_at, continuity_summary, share_token
      FROM reports WHERE user_id = ? ORDER BY created_at DESC, id DESC
    `).bind(user.id).all<ReportSummary>(),
    db.prepare("SELECT id, key_prefix FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
      .bind(user.id).all<{ id: string; key_prefix: string }>(),
  ]);
  const reportsList = reports.results.map((report) => `
    <li><a href="/workspace/reports/${encodeURIComponent(report.id)}">${escapeHtml(report.title)}</a>
      <span class="workspace-meta">${report.size_bytes} bytes · <time>${escapeHtml(report.created_at)} UTC</time> · ${report.share_token ? "已分享" : "私有"}</span>
      ${report.continuity_summary ? `<span>${escapeHtml(report.continuity_summary)}</span>` : ""}
    </li>`).join("");
  const keysList = keys.results.map((key) => `
    <li><form method="post" action="/workspace/keys/${encodeURIComponent(key.id)}/revoke">
      <code>${escapeHtml(key.key_prefix)}…</code> <button>撤銷金鑰</button>
    </form></li>`).join("");
  return htmlResponse("工作區", `
    <h1>工作區</h1>
    <p>GitHub：${escapeHtml(user.github_login)}</p>
    <form method="post" action="/auth/logout"><button>登出</button></form>
    <section>
      <h2>上傳報告</h2>
      <form method="post" action="/workspace/reports" enctype="multipart/form-data">
        <label>選取主報告 <input type="file" name="file" accept=".md" required></label>
        <button>上傳</button>
      </form>
      <p>本機報告在 <code>~/.claude/pr-review-reports/</code>。如果看不到隱藏目錄，macOS 按 <kbd>Cmd + Shift + .</kbd>，Linux 按 <kbd>Ctrl + H</kbd>。</p>
      <p>請選擇主報告 <code>.md</code>，大小上限 128 KB。</p>
    </section>
    <section>
      <h2>個人 API 金鑰</h2>
      <form method="post" action="/workspace/keys"><button>建立金鑰和上傳指令</button></form>
      ${keysList ? `<ul class="workspace-list">${keysList}</ul>` : "<p>沒有有效的金鑰。</p>"}
    </section>
    <section>
      <h2>歷史報告</h2>
      ${reportsList ? `<ul class="workspace-list">${reportsList}</ul>` : "<p>尚未上傳報告。</p>"}
    </section>
  `, 200, true);
}

export async function issueKey(db: D1Database, userId: string, origin: string): Promise<Response> {
  const key = `prc_${randomToken()}`;
  await db.prepare("INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, "CLI", key.slice(0, 12), await tokenHash(key)).run();
  const target = `${origin}/api/reports?filename=pr-123-review.md`.replaceAll("'", "'\\''");
  const command = `curl -fsS -X POST '${target}' -H 'Authorization: Bearer ${key}' --data-binary @"$HOME/.claude/pr-review-reports/repo/pr-123-review.md"`;
  return htmlResponse("個人 API 金鑰", `
    <h1>個人 API 金鑰</h1>
    <p>完整金鑰只顯示這一次。請妥善保存，並避免把含金鑰的指令留在 shell 歷史。</p>
    <p><code>${escapeHtml(key)}</code></p>
    <p><label for="command">複製單行上傳指令，再換成你的檔案路徑與檔名。</label></p>
    <textarea class="copy-command" id="command" rows="4" readonly>${escapeHtml(command)}</textarea>
    <p><a href="/workspace">返回工作區</a></p>
  `, 201, true);
}

export async function revokeKey(db: D1Database, userId: string, keyId: string): Promise<Response> {
  await db.prepare("UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(keyId, userId).run();
  return redirect("/workspace");
}

export async function readReport(db: D1Database, userId: string, reportId: string, raw: boolean, origin: string): Promise<Response> {
  const report = await db.prepare("SELECT title, markdown_body, share_token FROM reports WHERE id = ? AND user_id = ?")
    .bind(reportId, userId).first<{ title: string; markdown_body: string; share_token: string | null }>();
  if (!report) return new Response("找不到報告。", { status: 404 });
  if (raw) {
    return new Response(report.markdown_body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${reportId}.md"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const path = `/workspace/reports/${reportId}`;
  const share = report.share_token ? `
    <p><a href="/s/${encodeURIComponent(report.share_token)}">開啟唯讀分享頁</a></p>
    <label>複製分享連結 <input class="copy-command" readonly value="${escapeHtml(`${origin}/s/${report.share_token}`)}"></label>
    <form method="post" action="${path}/unshare"><button>撤銷分享</button></form>
  ` : `
    <p>這份報告目前是私有。</p>
    <form method="post" action="${path}/share">
      <label><input type="checkbox" name="confirm_code_anchors" value="1" required>報告可能含有程式碼錨點片段。我確認持有連結的人可以讀取全文。</label>
      <button>啟用分享</button>
    </form>
  `;
  return reportPage(report.title, report.markdown_body, { signedIn: true, actions: `
    <a href="${path}/raw">下載 Markdown 原檔</a>
    ${share}
    <form method="post" action="${path}/delete"><button>刪除報告</button></form>
  ` });
}

export async function readShare(db: D1Database, token: string): Promise<Response> {
  const report = await db.prepare("SELECT title, markdown_body FROM reports WHERE share_token = ?")
    .bind(token).first<{ title: string; markdown_body: string }>();
  return report ? reportPage(report.title, report.markdown_body) : new Response("找不到報告。", { status: 404 });
}

export async function changeReport(
  request: Request, db: D1Database, userId: string, reportId: string, action: string,
): Promise<Response> {
  if (action === "delete") {
    await db.prepare("DELETE FROM reports WHERE id = ? AND user_id = ?").bind(reportId, userId).run();
    return redirect("/workspace");
  }

  let result: D1Result;
  if (action === "share") {
    const type = request.headers.get("Content-Type") ?? "";
    const body = /^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(type)
      ? await readBoundedBody(request, 1024).catch(() => null)
      : null;
    const form = body ? new URLSearchParams(new TextDecoder().decode(body)) : null;
    if (form?.get("confirm_code_anchors") !== "1") {
      return new Response("請先確認報告可能包含程式碼錨點片段。", { status: 400 });
    }
    result = await db.prepare(`
      UPDATE reports SET share_token = COALESCE(share_token, ?), shared_at = COALESCE(shared_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND user_id = ?
    `).bind(randomToken(), reportId, userId).run();
  } else {
    result = await db.prepare("UPDATE reports SET share_token = NULL, shared_at = NULL WHERE id = ? AND user_id = ?")
      .bind(reportId, userId).run();
  }
  if (!result.meta.changes) return new Response("找不到報告。", { status: 404 });
  return redirect(`/workspace/reports/${reportId}`);
}
