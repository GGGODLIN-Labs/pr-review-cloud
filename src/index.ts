import { reportPage } from "./page.ts";
import { sampleReports } from "./sample.ts";

interface Env {
  DB?: D1Database;
}

interface SharedReport {
  title: string;
  markdown_body: string;
}

const securityHeaders = {
  "Content-Security-Policy": [
    "default-src 'none'",
    "script-src 'none'",
    "style-src 'unsafe-inline'",
    "img-src http: https:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

const shareHeaders = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };

function htmlResponse(body: string, headers = {}) {
  return new Response(body, {
    headers: { ...securityHeaders, "Content-Type": "text/html; charset=utf-8", ...headers },
  });
}

async function sharedReport(db: D1Database | undefined, token: string): Promise<Response> {
  try {
    if (db) {
      const report = await db.prepare("SELECT title, markdown_body FROM reports WHERE share_token = ?")
        .bind(token).first<SharedReport>();
      if (!report) return new Response("Not Found", { status: 404, headers: { ...securityHeaders, ...shareHeaders } });
      return htmlResponse(reportPage(report.title, report.markdown_body), shareHeaders);
    }
  } catch {
    // The public endpoint must not expose database errors or share tokens in its response.
  }
  return new Response("Service Unavailable", { status: 503, headers: { ...securityHeaders, ...shareHeaders } });
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { ...securityHeaders, Allow: "GET" } });
    }

    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/" || pathname === "/sample") {
      const round = searchParams.get("round") === "1" ? 1 : 2;
      return htmlResponse(reportPage(`公開審查範例 · Round ${round}`, sampleReports[round], round));
    }

    const token = /^\/s\/([A-Za-z0-9_-]{1,128})$/.exec(pathname)?.[1];
    if (token) return sharedReport(env.DB, token);
    return new Response("Not Found", { status: 404, headers: securityHeaders });
  },
};
