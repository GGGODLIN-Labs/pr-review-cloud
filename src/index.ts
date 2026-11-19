import { apiKeyOwner, completeLogin, logout, signedInUser, startLogin, type Env } from "./auth.ts";
import { polarWebhook, startCheckout } from "./billing.ts";
import {
  faviconResponse, homeIntroBanner, llmsTxtResponse, reportPage, robotsTxtResponse, signInRequiredPage,
} from "./page.ts";
import { sampleReports } from "./sample.ts";
import { uploadReport } from "./upload.ts";
import {
  changeReport, issueKey, readReport, readShare, reportRoute, revokeKey, revokeRoute, sharedRoute, workspacePage,
} from "./workspace.ts";

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const db = env.DB;
  const report = path.match(reportRoute);
  const revoke = path.match(revokeRoute);
  const share = path.match(sharedRoute);
  const fromCLI = path === "/api/reports";
  const action = report?.[2];
  const method = fromCLI || revoke || path === "/webhooks/polar" || path === "/auth/logout" || path === "/workspace/keys" ||
    path === "/workspace/reports" || (action && action !== "raw") ? "POST" : "GET";
  if (request.method !== method) {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: method } });
  }
  if (path === "/favicon.svg" || path === "/favicon.ico") {
    return faviconResponse();
  }
  if (path === "/robots.txt") {
    return robotsTxtResponse();
  }
  if (path === "/llms.txt") {
    return llmsTxtResponse();
  }
  if (path === "/" || path === "/sample") {
    const round = url.searchParams.get("round") === "1" ? 1 : 2;
    const user = db ? await signedInUser(request, db).catch(() => null) : null;
    const signedIn = Boolean(user);
    return reportPage(`公開審查範例 · Round ${round}`, sampleReports[round], {
      round,
      signedIn,
      privatePage: false,
      intro: path === "/" ? homeIntroBanner(signedIn) : undefined,
    });
  }

  const origin = url.origin;
  if (path === "/auth/github") return startLogin(env, origin);
  if (path === "/auth/github/callback") return completeLogin(request, env, origin);
  if (path === "/webhooks/polar") return polarWebhook(request, env);
  if (!fromCLI && !share && !revoke && !report && ![
    "/workspace", "/workspace/checkout", "/workspace/keys", "/workspace/reports", "/auth/logout",
  ].includes(path)) return new Response("Not Found", { status: 404 });
  if (!db) return new Response("服務暫時無法使用。", { status: 503 });

  if (share) return readShare(db, share[1]);
  if (fromCLI) {
    const owner = await apiKeyOwner(request, db);
    if (!owner) return new Response("API 金鑰無效或已撤銷。", { status: 401 });
    return uploadReport(request, db, owner.id, true);
  }

  if (method === "POST") {
    const sentOrigin = request.headers.get("Origin");
    const site = request.headers.get("Sec-Fetch-Site");
    if ((sentOrigin !== null && sentOrigin !== origin) || site === "cross-site" || site === "same-site") {
      return new Response("此操作必須從工作區送出。", { status: 403 });
    }
  }
  if (path === "/auth/logout") return logout(request, db);
  const user = await signedInUser(request, db);
  if (!user) return signInRequiredPage();
  if (path === "/workspace") return workspacePage(db, user, env.BILLING_MODE === "polar_live");
  if (path === "/workspace/checkout") return startCheckout(env, user.id, url.searchParams.get("plan"));
  if (path === "/workspace/keys") return issueKey(db, user.id, origin);
  if (revoke) return revokeKey(db, user.id, revoke[1]);
  if (path === "/workspace/reports") return uploadReport(request, db, user.id, false);
  if (report) {
    if (method === "GET") return readReport(db, user.id, report[1], action === "raw", origin);
    if (action && action !== "raw") return changeReport(request, db, user.id, report[1], action);
  }
  return new Response("Not Found", { status: 404 });
}

export default {
  async fetch(request: Request, env: Env = {}): Promise<Response> {
    const response = await handleRequest(request, env).catch(() => new Response("服務暫時無法使用。", { status: 503 }));
    response.headers.set("Cache-Control", "no-store");
    return response;
  },
};
