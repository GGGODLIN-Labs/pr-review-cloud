import { reportPage } from "./page.ts";
import { sampleReports } from "./sample.ts";

export default {
  async fetch(request: Request, env: { DB?: unknown } = {}): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET" } });
    }

    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/" || pathname === "/sample") {
      const round = searchParams.get("round") === "1" ? 1 : 2;
      const html = reportPage(`公開審查範例 · Round ${round}`, sampleReports[round], round);
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    return new Response("Not Found", { status: 404 });
  },
};
