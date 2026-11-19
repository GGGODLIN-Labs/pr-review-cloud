import { randomToken, redirect, tokenHash, type SignedInUser } from "./auth.ts";
import { readBoundedBody } from "./body.ts";
import { escapeHtml } from "./markdown.ts";
import { errorPage, htmlResponse, reportPage } from "./page.ts";

export const reportRoute = /^\/workspace\/reports\/([A-Za-z0-9-]+)(?:\/(raw|share|unshare|delete))?$/;
export const revokeRoute = /^\/workspace\/keys\/([A-Za-z0-9-]+)\/revoke$/;
export const sharedRoute = /^\/s\/([A-Za-z0-9_-]{43})(?:\/(raw))?$/;

interface ReportSummary {
  id: string;
  title: string;
  pr_ref: string | null;
  size_bytes: number;
  created_at: string;
  continuity_summary: string | null;
  share_token: string | null;
}

interface KeySummary {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
}

function safeAvatarUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function formatReadableSize(bytes: number): string {
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB (${bytes} bytes)`;
  return `${bytes} bytes`;
}

export async function workspacePage(
  db: D1Database, user: SignedInUser, billingLive: boolean,
): Promise<Response> {
  const plan = user.plan === "pro" || user.plan === "pro_pass" ? user.plan : "free";
  const limit = plan === "free" ? 20 : 500;
  const [reports, keys] = await Promise.all([
    db.prepare(`
      SELECT id, title, pr_ref, size_bytes, created_at, continuity_summary, share_token
      FROM reports WHERE user_id = ? ORDER BY created_at DESC, rowid DESC
    `).bind(user.id).all<ReportSummary>(),
    db.prepare("SELECT id, name, key_prefix, created_at FROM api_keys WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC")
      .bind(user.id).all<KeySummary>(),
  ]);
  const used = reports.results.length;
  const pct = Math.min(100, Math.round((used / limit) * 100));
  const avatar = safeAvatarUrl(user.avatar_url);

  const reportsList = reports.results.map((report) => `
    <li>
      <div class="report-row-head">
        <a class="report-row-title" href="/workspace/reports/${encodeURIComponent(report.id)}">${escapeHtml(report.title)}</a>
        <span class="badge${report.share_token ? " is-shared" : ""}">${report.share_token ? "已分享" : "私有"}</span>
      </div>
      <span class="workspace-meta">${formatReadableSize(report.size_bytes)} · <time>${escapeHtml(report.created_at)} UTC</time>${report.pr_ref ? ` · ${escapeHtml(report.pr_ref)}` : ""}</span>
      ${report.continuity_summary ? `<span class="workspace-meta">${escapeHtml(report.continuity_summary)}</span>` : ""}
    </li>`).join("");

  const keysList = keys.results.map((key) => `
    <li class="key-row">
      <div>
        <code>${escapeHtml(key.key_prefix)}…</code>
        <span class="workspace-meta">${escapeHtml(key.name)} · 建立於 <time>${escapeHtml(key.created_at)} UTC</time></span>
      </div>
      <details class="danger-confirm">
        <summary>撤銷金鑰</summary>
        <p class="confirm-note">撤銷後，使用此金鑰的 CLI 上傳將立即失效。</p>
        <form method="post" action="/workspace/keys/${encodeURIComponent(key.id)}/revoke">
          <button class="btn-danger">確認撤銷金鑰</button>
        </form>
      </details>
    </li>`).join("");

  return htmlResponse("工作區", `
    <div class="workspace-header">
      <div class="workspace-identity">
        ${avatar ? `<img class="avatar" src="${escapeHtml(avatar)}" alt="" width="40" height="40" loading="lazy" referrerpolicy="no-referrer">` : ""}
        <div>
          <h1>工作區</h1>
          <p class="workspace-login">GitHub：${escapeHtml(user.github_login)}</p>
        </div>
      </div>
      <form method="post" action="/auth/logout"><button>登出</button></form>
    </div>

    <div class="workspace-grid">
      <section class="card">
        <h2>方案與配額</h2>
        <p>目前方案：${plan} · 已用 ${used} / ${limit} 份 · 上限 ${limit} 份報告。</p>
        <div class="quota-track" role="img" aria-label="已使用 ${used} 份，上限 ${limit} 份">
          <div class="quota-fill${pct >= 80 ? " is-high" : ""}" style="width:${pct}%"></div>
        </div>
        ${billingLive ? `
          <ul>
            <li><a href="/workspace/checkout?plan=pro">Pro 專業訂閱</a>：US$19／月，最高 500 份報告。</li>
            <li><a href="/workspace/checkout?plan=pro_pass">Pro Pass 個人買斷</a>：US$49 一次付清，最高 500 份報告。</li>
          </ul>
          <p class="hint">Pro Pass 在服務存續期間免月費，保證自購買日起至少 12 個月正常運作；停機前至少 30 天通知下載備份，未滿 12 個月按比例退費。</p>
        ` : '<p class="hint">付費升級即將開放。目前免費方案即可使用跨輪對帳、CLI 上傳與可撤銷分享。</p>'}
      </section>

      <section class="card">
        <h2>上傳報告</h2>
        <form class="upload-form" method="post" action="/workspace/reports" enctype="multipart/form-data">
          <label>選取主報告 <input type="file" name="file" accept=".md" required></label>
          <button class="btn-primary">上傳報告</button>
        </form>
        <p class="hint">本機報告在 <code>~/.claude/pr-review-reports/</code>。如果看不到隱藏目錄，macOS 按 <kbd>Cmd + Shift + .</kbd>，Linux 按 <kbd>Ctrl + H</kbd>。</p>
        <p class="hint">請選擇主報告 <code>.md</code>（不收 <code>.audit.md</code> 稽核副檔），大小上限 128 KB。</p>
      </section>
    </div>

    <section class="card">
      <h2>個人 API 金鑰</h2>
      <form method="post" action="/workspace/keys"><button>建立金鑰和上傳指令</button></form>
      ${keysList ? `<ul class="workspace-list">${keysList}</ul>` : '<p class="hint">沒有有效的金鑰。</p>'}
    </section>

    <section class="card">
      <h2>歷史報告（${used}）</h2>
      ${reportsList ? `<ul class="workspace-list">${reportsList}</ul>` : '<p class="hint">尚未上傳報告。</p>'}
    </section>
  `, 200, true, { privatePage: true });
}

export async function issueKey(db: D1Database, userId: string, origin: string): Promise<Response> {
  const key = `prc_${randomToken()}`;
  await db.prepare("INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), userId, "CLI", key.slice(0, 12), await tokenHash(key)).run();
  const target = `${origin}/api/reports?filename=pr-123-review.md`.replaceAll("'", "'\\''");
  const command = `curl --fail-with-body -sS -X POST '${target}' -H 'Authorization: Bearer ${key}' --data-binary @"$HOME/.claude/pr-review-reports/<host__owner__repo>/pr-123-review.md"`;
  return htmlResponse("個人 API 金鑰", `
    <section class="card">
      <h1>個人 API 金鑰</h1>
      <p>完整金鑰只顯示這一次。請妥善保存，並避免把含金鑰的指令留在 shell 歷史；重新整理此頁會再次簽發新金鑰。</p>
      <p><code>${escapeHtml(key)}</code></p>
      <p><label for="command">複製單行上傳指令，再把 <code>&lt;host__owner__repo&gt;</code> 與檔名換成你的報告路徑（<code>--fail-with-body</code> 會在失敗時印出伺服器錯誤說明）。</label></p>
      <textarea class="copy-command" id="command" rows="4" readonly>${escapeHtml(command)}</textarea>
      <p><a class="btn" href="/workspace">返回工作區</a></p>
    </section>
  `, 201, true, { privatePage: true });
}

export async function revokeKey(db: D1Database, userId: string, keyId: string): Promise<Response> {
  await db.prepare("UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
    .bind(keyId, userId).run();
  return redirect("/workspace");
}

function renderPrTimeline(
  prRef: string,
  siblings: { id: string; created_at: string; continuity_summary: string | null }[],
  currentId: string,
): string {
  if (siblings.length < 2) return "";
  const links = siblings.map((item, idx) => {
    const date = item.created_at.slice(0, 10);
    const current = item.id === currentId ? ' aria-current="page"' : "";
    return `<a href="/workspace/reports/${encodeURIComponent(item.id)}"${current}>Round ${idx + 1} · ${escapeHtml(date)}</a>`;
  }).join("");
  return `<nav class="rounds pr-timeline" aria-label="同 PR 跨輪時間軸">
    <span class="pr-timeline-label">同 PR 輪次（${escapeHtml(prRef)}）：</span>
    ${links}
  </nav>`;
}

function downloadFilename(title: string, fallbackId: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const safeFallback = fallbackId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 36) || "report";
  return `${slug || safeFallback}.md`;
}

function rawMarkdownResponse(markdown: string, title: string, fallbackId: string): Response {
  return new Response(markdown, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${downloadFilename(title, fallbackId)}"`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}

export async function readReport(db: D1Database, userId: string, reportId: string, raw: boolean, origin: string): Promise<Response> {
  const report = await db.prepare("SELECT title, pr_ref, markdown_body, share_token FROM reports WHERE id = ? AND user_id = ?")
    .bind(reportId, userId).first<{ title: string; pr_ref: string | null; markdown_body: string; share_token: string | null }>();
  if (!report) {
    return raw
      ? new Response("找不到報告。", { status: 404 })
      : errorPage("找不到報告", "這份報告可能已被刪除，或你不具備檢視權限。", 404, { signedIn: true });
  }
  if (raw) {
    return rawMarkdownResponse(report.markdown_body, report.title, reportId);
  }
  let timeline = "";
  if (report.pr_ref) {
    const siblings = await db.prepare(`
      SELECT id, created_at, continuity_summary
      FROM reports WHERE user_id = ? AND pr_ref = ?
      ORDER BY created_at ASC, rowid ASC
    `).bind(userId, report.pr_ref).all<{ id: string; created_at: string; continuity_summary: string | null }>();
    timeline = renderPrTimeline(report.pr_ref, siblings.results, reportId);
  }
  const path = `/workspace/reports/${reportId}`;
  const shareUrl = report.share_token ? `${origin}/s/${report.share_token}` : undefined;
  const share = report.share_token ? `
    <div class="report-actions-bar">
      <span class="badge is-shared">已開啟唯讀分享</span>
      <a class="btn" href="/s/${encodeURIComponent(report.share_token)}">開啟唯讀分享頁</a>
      <form method="post" action="${path}/unshare"><button>撤銷分享</button></form>
    </div>
    <label>複製分享連結 <input class="copy-command" readonly value="${escapeHtml(shareUrl ?? "")}"></label>
  ` : `
    <p class="hint">這份報告目前是私有。</p>
    <form method="post" action="${path}/share">
      <label><input type="checkbox" name="confirm_code_anchors" value="1" required> 報告可能含有程式碼錨點片段。我確認持有連結的人可以讀取全文。</label>
      <div style="margin-top:.6rem"><button class="btn-primary">啟用分享</button></div>
    </form>
  `;
  return reportPage(report.title, report.markdown_body, {
    signedIn: true,
    privatePage: true,
    shareUrl,
    intro: timeline || undefined,
    actions: `<section class="report-actions" aria-label="報告操作">
      <div class="report-actions-bar">
        <div class="intro-actions">
          <a class="btn" href="/workspace">← 返回工作區</a>
          <a class="btn" href="${path}/raw">下載 Markdown 原檔</a>
        </div>
        <details class="danger-confirm">
          <summary>刪除報告</summary>
          <p class="confirm-note">刪除後無法復原，既有分享連結也會立即失效。</p>
          <form method="post" action="${path}/delete"><button class="btn-danger">確認刪除報告</button></form>
        </details>
      </div>
      ${share}
    </section>`,
  });
}

export async function readShare(db: D1Database, token: string, raw = false, origin = ""): Promise<Response> {
  const report = await db.prepare("SELECT id, title, markdown_body FROM reports WHERE share_token = ?")
    .bind(token).first<{ id: string; title: string; markdown_body: string }>();
  if (!report) {
    return raw
      ? new Response("找不到報告。", { status: 404 })
      : errorPage("分享連結已失效", "找不到報告。這條分享連結可能已遭撤銷，或原報告已被刪除。", 404);
  }
  if (raw) {
    return rawMarkdownResponse(report.markdown_body, report.title, report.id);
  }
  const sharePath = `/s/${encodeURIComponent(token)}`;
  const shareUrl = origin ? `${origin}${sharePath}` : undefined;
  return reportPage(report.title, report.markdown_body, {
    privatePage: true,
    shareUrl,
    actions: `<div class="report-actions-bar" style="margin-block-end:1rem">
      <span class="badge is-shared">唯讀分享報告</span>
      <a class="btn" href="${sharePath}/raw">下載 Markdown 原檔</a>
    </div>`,
  });
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
      return errorPage("需要確認分享範圍", "請先確認報告可能包含程式碼錨點片段。", 400, {
        signedIn: true, backHref: `/workspace/reports/${reportId}`, backLabel: "返回報告",
      });
    }
    result = await db.prepare(`
      UPDATE reports SET share_token = COALESCE(share_token, ?), shared_at = COALESCE(shared_at, CURRENT_TIMESTAMP)
      WHERE id = ? AND user_id = ?
    `).bind(randomToken(), reportId, userId).run();
  } else {
    result = await db.prepare("UPDATE reports SET share_token = NULL, shared_at = NULL WHERE id = ? AND user_id = ?")
      .bind(reportId, userId).run();
  }
  if (!result.meta.changes) {
    return errorPage("找不到報告", "找不到報告，無法更新分享狀態。", 404, { signedIn: true });
  }
  return redirect(`/workspace/reports/${reportId}`);
}
