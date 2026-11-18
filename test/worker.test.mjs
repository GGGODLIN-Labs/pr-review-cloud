import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../src/index.ts";

const request = (path, env = {}) => worker.fetch(new Request(`https://app.example${path}`), env);

function shareEnv(t, markdown) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE reports (share_token TEXT UNIQUE, title TEXT, markdown_body TEXT, shared_at TEXT)");
  const insert = db.prepare("INSERT INTO reports VALUES (?, ?, ?, ?)");
  insert.run("public-fixture", "Sample & notes", markdown, "2026-11-18");
  insert.run(null, "Private report", "Private fixture content", null);

  return {
    DB: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return { bind: (...values) => ({ first: async () => statement.get(...values) ?? null }) };
      },
    },
  };
}

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
    const html = await response.text();
    assertRoundTwo(html);
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

test("a legacy public report renders in full with its original status", async (t) => {
  const env = shareEnv(t, "# Legacy review\n\n**Pending verification**\n\n- Recorded location\n- Last note from review");
  const response = await request("/s/public-fixture", env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") ?? "", /no-store/);
  const html = await response.text();
  assert.match(html, /<h1>Legacy review<\/h1>/);
  assert.match(html, /<strong>Pending verification<\/strong>/);
  assert.match(html, /<li>Recorded location<\/li>[\s\S]*<li>Last note from review<\/li>/);
  assert.match(html, /狀態以原報告內容為準/);
  assert.doesNotMatch(html, /Prior review continuity|\bFIXED\b/);
  assert.equal((await request("/s/missing-fixture", env)).status, 404);
});

test("shared Markdown escapes raw tags and keeps only HTTP(S) links and images", async (t) => {
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
  const response = await request("/s/public-fixture", shareEnv(t, markdown));
  assert.equal(response.status, 200);
  const csp = response.headers.get("Content-Security-Policy") ?? "";
  assert.match(csp, /script-src 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'self'/);
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");

  const html = await response.text();
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
