import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { Webhook } from "standardwebhooks";
import { readBoundedBody } from "../src/body.ts";
import worker from "../src/index.ts";
import { extractContinuityCounts, isSafeToParseMarkdown, renderReport, renderReportWithMeta } from "../src/markdown.ts";
import { errorPage, reportPage } from "../src/page.ts";
import { readReport, readShare } from "../src/workspace.ts";

const origin = "https://app.example";
const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const polarSecret = "whsec_" + Buffer.from("synthetic-security-webhook-secret").toString("base64");
const proCheckout = "https://buy.polar.sh/polar_cl_sec_monthly";
const passCheckout = "https://buy.polar.sh/polar_cl_sec_pass";

function createHarness(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(schema);
  const execute = new WeakMap();
  const env = {
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        const bound = (args) => {
          const run = () => ({ success: true, meta: { changes: stmt.run(...args).changes } });
          const statement = {
            bind: (...values) => bound(values),
            async first() { return stmt.get(...args) ?? null; },
            async all() { return { success: true, results: stmt.all(...args) }; },
            async run() { return run(); },
          };
          execute.set(statement, run);
          return statement;
        };
        return bound([]);
      },
      async batch(statements) {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => execute.get(statement)());
          db.exec("COMMIT");
          return results;
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      },
    },
    GITHUB_CLIENT_ID: "sec-client-id",
    GITHUB_CLIENT_SECRET: "sec-client-secret",
    BILLING_MODE: "polar_live",
    POLAR_WEBHOOK_SECRET: polarSecret,
    POLAR_PRO_CHECKOUT_URL: proCheckout,
    POLAR_PRO_PASS_CHECKOUT_URL: passCheckout,
  };

  const call = (path, init) => worker.fetch(new Request(`${origin}${path}`, init), env);

  function extractCookie(response, name) {
    const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
    assert.equal(typeof header, "string", `${name} cookie must be set`);
    return header.split(";", 1)[0];
  }

  async function signIn(tCtx, profile, existingCookie) {
    const mock = tCtx.mock.method(globalThis, "fetch", async (url) => {
      if (url === "https://github.com/login/oauth/access_token") {
        return Response.json({ access_token: "sec-gh-token" });
      }
      return Response.json(profile);
    });
    try {
      const start = await call("/auth/github");
      assert.equal(start.status, 302);
      const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
      const state = new URL(start.headers.get("Location")).searchParams.get("state");
      const cookieHeader = existingCookie ? `${existingCookie}; ${stateCookie}` : stateCookie;
      const callback = await call(`/auth/github/callback?code=sec-code&state=${state}`, {
        headers: { Cookie: cookieHeader },
      });
      assert.equal(callback.status, 302);
      const sessionCookie = extractCookie(callback, "__Host-prc_session");
      const user = db.prepare("SELECT id, plan FROM users WHERE github_id = ?").get(String(profile.id));
      assert.ok(user);
      return { cookie: sessionCookie, userId: user.id };
    } finally {
      mock.mock.restore();
    }
  }

  async function issueApiKey(cookie) {
    const res = await call("/workspace/keys", {
      method: "POST",
      headers: { Cookie: cookie, Origin: origin },
    });
    assert.equal(res.status, 201);
    const html = await res.text();
    const key = html.match(/\bprc_[A-Za-z0-9_-]{43}\b/)?.[0];
    assert.ok(key);
    return key;
  }

  function signPolar(id, body, { secret = polarSecret, timestamp = Math.floor(Date.now() / 1000), signatureOverride } = {}) {
    const wh = new Webhook(secret);
    const sig = signatureOverride ?? wh.sign(id, new Date(timestamp * 1000), body);
    return {
      method: "POST",
      headers: new Headers({
        "Content-Type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": sig,
      }),
      body,
    };
  }

  return { db, env, call, signIn, issueApiKey, signPolar, extractCookie };
}

function formFile(filename, body) {
  const form = new FormData();
  form.set("file", new Blob([body]), filename);
  return form;
}

test("auth: expired ISO-8601 and malformed session timestamps fail closed, re-login rotates old session and HEAD callback is rejected", async (t) => {
  const { db, env, call, signIn } = createHarness(t);
  const first = await signIn(t, { id: 901, login: "session-tester", avatar_url: "https://avatars.example/u.png" });
  assert.equal((await call("/workspace", { headers: { Cookie: first.cookie } })).status, 200);

  const pastIso = new Date(Date.now() - 3_600_000).toISOString();
  for (const expiredValue of ["2020-01-01 00:00:00", pastIso, "never", "invalid-date"]) {
    db.prepare("UPDATE sessions SET expires_at = ? WHERE user_id = ?").run(expiredValue, first.userId);
    const res = await call("/workspace", { headers: { Cookie: first.cookie } });
    assert.equal(res.status, 401, `session expires_at=${expiredValue} must fail closed`);
  }

  const active = await signIn(t, { id: 902, login: "rotate-tester" });
  assert.equal((await call("/workspace", { headers: { Cookie: active.cookie } })).status, 200);
  const rotated = await signIn(t, { id: 902, login: "rotate-tester" }, active.cookie);
  assert.equal((await call("/workspace", { headers: { Cookie: rotated.cookie } })).status, 200);
  assert.equal((await call("/workspace", { headers: { Cookie: active.cookie } })).status, 401);

  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("HEAD callback must not call GitHub");
  });
  const headCb = await call("/auth/github/callback?code=abc&state=def", { method: "HEAD" });
  assert.equal(headCb.status, 405);
  assert.equal(headCb.headers.get("Allow"), "GET");
  assert.equal(network.mock.callCount(), 0);
  network.mock.restore();

  const savedSecret = env.GITHUB_CLIENT_SECRET;
  delete env.GITHUB_CLIENT_SECRET;
  assert.equal((await call("/auth/github")).status, 503);
  env.GITHUB_CLIENT_SECRET = savedSecret;
});

test("auth: Bearer accepts scheme case and ASCII spaces; malformed headers, duplicate cookies and hostile OAuth profiles fail closed", async (t) => {
  const { db, call, signIn, issueApiKey, extractCookie } = createHarness(t);
  const { cookie, userId } = await signIn(t, { id: 903, login: "header-tester" });
  const key = await issueApiKey(cookie);

  for (const separator of [" ", "  ", "   "]) {
    for (const scheme of ["bearer", "BEARER", "bEaReR"]) {
      const ok = await call("/api/reports?filename=case.md", {
        method: "POST",
        headers: { Authorization: `${scheme}${separator}${key}` },
        body: "# Case check\n\nValid body.",
      });
      assert.equal(ok.status, 201, `${scheme} with ${separator.length} ASCII spaces must succeed`);
    }
  }

  const badAuthHeaders = [
    `Bearer ${key.toUpperCase()}`,
    `Bearer\t${key}`,
    `Bearer \t ${key}`,
    `Bearer ${key}`,
    `Bearer ${key} trailing`,
    "Bearer ",
    "Bearer",
    `Basic ${key}`,
    `Bearer prc_${"a".repeat(2000)}`,
    "Bearer not_a_prc_key",
  ];
  for (const authHeader of badAuthHeaders) {
    const res = await call("/api/reports?filename=bad.md", {
      method: "POST",
      headers: { Authorization: authHeader },
      body: "# Rejected",
    });
    assert.equal(res.status, 401, `malformed Authorization must fail: ${JSON.stringify(authHeader)}`);
    assert.equal(res.headers.get("WWW-Authenticate"), "Bearer");
    const body = await res.text();
    assert.equal(body.includes(key), false);
  }

  const badCookies = [
    `__Host-prc_session=forged; ${cookie}`,
    `${cookie}; __Host-prc_session=forged`,
    cookie.replace("__Host-prc_session", "__host-prc_session"),
    `${cookie} extra`,
    `__Host-prc_session=${"a".repeat(300)}`,
    "__Host-prc_session=   ",
  ];
  for (const header of badCookies) {
    const res = await call("/workspace", { headers: { Cookie: header } });
    assert.equal(res.status, 401, `bad Cookie must fail: ${header.slice(0, 40)}`);
  }

  const start = await call("/auth/github");
  const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  const dupState = await call(`/auth/github/callback?code=ok&state=${state}`, {
    headers: { Cookie: `${stateCookie}; __Host-prc_oauth_state=attacker` },
  });
  assert.equal(dupState.status, 400);

  const blankCode = await call(`/auth/github/callback?code=%20%20&state=${state}`, {
    headers: { Cookie: stateCookie },
  });
  assert.equal(blankCode.status, 400);

  const unsafeAvatar = await signIn(t, {
    id: 904,
    login: "avatar-tester",
    avatar_url: "javascript:alert(1)",
  });
  const stored = db.prepare("SELECT avatar_url FROM users WHERE id = ?").get(unsafeAvatar.userId);
  assert.equal(stored.avatar_url, null);

  const credAvatar = await signIn(t, {
    id: 905,
    login: "cred-avatar",
    avatar_url: "https://user:pass@avatars.example/pic.png",
  });
  const storedCred = db.prepare("SELECT avatar_url FROM users WHERE id = ?").get(credAvatar.userId);
  assert.equal(storedCred.avatar_url, null);

  const controlMock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "bad\r\nX-Injected: 1" });
    }
    throw new Error("must not call user endpoint with CRLF token");
  });
  const s2 = await call("/auth/github");
  const sc2 = extractCookie(s2, "__Host-prc_oauth_state");
  const st2 = new URL(s2.headers.get("Location")).searchParams.get("state");
  const badTokenRes = await call(`/auth/github/callback?code=c&state=${st2}`, { headers: { Cookie: sc2 } });
  assert.equal(badTokenRes.status, 502);
  controlMock.mock.restore();

  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
  assert.equal((await call("/api/reports?filename=orphan.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: "# Orphan",
  })).status, 401);
});

test("billing: webhook rejects replay timestamps, negative/non-integer/contradictory amounts, unpaid orders, malformed JSON and oversized payloads", async (t) => {
  const { db, call, signIn, signPolar } = createHarness(t);
  const { userId } = await signIn(t, { id: 910, login: "billing-victim" });
  const customer = { external_id: userId };
  const nowSec = Math.floor(Date.now() / 1000);

  const pastRes = await call("/webhooks/polar", signPolar("evt-past", JSON.stringify({
    type: "subscription.active",
    data: { customer },
  }), { timestamp: nowSec - 305 }));
  assert.equal(pastRes.status, 400);

  const futureRes = await call("/webhooks/polar", signPolar("evt-future", JSON.stringify({
    type: "subscription.active",
    data: { customer },
  }), { timestamp: nowSec + 305 }));
  assert.equal(futureRes.status, 400);

  const badPayloads = [
    ["empty", ""],
    ["null-json", "null"],
    ["array-json", "[]"],
    ["number-json", "42"],
    ["padded-type", JSON.stringify({ type: " subscription.active ", data: { customer } })],
    ["deep-json", "[".repeat(4000) + "]".repeat(4000)],
    ["negative-net", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, net_amount: -4900 } })],
    ["negative-amount", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: "sub_1", amount: -100 } })],
    ["float-amount", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, net_amount: 49.5 } })],
    ["string-amount", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, net_amount: "4900" } })],
    ["unpaid-flag", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, paid: false } })],
    ["pending-status", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, status: "pending" } })],
    ["contradictory-recurring", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: "sub_1", product: { is_recurring: false } } })],
    ["contradictory-pass", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: null, metadata: { plan: "pro" } } })],
    ["non-string-sub", JSON.stringify({ type: "order.paid", data: { customer, subscription_id: 12345, metadata: { plan: "pro_pass" } } })],
    ["forged-ref", JSON.stringify({ type: "order.paid", data: { subscription_id: null, metadata: { reference_id: `${userId}.${"0".repeat(64)}` } } })],
    ["bad-ended-at", JSON.stringify({ type: "subscription.canceled", data: { customer, ended_at: "not-a-timestamp" } })],
    ["refund-negative-with-status", JSON.stringify({ type: "order.refunded", data: { customer, status: "refunded", refunded_amount: -100, net_amount: 4900 } })],
    ["partial-refund-negative", JSON.stringify({ type: "order.refunded", data: { customer, status: "partially_refunded", refunded_amount: -1, net_amount: 4900 } })],
    ["refund-float-with-status", JSON.stringify({ type: "order.refunded", data: { customer, status: "refunded", refunded_amount: 10.5 } })],
    ["malformed-customer", JSON.stringify({ type: "subscription.active", data: { customer: "string-instead-of-object" } })],
  ];

  for (const [label, body] of badPayloads) {
    const res = await call("/webhooks/polar", signPolar(`evt-bad-${label}`, body));
    assert.equal(res.status, 400, `payload ${label} must be rejected with 400`);
    const out = `${await res.text()}\n${JSON.stringify([...res.headers])}`;
    assert.equal(out.includes(polarSecret), false);
  }

  const hugeBody = JSON.stringify({ type: "subscription.active", data: { customer, pad: "x".repeat(1_050_000) } });
  const oversizedRes = await call("/webhooks/polar", signPolar("evt-huge", hugeBody));
  assert.equal([400, 413].includes(oversizedRes.status), true);

  const row = db.prepare("SELECT plan FROM users WHERE id = ?").get(userId);
  assert.equal(row.plan, "free");
  const eventCount = db.prepare("SELECT COUNT(*) AS count FROM billing_events").get().count;
  assert.equal(eventCount, 0);
});

test("billing: subscription refund stays isolated from Pro Pass lane and checkout rejects unsafe URLs", async (t) => {
  const { db, env, call, signIn, signPolar } = createHarness(t);
  const { cookie, userId } = await signIn(t, { id: 911, login: "lane-tester" });
  const customer = { external_id: userId };
  const base = Date.now();

  const activateSub = await call("/webhooks/polar", signPolar("lane-01", JSON.stringify({
    type: "subscription.active",
    timestamp: new Date(base).toISOString(),
    data: { customer },
  })));
  assert.equal(activateSub.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro");

  const refundSub = await call("/webhooks/polar", signPolar("lane-02", JSON.stringify({
    type: "order.refunded",
    timestamp: new Date(base + 20_000).toISOString(),
    data: { customer, subscription_id: "sub_lane_1", status: "refunded", refunded_amount: 1900, net_amount: 1900 },
  })));
  assert.equal(refundSub.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "free");

  const delayedPass = await call("/webhooks/polar", signPolar("lane-03", JSON.stringify({
    type: "order.paid",
    timestamp: new Date(base + 10_000).toISOString(),
    data: { customer, subscription_id: null, net_amount: 4900, metadata: { plan: "pro_pass" } },
  })));
  assert.equal(delayedPass.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");

  const anotherSubRefund = await call("/webhooks/polar", signPolar("lane-04", JSON.stringify({
    type: "order.refunded",
    timestamp: new Date(base + 30_000).toISOString(),
    data: { customer, subscription_id: "sub_lane_2", status: "refunded" },
  })));
  assert.equal(anotherSubRefund.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");

  const invalidPlan = await call("/workspace/checkout?plan=enterprise", { headers: { Cookie: cookie } });
  assert.equal(invalidPlan.status, 400);
  assert.equal(invalidPlan.headers.has("Location"), false);

  for (const badUrl of ["http://buy.polar.sh/insecure", "https://user:pass@buy.polar.sh/creds", "javascript:alert(1)"]) {
    env.POLAR_PRO_CHECKOUT_URL = badUrl;
    const res = await call("/workspace/checkout?plan=pro", { headers: { Cookie: cookie } });
    assert.equal(res.status, 503, `checkout URL ${badUrl} must fail closed`);
    assert.equal(res.headers.has("Location"), false);
  }
  env.POLAR_PRO_CHECKOUT_URL = proCheckout;

  env.POLAR_WEBHOOK_SECRET = "   ";
  assert.equal((await call("/workspace/checkout?plan=pro", { headers: { Cookie: cookie } })).status, 503);
  env.POLAR_WEBHOOK_SECRET = polarSecret;
});

test("quota: concurrent burst uploads atomically enforce Free (20) and Pro Pass (500) caps", async (t) => {
  const { db, call, signIn, issueApiKey } = createHarness(t);
  const freeUser = await signIn(t, { id: 920, login: "free-burst" });
  const freeKey = await issueApiKey(freeUser.cookie);

  const insertSeed = db.prepare(`
    INSERT INTO reports (id, user_id, title, markdown_body, size_bytes)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (let i = 0; i < 17; i++) {
    insertSeed.run(`free-seed-${i}`, freeUser.userId, `Seed ${i}`, `# Seed ${i}\n\nBody`, 16);
  }

  const freeBurst = await Promise.all(Array.from({ length: 8 }, (_, idx) =>
    idx % 2 === 0
      ? call(`/api/reports?filename=burst-${idx}.md`, {
        method: "POST",
        headers: { Authorization: `Bearer ${freeKey}` },
        body: `# Burst CLI ${idx}\n\nPayload ${idx}`,
      })
      : call("/workspace/reports", {
        method: "POST",
        headers: { Cookie: freeUser.cookie, Origin: origin },
        body: formFile(`burst-${idx}.md`, `# Burst Picker ${idx}\n\nPayload ${idx}`),
      })));
  const freeCreated = freeBurst.filter((r) => r.status === 201 || r.status === 303).length;
  const freeRejected = freeBurst.filter((r) => r.status === 409).length;
  assert.equal(freeCreated, 3);
  assert.equal(freeRejected, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reports WHERE user_id = ?").get(freeUser.userId).count, 20);

  const passUser = await signIn(t, { id: 921, login: "pass-burst" });
  db.prepare("UPDATE users SET plan = 'pro_pass' WHERE id = ?").run(passUser.userId);
  const passKey = await issueApiKey(passUser.cookie);

  db.exec("BEGIN");
  for (let i = 0; i < 497; i++) {
    insertSeed.run(`pass-seed-${i}`, passUser.userId, `Pass Seed ${i}`, `# Pass ${i}`, 10);
  }
  db.exec("COMMIT");

  const passBurst = await Promise.all(Array.from({ length: 8 }, (_, idx) =>
    call(`/api/reports?filename=pass-${idx}.md`, {
      method: "POST",
      headers: { Authorization: `Bearer ${passKey}` },
      body: `# Pass Burst ${idx}\n\nData ${idx}`,
    })));
  const passCreated = passBurst.filter((r) => r.status === 201).length;
  const passRejected = passBurst.filter((r) => r.status === 409).length;
  assert.equal(passCreated, 3);
  assert.equal(passRejected, 5);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reports WHERE user_id = ?").get(passUser.userId).count, 500);
});

test("markdown & page: blocks unsafe protocols and image fragments, prevents continuity overflow, and survives deep nesting without crashing", async (t) => {
  const { call, signIn, issueApiKey } = createHarness(t);

  const unsafeMd = [
    "![fragment img](#sec-overview)",
    "![js img](JaVaScRiPt:alert(1))",
    "![svg data img](data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+)",
    "[entity js](javascript&#58;alert(1))",
    "[tab js](java&#x09;script:alert(1))",
    "[vb](vbscript:msgbox(1))",
    "[blob](blob:https://example.test/id)",
    "[file](file:///etc/passwd)",
    "[proto-rel](//evil.example/payload)",
    "<svg onload=alert(1)>",
    "<details open ontoggle=alert(1)>x</details>",
    "```js\" onmouseover=\"alert(1)\nconst x = 1;\n```",
  ].join("\n\n");
  const rendered = renderReport(unsafeMd);
  assert.doesNotMatch(rendered, /<img\b[^>]*src="#/i);
  assert.doesNotMatch(rendered, /(?:href|src)=["'](?:javascript:|vbscript:|data:|blob:|file:|\/\/)/i);
  assert.doesNotMatch(rendered, /<(?:script|svg|iframe|details)\b/i);
  assert.doesNotMatch(rendered, /<[^>]*\bon(?:load|error|mouseover|toggle)\s*=/i);
  assert.match(rendered, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(rendered, /svg data img/);

  const bomHtml = renderReport("\uFEFF# BOM Heading\n\nBody text.");
  assert.match(bomHtml, /<h1>BOM Heading<\/h1>/);

  const overflowMd = [
    "# Overflow",
    "",
    "**Report projection schema**: 2",
    `**Prior review continuity**: CHECKED (fixed ${"9".repeat(310)} / still-open 1 / stale 0)`,
  ].join("\n");
  assert.equal(extractContinuityCounts(overflowMd), null);
  const overflowHtml = await reportPage("Overflow", overflowMd).text();
  assert.doesNotMatch(overflowHtml, /Infinity|NaN%/);

  for (const badBackHref of ["javascript:alert(1)", "//evil.example/phish", "https://evil.example"]) {
    const errHtml = await errorPage("Err", "Msg", 400, { backHref: badBackHref }).text();
    assert.doesNotMatch(errHtml, /href="(?:javascript:|\/\/|https:\/\/evil\.example)/i);
    assert.match(errHtml, /href="\/"/);
  }

  const pathological = [
    "> ".repeat(5000) + "<script>alert(1)</script>",
    "**a ".repeat(5000) + "x" + " a**".repeat(5000),
    "_a ".repeat(5000) + "x" + " a_".repeat(5000),
    "~~a ".repeat(5000) + "x" + " a~~".repeat(5000),
    Array.from({ length: 300 }, (_, i) => "  ".repeat(i) + "- item").join("\n"),
    "```inline```\n" + "> ".repeat(5000) + "bypass",
    "# Huge\n\n" + "a".repeat(350_000),
  ];
  for (const payload of pathological) {
    const meta = renderReportWithMeta(payload);
    assert.equal(typeof meta.html, "string");
    assert.doesNotMatch(meta.html, /<script\b/i);
    assert.equal(extractContinuityCounts(payload), null);
  }

  const { cookie } = await signIn(t, { id: 930, login: "nesting-tester" });
  const key = await issueApiKey(cookie);
  const nestedUpload = await call("/api/reports?filename=nested.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: "> ".repeat(5000) + "<script>alert(1)</script>",
  });
  assert.equal(nestedUpload.status, 201);
  const { id } = await nestedUpload.json();
  const detail = await call(`/workspace/reports/${id}`, { headers: { Cookie: cookie } });
  assert.equal(detail.status, 200);
  const detailHtml = await detail.text();
  assert.doesNotMatch(detailHtml, /<script\b/i);
  assert.match(detailHtml, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("body, upload & raw: exact buffer sizing, malformed UTF-8/multipart, .audit.md bypasses and shared NUL/BOM preservation", async (t) => {
  const smallReq = new Request(`${origin}/test`, { method: "POST", body: "hello" });
  const smallBytes = await readBoundedBody(smallReq, 1_048_576);
  assert.ok(smallBytes);
  assert.equal(smallBytes.byteLength, 5);
  assert.equal(smallBytes.buffer.byteLength, 5);

  const chunked = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([65, 66, 67]));
      controller.enqueue(new Uint8Array([68, 69, 70]));
      controller.close();
    },
  });
  const overStream = new Request(`${origin}/test`, { method: "POST", body: chunked, duplex: "half" });
  assert.equal(await readBoundedBody(overStream, 5), null);
  assert.equal(await readBoundedBody(new Request(`${origin}/test`, { method: "POST", body: "a" }), -1), null);

  const { call, signIn, issueApiKey } = createHarness(t);
  const { cookie } = await signIn(t, { id: 940, login: "upload-tester" });
  const key = await issueApiKey(cookie);

  for (const [path, headers, body] of [
    ["/api/reports?filename=report.audit.md%20", { Authorization: `Bearer ${key}` }, "# Bypass space"],
    ["/api/reports?filename=", { Authorization: `Bearer ${key}`, "X-Filename": "hidden.audit.md" }, "# Bypass header"],
    ["/api/reports?filename=padded.md", { Authorization: `Bearer ${key}` }, "\n".repeat(55) + "# PR Review Audit Sidecar\n\nEvidence"],
    ["/api/reports?filename=bom-only.md", { Authorization: `Bearer ${key}` }, "\uFEFF   \r\n\t"],
    ["/api/reports?filename=bad-utf8.md", { Authorization: `Bearer ${key}` }, Uint8Array.of(0xe4, 0xb8)],
    ["/api/reports", { Authorization: `Bearer ${key}`, "Content-Type": "multipart/form-data" }, "broken"],
    ["/workspace/reports", { Cookie: cookie, Origin: origin, "Content-Type": "text/plain" }, "# Not multipart"],
    ["/workspace/reports", { Cookie: cookie, Origin: origin }, formFile("padded.audit.md ", "# Space bypass")],
  ]) {
    const res = await call(path, { method: "POST", headers, body });
    assert.equal(res.status, 400, `upload case ${path} must reject with 400`);
  }

  const nulReport = "\uFEFF# NUL Shared\r\n\r\nBefore\u0000AfterNulMarker\r\n";
  const created = await call("/api/reports?filename=nul.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: nulReport,
  });
  assert.equal(created.status, 201);
  const { id } = await created.json();

  const ownerView = await call(`/workspace/reports/${id}`, { headers: { Cookie: cookie } });
  assert.equal(ownerView.status, 200);
  assert.match(await ownerView.text(), /AfterNulMarker/);

  const shareRes = await call(`/workspace/reports/${id}/share`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin },
    body: new URLSearchParams({ confirm_code_anchors: "1" }),
  });
  assert.equal(shareRes.status, 303);
  const ownerPage = await (await call(`/workspace/reports/${id}`, { headers: { Cookie: cookie } })).text();
  const sharePath = ownerPage.match(/href="(\/s\/[A-Za-z0-9_-]{43})"/)?.[1];
  assert.ok(sharePath);

  const sharedRaw = await call(`${sharePath}/raw`);
  assert.equal(sharedRaw.status, 200);
  assert.deepEqual(Buffer.from(await sharedRaw.arrayBuffer()), Buffer.from(nulReport));

  const sharedHtml = await (await call(sharePath)).text();
  assert.match(sharedHtml, /AfterNulMarker/);
});

test("routing, CSRF, methods, CORS, headers & error hygiene: fail-closed CSRF, strict methods, security headers and zero leaks", async (t) => {
  const { env, call, signIn } = createHarness(t);
  const { cookie } = await signIn(t, { id: 950, login: "csrf-tester" });

  const deniedCsrfHeaders = [
    { Cookie: cookie },
    { Cookie: cookie, Origin: "null" },
    { Cookie: cookie, Origin: "https://app.example.evil.test" },
    { Cookie: cookie, Origin: "http://app.example" },
    { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "cross-site" },
    { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "CROSS-SITE" },
    { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "same-site" },
    { Cookie: cookie, Origin: origin, "Sec-Fetch-Site": "none" },
    { Cookie: cookie, Referer: "https://evil.example/attack" },
    { Cookie: cookie, Referer: "not-a-valid-url" },
    { Cookie: cookie, Origin: origin, Referer: "https://evil.example/attack" },
  ];
  for (const headers of deniedCsrfHeaders) {
    const res = await call("/workspace/keys", { method: "POST", headers });
    assert.equal(res.status, 403, `CSRF header combo must be denied: ${JSON.stringify(headers)}`);
  }

  for (const headers of [
    { Cookie: cookie, "Sec-Fetch-Site": "same-origin" },
    { Cookie: cookie, Referer: `${origin}/workspace` },
  ]) {
    const res = await call("/workspace/keys", { method: "POST", headers });
    assert.equal(res.status, 201, `valid same-origin proof must pass: ${JSON.stringify(headers)}`);
  }

  for (const [method, path, allow] of [
    ["OPTIONS", "/api/reports", "POST"],
    ["PUT", "/api/reports", "POST"],
    ["DELETE", "/workspace", "GET, HEAD"],
    ["PATCH", "/webhooks/polar", "POST"],
    ["OPTIONS", "/sample", "GET, HEAD"],
  ]) {
    const res = await call(path, { method });
    assert.equal(res.status, 405, `${method} ${path}`);
    assert.equal(res.headers.get("Allow"), allow);
    assert.equal(res.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("Cache-Control"), "no-store");
  }

  for (const badPath of [
    "/workspace/reports/..%2F..%2Fetc",
    `/workspace/reports/${"a".repeat(200)}`,
    "/s/too-short",
    "//workspace",
  ]) {
    const res = await call(badPath, { headers: { Cookie: cookie } });
    assert.equal(res.status, 404, `bad path ${badPath.slice(0, 40)}`);
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    assert.equal(res.headers.get("X-Frame-Options"), "DENY");
  }

  const secretLeak = "SQLITE_INTERNAL_SECRET_STACK_MARKER";
  const crashingEnv = {
    ...env,
    DB: {
      prepare() {
        throw new Error(secretLeak);
      },
    },
  };
  const browserCrash = await worker.fetch(new Request(`${origin}/workspace?next=/api/reports`, {
    headers: { Cookie: cookie },
  }), crashingEnv);
  assert.equal(browserCrash.status, 503);
  assert.match(browserCrash.headers.get("Content-Type") ?? "", /text\/html/);
  assert.equal(browserCrash.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(browserCrash.headers.get("Cache-Control"), "no-store");
  assert.equal((await browserCrash.text()).includes(secretLeak), false);

  const apiCrash = await worker.fetch(new Request(`${origin}/api/reports`, {
    method: "POST",
    headers: { Authorization: "Bearer prc_secret_probe_token_1234567890" },
    body: "# Crash",
  }), crashingEnv);
  assert.equal(apiCrash.status, 503);
  assert.doesNotMatch(apiCrash.headers.get("Content-Type") ?? "", /text\/html/);
  assert.equal(apiCrash.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(apiCrash.headers.get("Cache-Control"), "no-store");
  const apiCrashText = await apiCrash.text();
  assert.equal(apiCrashText.includes(secretLeak), false);
  assert.equal(apiCrashText.includes("prc_secret_probe_token_1234567890"), false);
});

test("auth & workspace: OAuth state rejects near-miss lengths and cross-user key/report tampering fails", async (t) => {
  const { db, call, signIn, issueApiKey, extractCookie } = createHarness(t);
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("state mismatch must not hit GitHub");
  });
  const start = await call("/auth/github");
  const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  const flipped = state.slice(0, -1) + (state.endsWith("A") ? "B" : "A");
  for (const candidate of [flipped, state.slice(0, 10), `${state}x`, ""]) {
    const res = await call(`/auth/github/callback?code=ok&state=${encodeURIComponent(candidate)}`, {
      headers: { Cookie: stateCookie },
    });
    assert.equal(res.status, 400);
  }
  assert.equal(network.mock.callCount(), 0);
  network.mock.restore();

  const alice = await signIn(t, { id: 960, login: "alice-owner" });
  const bob = await signIn(t, { id: 961, login: "bob-intruder" });
  const aliceKey = await issueApiKey(alice.cookie);
  const keyRow = db.prepare("SELECT id FROM api_keys WHERE user_id = ?").get(alice.userId);
  assert.ok(keyRow);

  await call(`/workspace/keys/${keyRow.id}/revoke`, {
    method: "POST",
    headers: { Cookie: bob.cookie, Origin: origin },
  });
  const stillWorks = await call("/api/reports?filename=alice.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${aliceKey}` },
    body: "# Alice Private\n\nSecret note.",
  });
  assert.equal(stillWorks.status, 201);
  const { id: reportId } = await stillWorks.json();

  assert.equal((await call(`/workspace/reports/${reportId}`, { headers: { Cookie: bob.cookie } })).status, 404);
  assert.equal((await call(`/workspace/reports/${reportId}/raw`, { headers: { Cookie: bob.cookie } })).status, 404);
  assert.equal((await call(`/workspace/reports/${reportId}/share`, {
    method: "POST",
    headers: { Cookie: bob.cookie, Origin: origin },
    body: new URLSearchParams({ confirm_code_anchors: "1" }),
  })).status, 404);
  assert.equal((await call(`/workspace/reports/${reportId}/unshare`, {
    method: "POST",
    headers: { Cookie: bob.cookie, Origin: origin },
  })).status, 404);
  await call(`/workspace/reports/${reportId}/delete`, {
    method: "POST",
    headers: { Cookie: bob.cookie, Origin: origin },
  });
  assert.equal((await call(`/workspace/reports/${reportId}`, { headers: { Cookie: alice.cookie } })).status, 200);
});

test("billing: concurrent duplicate delivery idempotency, malformed headers and revoked canceled subscription", async (t) => {
  const { db, call, signIn, signPolar } = createHarness(t);
  const { userId } = await signIn(t, { id: 970, login: "idem-tester" });

  const body = JSON.stringify({
    type: "order.paid",
    data: { customer: { external_id: `  ${userId}  ` }, subscription_id: null, net_amount: 4900, metadata: { plan: "pro_pass" } },
  });
  const burst = await Promise.all(Array.from({ length: 5 }, () =>
    call("/webhooks/polar", signPolar("dup-burst-01", body))));
  assert.deepEqual(burst.map((r) => r.status), [200, 200, 200, 200, 200]);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_events WHERE event_id = 'dup-burst-01'").get().count, 1);

  const subUser = await signIn(t, { id: 971, login: "revoked-sub" });
  assert.equal((await call("/webhooks/polar", signPolar("sub-act-1", JSON.stringify({
    type: "subscription.active",
    data: { customer: { external_id: subUser.userId } },
  })))).status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(subUser.userId).plan, "pro");

  assert.equal((await call("/webhooks/polar", signPolar("sub-can-revoked", JSON.stringify({
    type: "subscription.canceled",
    data: { customer: { external_id: subUser.userId }, ended_at: null, status: "revoked" },
  })))).status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(subUser.userId).plan, "free");

  for (const [hdrId, hdrTs] of [
    ["   ", String(Math.floor(Date.now() / 1000))],
    ["x".repeat(300), String(Math.floor(Date.now() / 1000))],
    ["bad-ts-zero", "0"],
    ["bad-ts-neg", "-100"],
    ["bad-ts-alpha", "abc"],
  ]) {
    const res = await call("/webhooks/polar", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": hdrId,
        "webhook-timestamp": hdrTs,
        "webhook-signature": "v1,invalid",
      },
      body: "{}",
    });
    assert.equal(res.status, 400);
  }
});

test("markdown: blocks tab-fence/inline-list/intraword-emphasis DoS bypasses, reference-link HTML bombs, and resets metadata on fallback", () => {
  const bypasses = [
    ["tab-fence", "\t```\n" + "> ".repeat(5000) + "<script>alert(1)</script>"],
    ["inline-dash-list", "- ".repeat(2000) + "<script>alert(1)</script>"],
    ["inline-plus-list", "+ ".repeat(2000) + "item"],
    ["inline-ol-list", "1. ".repeat(2000) + "item"],
    ["list-then-blockquote", "- " + "> ".repeat(5000) + "boom"],
    ["ol-then-blockquote", "1. " + "> ".repeat(5000) + "boom"],
    ["intraword-star-oscillation", "a*".repeat(5000) + "x" + "*a".repeat(5000)],
    ["ref-bomb-single-line", "[a]: https://example.com/" + "a".repeat(10000) + "\n\n" + "[a]".repeat(10000)],
    ["ref-bomb-2k-url", "[a]: https://example.com/" + "a".repeat(1900) + "\n\n" + "[a]".repeat(1000)],
    ["ref-bomb-forward", "[a]".repeat(1000) + "\n\n[a]: https://example.com/" + "a".repeat(1900)],
    ["ref-bomb-multiline", "## Heading\n\n| A | B |\n|-|-|\n| x | STILL_OPEN |\n\n[a]:\nhttps://example.com/" + "a".repeat(10000) + "\n\n" + "[a]".repeat(10000)],
  ];

  for (const [label, payload] of bypasses) {
    assert.equal(isSafeToParseMarkdown(payload), false, `${label} must fail safety pre-check`);
    const meta = renderReportWithMeta(payload);
    assert.ok(meta.html.length < 1_048_576, `${label} must stay within output budget`);
    assert.doesNotMatch(meta.html, /<script\b/i, `${label} must not emit raw script`);
    assert.equal(meta.toc.length, 0, `${label} fallback must reset TOC`);
    assert.equal(meta.stillOpenRowCount, 0, `${label} fallback must reset status counts`);
    assert.equal(meta.continuity, null, `${label} fallback must reset continuity`);
  }

  const cjkTable = "| Finding | 狀態 |\n| :-- | :-- |\n" + "| 這是**粗體**與**重點**說明 | FIXED |\n".repeat(500);
  assert.equal(isSafeToParseMarkdown(cjkTable), true, "legitimate 500-row CJK table must pass pre-check");
  const cjkMeta = renderReportWithMeta(cjkTable);
  assert.match(cjkMeta.html, /<table>/);
  assert.match(cjkMeta.html, /<strong>粗體<\/strong>/);
  assert.equal(cjkMeta.totalStatusRowCount, 500);
});

test("billing: rejects non-boolean paid, contradictory statuses, blank subscription_id, survives corrupt payload_json and accepts rotated signatures", async (t) => {
  const { db, call, signIn, signPolar } = createHarness(t);
  const { userId } = await signIn(t, { id: 980, login: "billing-strict" });
  const customer = { external_id: userId };

  const rejectedPayloads = [
    ["paid-zero", { type: "order.paid", data: { customer, subscription_id: null, paid: 0, metadata: { plan: "pro_pass" } } }],
    ["paid-string-false", { type: "order.paid", data: { customer, subscription_id: null, paid: "false" } }],
    ["paid-null", { type: "order.paid", data: { customer, subscription_id: null, paid: null } }],
    ["paid-blank-sub", { type: "order.paid", data: { customer, subscription_id: "   ", metadata: { plan: "pro_pass" } } }],
    ["paid-null-sub-recurring", { type: "order.paid", data: { customer, subscription_id: null, product: { is_recurring: true } } }],
    ["paid-sub-pass-conflict", { type: "order.paid", data: { customer, subscription_id: "sub_1", metadata: { plan: "pro_pass" } } }],
    ["paid-neg-refunded-tax", { type: "order.paid", data: { customer, subscription_id: null, refunded_tax_amount: -1 } }],
    ["refund-status-paid", { type: "order.refunded", data: { customer, status: "paid", refunded_amount: 4900, net_amount: 4900 } }],
    ["refund-status-int", { type: "order.refunded", data: { customer, status: 123, refunded_amount: 4900, net_amount: 4900 } }],
    ["refund-sub-nonrecurring", { type: "order.refunded", data: { customer, subscription_id: "sub_1", product: { is_recurring: false }, status: "refunded" } }],
    ["refund-zero-amount-full-status", { type: "order.refunded", data: { customer, status: "refunded", refunded_amount: 0, net_amount: 4900 } }],
    ["sub-active-revoked-status", { type: "subscription.active", data: { customer, status: "revoked" } }],
    ["sub-active-canceled-status", { type: "subscription.active", data: { customer, status: "canceled" } }],
    ["sub-revoked-active-status", { type: "subscription.revoked", data: { customer, status: "active" } }],
    ["sub-canceled-nonstring-status", { type: "subscription.canceled", data: { customer, status: 42 } }],
  ];

  for (const [label, payload] of rejectedPayloads) {
    const res = await call("/webhooks/polar", signPolar(`strict-${label}`, JSON.stringify(payload)));
    assert.equal(res.status, 400, `billing payload ${label} must return 400`);
  }
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "free");

  db.prepare(
    "INSERT INTO billing_events (event_id, event_type, user_id, plan_after, event_ts, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("legacy-corrupt-json", "order.refunded", userId, "free", Date.now() + 60_000, "{corrupt");

  const oldSecret = "whsec_" + Buffer.from("retired-polar-secret-key").toString("base64");
  const nowSec = Math.floor(Date.now() / 1000);
  const activateBody = JSON.stringify({
    type: "subscription.active",
    data: { customer, status: "active" },
  });
  const oldSig = new Webhook(oldSecret).sign("rotated-01", new Date(nowSec * 1000), activateBody);
  const curSig = new Webhook(polarSecret).sign("rotated-01", new Date(nowSec * 1000), activateBody);
  const rotatedRes = await call("/webhooks/polar", signPolar("rotated-01", activateBody, {
    timestamp: nowSec,
    signatureOverride: `${oldSig} ${curSig}`,
  }));
  assert.equal(rotatedRes.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro");
});

test("auth, page, upload & workspace: blocks whitespace OAuth creds, control-char logins, backslash redirects, NUL/duplicate .audit.md bypasses and decodes 128KB D1 number[]", async (t) => {
  const { env, call, signIn, issueApiKey, extractCookie } = createHarness(t);

  const savedId = env.GITHUB_CLIENT_ID;
  const savedSecret = env.GITHUB_CLIENT_SECRET;
  env.GITHUB_CLIENT_ID = "   ";
  assert.equal((await call("/auth/github")).status, 503);
  env.GITHUB_CLIENT_ID = savedId;
  env.GITHUB_CLIENT_SECRET = "  \t ";
  assert.equal((await call("/auth/github")).status, 503);
  env.GITHUB_CLIENT_SECRET = savedSecret;

  const badLoginMock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "valid-token" });
    }
    return Response.json({ id: 991, login: "evil\u0000login" });
  });
  const start = await call("/auth/github");
  const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  assert.equal((await call(`/auth/github/callback?code=c&state=${state}`, {
    headers: { Cookie: stateCookie },
  })).status, 502);
  badLoginMock.mock.restore();

  const spaceTokenMock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "token with space" });
    }
    throw new Error("must not call GitHub user endpoint with whitespace token");
  });
  const start2 = await call("/auth/github");
  const stateCookie2 = extractCookie(start2, "__Host-prc_oauth_state");
  const state2 = new URL(start2.headers.get("Location")).searchParams.get("state");
  assert.equal((await call(`/auth/github/callback?code=c&state=${state2}`, {
    headers: { Cookie: stateCookie2 },
  })).status, 502);
  spaceTokenMock.mock.restore();

  for (const badBack of ["/\\evil.example", "/ok\r\nSet-Cookie: a=1", "\\evil.example"]) {
    const html = await errorPage("Err", "Msg", 400, { backHref: badBack }).text();
    assert.match(html, /href="\/"/);
    assert.doesNotMatch(html, /evil\.example/);
  }

  const { cookie } = await signIn(t, { id: 992, login: "edge-uploader" });
  const key = await issueApiKey(cookie);

  for (const [path, headers, body] of [
    ["/api/reports?filename=report.audit.md%00", { Authorization: `Bearer ${key}` }, "# NUL filename bypass"],
    ["/api/reports?filename=ok.md&filename=hidden.audit.md", { Authorization: `Bearer ${key}` }, "# Duplicate query bypass"],
    ["/api/reports?filename=nul-only.md", { Authorization: `Bearer ${key}` }, "\u0000\u0000\u0000"],
    ["/api/reports?filename=nul-sidecar.md", { Authorization: `Bearer ${key}` }, "\u0000# PR Review Audit Sidecar\n\nEvidence"],
    ["/workspace/reports", { Cookie: cookie, Origin: origin }, formFile("bad.audit.md\u0000", "# Multipart NUL audit")],
  ]) {
    const res = await call(path, { method: "POST", headers, body });
    assert.equal(res.status, 400, `upload bypass ${path} must return 400`);
  }

  const fullBytes = new Uint8Array(131_072).fill(0x61);
  const prefix = new TextEncoder().encode("\uFEFF# D1 Blob\r\n\r\nBefore\u0000AfterD1Marker\r\n");
  fullBytes.set(prefix, 0);
  const numberArray = Array.from(fullBytes);
  const mockD1 = {
    prepare() {
      return {
        bind() {
          return {
            async first() {
              return { id: "d1-blob-id", title: "D1 Blob", pr_ref: null, markdown_body: numberArray, share_token: null };
            },
          };
        },
      };
    },
  };

  const reportRaw = await readReport(mockD1, "u1", "d1-blob-id", true, origin);
  assert.equal(reportRaw.status, 200);
  assert.deepEqual(new Uint8Array(await reportRaw.arrayBuffer()), fullBytes);

  const reportHtml = await (await readReport(mockD1, "u1", "d1-blob-id", false, origin)).text();
  assert.match(reportHtml, /AfterD1Marker/);

  const shareRaw = await readShare(mockD1, "A".repeat(43), true, origin);
  assert.equal(shareRaw.status, 200);
  assert.deepEqual(new Uint8Array(await shareRaw.arrayBuffer()), fullBytes);

  const shareHtml = await (await readShare(mockD1, "A".repeat(43), false, origin)).text();
  assert.match(shareHtml, /AfterD1Marker/);
});

test("markdown: blocks quadratic backtick DoS, pipe-prefixed non-table emphasis bypass, prefixed/multiline reference definitions and preserves 500-row CJK table", async (t) => {
  const quadraticBackticks = Array.from({ length: 300 }, (_, i) => "`".repeat(i === 1 ? 301 : i + 1)).join(" ") +
    " " + "`` ".repeat(27000);
  const pipeNonTable = ("| " + "a*".repeat(240) + "x" + "*a".repeat(240) + "\n").repeat(130);
  const shortLinePipeNonTable = ("| " + "a*".repeat(40) + "x" + "*a".repeat(40) + "\n").repeat(10);
  const tableEmDoS = "| A | B |\n| - | - |\n" + ("| " + "a*".repeat(60) + "x" + "*a".repeat(60) + " | ok |\n").repeat(60);
  const shortRunBacktickFlood = Array.from({ length: 30 }, (_, i) => "`".repeat(i + 1)).join(" ") + " " + "`` ".repeat(1000);
  const multilineUnclosedBackticks = Array.from({ length: 16 }, (_, i) => "x " + "`".repeat(i + 1)).join("\n") + "\n" + "a".repeat(60_000);
  const multilineManyOpenBackticks = Array.from({ length: 17 }, (_, i) => "x " + "`".repeat(i + 1)).join("\n");
  const tableUnclosedBackticks = "| H |\n| - |\n| " +
    Array.from({ length: 10 }, (_, i) => "`".repeat(i + 1)).join(" ") + " " + "a".repeat(80_000) + " |";
  const tableBacktickFlood = "| H |\n| - |\n" + ("| " + "`a` ".repeat(60) + " |\n").repeat(60);

  const timedPayloads = [
    ["quadratic-backticks-126kb", quadraticBackticks],
    ["pipe-nontable-em-125kb", pipeNonTable],
    ["pipe-nontable-short-lines", shortLinePipeNonTable],
    ["real-table-em-work-dos", tableEmDoS],
    ["short-run-backtick-flood", shortRunBacktickFlood],
    ["multiline-unclosed-backticks", multilineUnclosedBackticks],
    ["multiline-many-open-backticks", multilineManyOpenBackticks],
    ["table-unclosed-backticks", tableUnclosedBackticks],
    ["table-backtick-flood", tableBacktickFlood],
  ];

  for (const [label, payload] of timedPayloads) {
    const started = performance.now();
    assert.equal(isSafeToParseMarkdown(payload), false, `${label} must fail pre-check`);
    const meta = renderReportWithMeta(payload);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 50, `${label} took too long: ${elapsedMs.toFixed(2)}ms`);
    assert.match(meta.html, /^<pre>/);
    assert.equal(meta.toc.length, 0);
    assert.equal(meta.continuity, null);
    assert.equal(meta.stillOpenRowCount, 0);
  }

  const refBypasses = [
    ["blockquote-ref-def", `> [a]: https://example.com/${"a".repeat(10_000)}\n\n${"[a]".repeat(500)}`],
    ["bullet-list-ref-def", `- [a]: https://example.com/${"a".repeat(10_000)}\n\n${"[a]".repeat(500)}`],
    ["ordered-list-ref-def", `1. [a]: https://example.com/${"a".repeat(10_000)}\n\n${"[a]".repeat(500)}`],
    ["nested-prefix-ref-def", `> - [a]: https://example.com/${"a".repeat(10_000)}\n\n${"[a]".repeat(500)}`],
    ["multiline-label-ref-def", `[a\nb]: https://example.com/${"a".repeat(10_000)}\n\n${"[a b]".repeat(500)}`],
    ["prefixed-multiline-label", `> [a\n> b]: https://example.com/${"a".repeat(10_000)}\n\n${"[a b]".repeat(500)}`],
    ["multiline-label-and-dest", `[a\nb]:\nhttps://example.com/${"a".repeat(10_000)}\n\n${"[a b]".repeat(500)}`],
    ["multiline-label-amplification", `[a\nb]: https://example.com/${"a".repeat(1900)}\n\n${"[a b]".repeat(1000)}`],
    ["fake-open-then-real-ref", `[not a label\n[a]: https://example.com/${"a".repeat(10_000)}\n\n${"[a]".repeat(500)}`],
    ["angle-bracket-space-ref", `[a]: <https://example.com/a b ${"a".repeat(10_000)}>\n\n${"[a]".repeat(500)}`],
  ];

  for (const [label, payload] of refBypasses) {
    assert.equal(isSafeToParseMarkdown(payload), false, `${label} must fail pre-check`);
    const meta = renderReportWithMeta(payload);
    assert.ok(meta.html.length < 1_048_576, `${label} must stay within output budget`);
    assert.match(meta.html, /^<pre>/);
  }

  const { call, signIn, issueApiKey } = createHarness(t);
  const { cookie } = await signIn(t, { id: 993, login: "md-upload-guard" });
  const key = await issueApiKey(cookie);
  for (const [name, body] of [
    ["backtick-dos.md", quadraticBackticks],
    ["pipe-em-dos.md", pipeNonTable],
    ["prefixed-ref.md", `> [a]: https://example.com/${"a".repeat(10_000)}\n\n[a]`],
    ["multiline-ref.md", `[a\nb]: https://example.com/${"a".repeat(10_000)}\n\n[a b]`],
  ]) {
    const started = performance.now();
    const uploaded = await call(`/api/reports?filename=${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}` },
      body,
    });
    assert.equal(uploaded.status, 201, `${name} upload must succeed safely`);
    const { id } = await uploaded.json();
    const viewRes = await call(`/workspace/reports/${id}`, { headers: { Cookie: cookie } });
    assert.equal(viewRes.status, 200);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 150, `${name} upload+render took too long: ${elapsedMs.toFixed(2)}ms`);
    assert.match(await viewRes.text(), /<pre>/);
  }

  const cjkTable = "| Finding | 狀態 |\n| :-- | :-- |\n" + "| 這是**粗體**與 `code` 說明 | FIXED |\n".repeat(500);
  assert.equal(isSafeToParseMarkdown(cjkTable), true, "legitimate 500-row CJK table with bold and inline code must pass");
  const cjkMeta = renderReportWithMeta(cjkTable);
  assert.match(cjkMeta.html, /<table>/);
  assert.match(cjkMeta.html, /<strong>粗體<\/strong>/);
  assert.match(cjkMeta.html, /<code>code<\/code>/);
  assert.equal(cjkMeta.totalStatusRowCount, 500);

  const legitMultilineRef = "[see\nmore]: https://example.com/pr/1\n\n> [ref]: https://example.com/doc\n\n- [x] Done [see more] and [ref]";
  assert.equal(isSafeToParseMarkdown(legitMultilineRef), true);
  const legitRefHtml = renderReport(legitMultilineRef);
  assert.match(legitRefHtml, /href="https:\/\/example\.com\/pr\/1"/);
  assert.match(legitRefHtml, /href="https:\/\/example\.com\/doc"/);
});

test("billing: rejects recurring order.paid and order.refunded with contradictory metadata.plan when subscription_id is omitted", async (t) => {
  const { db, call, signIn, signPolar } = createHarness(t);
  const { userId } = await signIn(t, { id: 994, login: "billing-recurring-conflict" });
  const customer = { external_id: userId };

  const contradictoryPayloads = [
    ["recurring-no-sub-pro-pass", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: "pro_pass" } } }],
    ["recurring-no-sub-other-plan", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: "enterprise" } } }],
    ["recurring-no-sub-free-plan", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: "free" } } }],
    ["recurring-no-sub-padded-plan", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: " pro " } } }],
    ["recurring-no-sub-empty-plan", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: "" } } }],
    ["recurring-no-sub-nonstring-plan", { type: "order.paid", data: { customer, product: { is_recurring: true }, metadata: { plan: 123 } } }],
    ["sub-id-other-plan", { type: "order.paid", data: { customer, subscription_id: "sub_994", metadata: { plan: "enterprise" } } }],
    ["nonrecurring-pro-plan", { type: "order.paid", data: { customer, product: { is_recurring: false }, metadata: { plan: "pro" } } }],
    ["refund-recurring-pro-pass", { type: "order.refunded", data: { customer, product: { is_recurring: true }, metadata: { plan: "pro_pass" }, status: "refunded" } }],
    ["refund-onetime-pro-plan", { type: "order.refunded", data: { customer, subscription_id: null, metadata: { plan: "pro" }, status: "refunded" } }],
    ["refund-unknown-plan", { type: "order.refunded", data: { customer, metadata: { plan: "enterprise" }, status: "refunded" } }],
  ];

  for (const [label, payload] of contradictoryPayloads) {
    const res = await call("/webhooks/polar", signPolar(`conflict-${label}`, JSON.stringify(payload)));
    assert.equal(res.status, 400, `${label} must be rejected with 400`);
  }
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "free");
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM billing_events WHERE user_id = ?").get(userId).count, 0);

  const validRecurring = await call("/webhooks/polar", signPolar("valid-recurring-pro", JSON.stringify({
    type: "order.paid",
    data: { customer, product: { is_recurring: true }, metadata: { plan: "pro" } },
  })));
  assert.equal(validRecurring.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro");
});

test("auth: OAuth callback rejects duplicate query params and oversized, whitespace or control-char codes with 400", async (t) => {
  const { call, extractCookie } = createHarness(t);
  const start = await call("/auth/github");
  assert.equal(start.status, 302);
  const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
  const state = new URL(start.headers.get("Location")).searchParams.get("state");

  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("malformed OAuth callback must fail closed before calling GitHub");
  });

  const malformedQueries = [
    ["dup-state-trailing", `?state=${state}&state=evil&code=ok`],
    ["dup-state-leading", `?state=evil&state=${state}&code=ok`],
    ["dup-state-same", `?state=${state}&state=${state}&code=ok`],
    ["dup-state-empty", `?state=${state}&state=&code=ok`],
    ["dup-code", `?state=${state}&code=a&code=b`],
    ["dup-code-empty", `?state=${state}&code=ok&code=`],
    ["oversized-code", `?state=${state}&code=${"a".repeat(257)}`],
    ["space-inside-code", `?state=${state}&code=ok%20evil`],
    ["leading-space-code", `?state=${state}&code=%20ok`],
    ["trailing-space-code", `?state=${state}&code=ok%20`],
    ["tab-in-code", `?state=${state}&code=ok%09x`],
    ["crlf-in-code", `?state=${state}&code=ok%0d%0a`],
    ["nul-in-code", `?state=${state}&code=ok%00x`],
    ["del-in-code", `?state=${state}&code=ok%7fx`],
  ];

  for (const [label, qs] of malformedQueries) {
    const res = await call(`/auth/github/callback${qs}`, {
      headers: { Cookie: stateCookie },
    });
    assert.equal(res.status, 400, `${label} must return 400`);
    const cleared = res.headers.getSetCookie().some((cookieHeader) =>
      cookieHeader.startsWith("__Host-prc_oauth_state=;") && cookieHeader.includes("Max-Age=0"));
    assert.equal(cleared, true, `${label} must clear OAuth state cookie`);
  }
  assert.equal(network.mock.callCount(), 0);
  network.mock.restore();

  const okMock = t.mock.method(globalThis, "fetch", async (url) => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "boundary-token" });
    }
    return Response.json({ id: 995, login: "boundary-code-user" });
  });
  try {
    const exactMaxCode = "c".repeat(256);
    const validRes = await call(`/auth/github/callback?state=${state}&code=${exactMaxCode}`, {
      headers: { Cookie: stateCookie },
    });
    assert.equal(validRes.status, 302);
  } finally {
    okMock.mock.restore();
  }
});

test("markdown: blocks HTML/list/ref-title fence desync, bare CR, nested blockquote/empty lists and multiline ref-title bombs", async (t) => {
  const deepQuote = "> ".repeat(30_000);
  const fenceDesyncs = [
    ["html-comment-fence-desync", `<!--\n\`\`\`\n-->\n${deepQuote}`],
    ["pre-fence-desync", `<pre>\n\`\`\`\n</pre>\n${deepQuote}`],
    ["uppercase-pre-fence-desync", `<PRE>\n\`\`\`\n</PRE>\n${deepQuote}`],
    ["script-fence-desync", `<script>\n\`\`\`\n</script>\n${deepQuote}`],
    ["style-fence-desync", `<style>\n\`\`\`\n</style>\n${deepQuote}`],
    ["textarea-fence-desync", `<textarea>\n\`\`\`\n</textarea>\n${deepQuote}`],
    ["div-fence-desync", `<div>\n\`\`\`\n</div>\n\n${deepQuote}`],
    ["custom-tag-fence-desync", `<foo>\n\`\`\`\n\n${deepQuote}`],
    ["hr-custom-tag-fence-desync", `---\n<foo>\n\`\`\`\n\n${deepQuote}`],
    ["pi-fence-desync", `<?xml\n\`\`\`\n?>\n${deepQuote}`],
    ["decl-fence-desync", `<!DOCTYPE\n\`\`\`\n>\n${deepQuote}`],
    ["cdata-fence-desync", `<![CDATA[\n\`\`\`\n]]>\n${deepQuote}`],
    ["list-indented-fence-desync", `- a\n  \`\`\`\n\n${deepQuote}`],
    ["nested-list-3space-fence-desync", `- a\n  - b\n   \`\`\`\n  ${deepQuote}`],
    ["def-title-quote-fence-desync", `[a]: https://example.com "\n\`\`\`\n"\n\n${deepQuote}`],
    ["def-title-nextline-fence-desync", `[a]: https://example.com\n"\n\`\`\`\n"\n\n${deepQuote}`],
    ["def-title-escaped-quote-fence-desync", `[a]: https://example.com "x\\"\n\`\`\`\n"\n\n${deepQuote}`],
    ["def-label-fence-desync", `[a\n\`\`\`\n]: https://example.com\n\n${deepQuote}`],
    ["def-dest-fence-desync", `[a]:\n\`\`\`\n\n${deepQuote}`],
    ["bare-cr-quote-bypass", `x\r${deepQuote}`],
    ["bare-cr-ref-bomb", `x\r[a]: https://example.com/${"a".repeat(10_000)}\r\r${"[a]".repeat(500)}`],
    ["bare-cr-nested-list", Array.from({ length: 300 }, (_, i) => "\t".repeat(i) + "- x").join("\r")],
    ["blockquote-nested-list", Array.from({ length: 300 }, (_, i) => "> " + "\t".repeat(i) + "- x").join("\n")],
    ["empty-nested-list", Array.from({ length: 400 }, (_, i) => "\t".repeat(i) + "-").join("\n")],
    ["multiline-ref-title-same-line", `[a]: https://example.com "t\n${"x".repeat(10_000)}"\n\n${"[a]".repeat(500)}`],
    ["multiline-ref-title-next-line", `[a]: https://example.com\n"t\n${"x".repeat(10_000)}"\n\n${"[a]".repeat(500)}`],
  ];

  for (const [label, payload] of fenceDesyncs) {
    const started = performance.now();
    assert.equal(isSafeToParseMarkdown(payload), false, `${label} must fail pre-check`);
    const meta = renderReportWithMeta(payload);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 50, `${label} took too long: ${elapsedMs.toFixed(2)}ms`);
    assert.match(meta.html, /^<pre>/);
    assert.equal(meta.toc.length, 0);
  }

  const legitListFence = "- Example:\n  ```ts\n  const foo_bar = 1;\n  ```\n\n## Summary\n\nAll checks passed.";
  assert.equal(isSafeToParseMarkdown(legitListFence), true);
  const legitListMeta = renderReportWithMeta(legitListFence);
  assert.match(legitListMeta.html, /<code class="language-ts">/);
  assert.match(legitListMeta.html, /<h2 id="sec-summary">Summary<\/h2>/);

  const legitPreThenFence = "<pre>\nhello\n</pre>\n\n```ts\nconst x = 1;\n```\n";
  assert.equal(isSafeToParseMarkdown(legitPreThenFence), true);
  assert.match(renderReport(legitPreThenFence), /<code class="language-ts">/);

  const largeCodeFence = "```\n" + "a\n".repeat(40_000) + "```";
  assert.equal(isSafeToParseMarkdown(largeCodeFence), true);
  assert.match(renderReport(largeCodeFence), /^<pre><code>/);

  const { call, signIn, issueApiKey } = createHarness(t);
  const { cookie } = await signIn(t, { id: 996, login: "bare-cr-sidecar" });
  const key = await issueApiKey(cookie);
  const crSidecar = await call("/api/reports?filename=report.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: "intro\r# PR Review Audit Sidecar\rEvidence",
  });
  assert.equal(crSidecar.status, 400);
});

test("markdown: blocks marked 18.2 email-lookahead, GFM autolink backpedal, task-list, inline-link, HTML-comment, single-tilde and TOC DoS", async (t) => {
  const cpuBombs = [
    ["underscore-email-lookahead-128kb", "a_".repeat(64_000)],
    ["double-underscore-lookahead-120kb", "a__".repeat(40_000)],
    ["digit-underscore-lookahead-120kb", "1_".repeat(60_000)],
    ["bang-email-lookahead-128kb", "a!".repeat(64_000)],
    ["http-email-lookahead-125kb", "ahttp".repeat(25_000)],
    ["table-cell-underscore-120kb", `| a |\n| - |\n| ${"a_".repeat(60_000)} |`],
    ["gfm-autolink-parens-120kb", `https://example.com/${")".repeat(120_000)}`],
    ["gfm-autolink-dots-120kb", `https://example.com/${".".repeat(120_000)}`],
    ["gfm-autolink-punct-120kb", `https://example.com/${"?!,:;".repeat(24_000)}`],
    ["gfm-autolink-entities-120kb", `https://example.com/${"&amp;".repeat(24_000)}`],
    ["gfm-autolink-www-parens-120kb", `www.example.com/${")".repeat(120_000)}`],
    ["gfm-autolink-ftp-parens-120kb", `ftp://a.b/${")".repeat(120_000)}`],
    ["gfm-autolink-repeated-chunks", (`https://a.co/${")".repeat(1000)} `).repeat(120)],
    ["task-list-unchecked-16k", "- [ ] a\n".repeat(16_000)],
    ["task-list-checked-16k", "- [x] a\n".repeat(16_000)],
    ["task-list-ordered-14k", "1. [ ] a\n".repeat(14_000)],
    ["list-items-30k", "- a\n".repeat(30_000)],
    ["parallel-empty-links-25k", "[a]()".repeat(25_000)],
    ["parallel-empty-images-24k", "![]()".repeat(24_000)],
    ["inline-html-comment-30k", `x ${"<!--".repeat(30_000)}`],
    ["star-html-comment-30k", `*a* ${"<!--".repeat(30_000)}`],
    ["inline-html-pi-60k", `x ${"<?".repeat(60_000)}`],
    ["inline-html-decl-30k", `x ${"<!A ".repeat(30_000)}`],
    ["inline-html-cdata-12k", `x ${"<![CDATA[]]".repeat(12_000)}`],
    ["star-angle-tags-40k", `*a* ${"<1>".repeat(40_000)}`],
    ["single-tilde-intraword-120kb", `${"a~".repeat(30_000)}x${"~a".repeat(30_000)}`],
    ["single-tilde-nested-500", `${"~a ".repeat(500)}x${" a~".repeat(500)}`],
    ["wide-table-30k-cols", `${"|a".repeat(30_000)}|\n${"|-".repeat(30_000)}|`],
    ["headings-toc-25k", "## a\n".repeat(25_000)],
  ];

  for (const [label, payload] of cpuBombs) {
    const started = performance.now();
    assert.equal(isSafeToParseMarkdown(payload), false, `${label} must fail pre-check`);
    const meta = renderReportWithMeta(payload);
    const elapsedMs = performance.now() - started;
    assert.ok(elapsedMs < 50, `${label} took too long: ${elapsedMs.toFixed(2)}ms`);
    assert.match(meta.html, /^<pre>/);
    assert.equal(meta.toc.length, 0);
  }

  const { call, signIn, issueApiKey } = createHarness(t);
  const { cookie } = await signIn(t, { id: 997, login: "cpu-bomb-upload" });
  const key = await issueApiKey(cookie);
  const started = performance.now();
  const uploaded = await call("/api/reports?filename=underscore-dos.md", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}` },
    body: "a_".repeat(64_000),
  });
  assert.equal(uploaded.status, 201);
  const { id } = await uploaded.json();
  const viewed = await call(`/workspace/reports/${id}`, { headers: { Cookie: cookie } });
  assert.equal(viewed.status, 200);
  assert.ok(performance.now() - started < 150);
  assert.match(await viewed.text(), /<pre>/);

  const richCjkTable = "| Finding | 結果 | 說明 |\n| :--- | :---: | :--- |\n" +
    Array.from({ length: 500 }, (_, i) =>
      `| R${i} | ${i % 2 === 0 ? "FIXED" : "STILL_OPEN"} | **說明_${i}** \`code_foo_bar_${i}\` [link](https://example.com/${i}) |`).join("\n");
  assert.equal(isSafeToParseMarkdown(richCjkTable), true);
  const richMeta = renderReportWithMeta(richCjkTable);
  assert.match(richMeta.html, /<table>/);
  assert.equal(richMeta.totalStatusRowCount, 500);
  assert.equal(richMeta.stillOpenRowCount, 250);
});

test("billing & auth: blocks ambiguous pro order.refunded lane confusion, duplicate checkout plan query and C1 control OAuth params", async (t) => {
  const { db, env, call, extractCookie, signIn, signPolar } = createHarness(t);
  env.BILLING_MODE = "polar_live";
  const { userId, cookie } = await signIn(t, { id: 998, login: "lane-and-checkout-guard" });
  const customer = { external_id: userId };

  const grantPass = await call("/webhooks/polar", signPolar("grant-pass-998", JSON.stringify({
    type: "order.paid",
    data: { customer, subscription_id: null, metadata: { plan: "pro_pass" } },
  })));
  assert.equal(grantPass.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");

  const ambiguousProRefund = await call("/webhooks/polar", signPolar("ambiguous-pro-refund-998", JSON.stringify({
    type: "order.refunded",
    data: { customer, status: "refunded", metadata: { plan: "pro" } },
  })));
  assert.equal(ambiguousProRefund.status, 400);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");

  const recurringProRefund = await call("/webhooks/polar", signPolar("recurring-pro-refund-998", JSON.stringify({
    type: "order.refunded",
    data: { customer, status: "refunded", product: { is_recurring: true }, metadata: { plan: "pro" } },
  })));
  assert.equal(recurringProRefund.status, 200);
  assert.equal(db.prepare("SELECT plan FROM users WHERE id = ?").get(userId).plan, "pro_pass");

  for (const qs of ["?plan=pro&plan=pro_pass", "?plan=pro&plan=pro", "?plan=pro_pass&plan=pro"]) {
    const res = await call(`/workspace/checkout${qs}`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 400, `duplicate checkout ${qs} must fail closed with 400`);
  }
  const singleCheckout = await call("/workspace/checkout?plan=pro", { headers: { Cookie: cookie } });
  assert.equal(singleCheckout.status, 303);

  const start = await call("/auth/github");
  const stateCookie = extractCookie(start, "__Host-prc_oauth_state");
  const state = new URL(start.headers.get("Location")).searchParams.get("state");
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("C1 control OAuth callback must not call GitHub");
  });
  try {
    for (const encoded of ["ok%C2%85x", "ok%C2%9Bx"]) {
      const res = await call(`/auth/github/callback?state=${state}&code=${encoded}`, {
        headers: { Cookie: stateCookie },
      });
      assert.equal(res.status, 400, `C1 control ${encoded} must return 400`);
    }
    assert.equal(network.mock.callCount(), 0);
  } finally {
    network.mock.restore();
  }
});
