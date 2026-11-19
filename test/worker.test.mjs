import assert from "node:assert/strict";
import { test } from "node:test";
import worker from "../src/index.ts";
import { renderReport } from "../src/markdown.ts";

const request = (path, env = {}) => worker.fetch(new Request(`https://app.example${path}`), env);

function assertRoundTwo(html) {
  assert.match(html, /Report projection schema\s*<\/strong>:\s*2/);
  assert.match(html, /CHECKED \(fixed 2 \/ still-open 1 \/ stale 0\)/);
  assert.match(html, /上一輪 findings 對帳/);
  assert.match(html, /<table>[\s\S]*<td\b[^>]*>FIXED<\/td>[\s\S]*<td\b[^>]*>STILL_OPEN<\/td>[\s\S]*<\/table>/);
}

test("unsigned visitors can read both locally reconciled sample rounds without outbound calls", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("Sample rendering must not require a network request");
  });

  for (const path of ["/", "/sample", "/sample?round=2"]) {
    const response = await request(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await response.text();
    assertRoundTwo(html);
    assert.match(html, /狀態以原報告內容為準/);
    assert.match(html, /<a[^>]*href="\/sample\?round=1"[^>]*>Round 1<\/a>/);
    assert.match(html, /href="https:\/\/github\.com\/GGGODLIN\/claude-pr-review"/);
    assert.match(html, /href="https:\/\/gggodlin\.com\/?"/);
  }

  const response = await request("/sample?round=1");
  assert.equal(response.status, 200);
  const html = await response.text();
  for (const finding of ["群組報告歸檔恢復中斷", "零發現標記偽造", "未修改的審查檔被覆寫"]) {
    assert.ok(html.includes(finding), `Round 1 contains ${finding}`);
  }
  assert.match(html, /<a[^>]*href="\/sample\?round=2"[^>]*>Round 2<\/a>/);
  assert.equal(network.mock.callCount(), 0);
});

test("pages expose shared SVG favicon, nosniff header, overscroll dark background and zero scripts", async () => {
  const home = await request("/");
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("X-Content-Type-Options"), "nosniff");
  const html = await home.text();
  assert.match(html, /<link rel="icon" type="image\/svg\+xml" href="\/favicon\.svg">/);
  assert.match(html, /html:has\(#theme-dark:checked\)/);
  assert.match(html, /#main-content/);
  assert.doesNotMatch(html, /<script\b/i);

  for (const path of ["/favicon.svg", "/favicon.ico"]) {
    const icon = await request(path);
    assert.equal(icon.status, 200, path);
    assert.equal(icon.headers.get("Content-Type"), "image/svg+xml; charset=utf-8");
    assert.equal(icon.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(await icon.text(), /<svg\b[^>]*viewBox="0 0 32 32"/);
  }
});

test("public sample keeps working with no DB and with an unavailable DB", async () => {
  const brokenDB = {
    prepare() { throw new Error("D1 unavailable"); },
  };

  for (const env of [{}, { DB: brokenDB }]) {
    const response = await request("/sample", env);
    assert.equal(response.status, 200);
    assertRoundTwo(await response.text());
  }
});

test("a legacy report renders in full with its original status", () => {
  const html = renderReport("# Legacy review\n\n**Pending verification**\n\n- Recorded location\n- Last note from review");
  assert.match(html, /<h1>Legacy review<\/h1>/);
  assert.match(html, /<strong>Pending verification<\/strong>/);
  assert.match(html, /<li>Recorded location<\/li>[\s\S]*<li>Last note from review<\/li>/);
  assert.doesNotMatch(html, /Prior review continuity|\bFIXED\b/);
});

test("report Markdown escapes raw tags and keeps only HTTP(S) links and images", () => {
  const markdown = [
    "# Markdown safety",
    "<script>/* sample marker */</script>",
    '<img src="https://example.test/raw.png" onerror="void(0)">',
    '<iframe src="https://example.test/frame"></iframe>',
    "[blocked script](<javascript:void(0)>) and [blocked data](data:text/plain,sample)",
    "[blocked relative](/some-path) and [blocked mail](mailto:sample@example.test)",
    "![blocked image](data:image/png;base64,AA==)",
    "[**safe docs**](https://example.test/docs?a=1&b=2) and [safe HTTP](http://example.test/help)",
    "![safe image](https://example.test/image.png)",
    "```js\nconst note = '<em>literal</em>';\n```",
  ].join("\n\n");
  const html = renderReport(markdown);
  assert.match(html, /&lt;script&gt;\/\* sample marker \*\/&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=&quot;https:\/\/example\.test\/raw\.png&quot; onerror=&quot;void\(0\)&quot;&gt;/);
  assert.match(html, /&lt;iframe src=&quot;https:\/\/example\.test\/frame&quot;&gt;&lt;\/iframe&gt;/);
  assert.doesNotMatch(html, /<(?:script|iframe)\b|<img\b[^>]*\bonerror\s*=/i);
  assert.doesNotMatch(html, /(?:href|src)=["'](?:javascript:|data:|mailto:|\/some-path)/i);
  assert.match(html, /blocked script and blocked data/);
  assert.match(html, /blocked image/);
  assert.match(html, /<a href="https:\/\/example\.test\/docs\?a=1&amp;b=2" rel="noopener noreferrer"><strong>safe docs<\/strong><\/a>/);
  assert.match(html, /<a href="http:\/\/example\.test\/help" rel="noopener noreferrer">safe HTTP<\/a>/);
  assert.match(html, /<img src="https:\/\/example\.test\/image\.png" alt="safe image"/);
  assert.match(html, /<pre><code class="language-js">[^<]*&lt;em&gt;literal&lt;\/em&gt;[^<]*<\/code><\/pre>/);
});

test("schema 2 reports render convergence meter, status badges, STILL_OPEN CSS filter, TOC anchors and table-scroll without JS", async () => {
  const response = await request("/sample?round=2");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /class="convergence-card"/);
  assert.match(html, /2 \/ 3 已修復（67%）/);
  assert.match(html, /<td\b[^>]*data-status="FIXED"[^>]*>FIXED<\/td>/);
  assert.match(html, /<td\b[^>]*data-status="STILL_OPEN"[^>]*>STILL_OPEN<\/td>/);
  assert.match(html, /id="filter-open"/);
  assert.match(html, /只看 STILL_OPEN（1）/);
  assert.match(html, /<div class="table-scroll"><table>/);
  assert.match(html, /<details class="report-toc">/);
  assert.match(html, /<h2 id="sec-/);
  assert.doesNotMatch(html, /<script\b/i);

  const samePageLink = renderReport("[Jump](#sec-summary) and [Blocked](/relative)");
  assert.match(samePageLink, /<a href="#sec-summary">Jump<\/a>/);
  assert.doesNotMatch(samePageLink, /href="\/relative"/);
});

test("home banner, legal footer, meta description, robots.txt, llms.txt and rich 401 sign-in card", async () => {
  const home = await request("/");
  const homeHtml = await home.text();
  assert.match(homeHtml, /class="intro-banner"/);
  assert.match(homeHtml, /<meta name="description" content="[^"]+"/);
  assert.match(homeHtml, /<meta property="og:title"/);
  for (const link of ["https://gggodlin.com/privacy", "https://gggodlin.com/terms", "https://gggodlin.com/refund"]) {
    assert.ok(homeHtml.includes(`href="${link}"`), `missing footer legal link ${link}`);
  }

  const robots = await request("/robots.txt");
  assert.equal(robots.status, 200);
  const robotsTxt = await robots.text();
  assert.match(robotsTxt, /Disallow: \/workspace/);
  assert.match(robotsTxt, /Disallow: \/s\//);

  const llms = await request("/llms.txt");
  assert.equal(llms.status, 200);
  assert.match(await llms.text(), /^# PR Review Cloud/m);

  const dummyDb = {
    prepare() {
      return { bind() { return { async first() { return null; } }; } };
    },
  };
  const unauth = await request("/workspace", { DB: dummyDb });
  assert.equal(unauth.status, 401);
  const unauthHtml = await unauth.text();
  assert.match(unauthHtml, /class="signin-card"/);
  assert.match(unauthHtml, /read:user/);
  assert.match(unauthHtml, /href="\/auth\/github">Sign in with GitHub/);
  assert.match(unauthHtml, /href="\/sample"/);
});

test("HEAD works on GET routes, unknown POST returns 404 HTML, /login redirects to OAuth, and browser 413/404 render themed HTML", async () => {
  for (const path of ["/", "/sample", "/robots.txt", "/llms.txt", "/favicon.svg"]) {
    const res = await worker.fetch(new Request(`https://app.example${path}`, { method: "HEAD" }), {});
    assert.equal(res.status, 200, `HEAD ${path}`);
    assert.equal(await res.text(), "", `HEAD ${path} body must be empty`);
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }

  const unknownPost = await worker.fetch(new Request("https://app.example/does-not-exist", { method: "POST" }), {});
  assert.equal(unknownPost.status, 404);
  assert.match(unknownPost.headers.get("Content-Type") ?? "", /text\/html/);
  assert.match(await unknownPost.text(), /找不到頁面/);

  const wrongMethod = await worker.fetch(new Request("https://app.example/sample", { method: "POST" }), {});
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("Allow"), "GET, HEAD");

  const login = await request("/login");
  assert.equal(login.status, 302);
  assert.equal(login.headers.get("Location"), "/auth/github");
});
