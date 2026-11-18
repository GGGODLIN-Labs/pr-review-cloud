import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import worker from "../src/index.ts";

const origin = "https://app.example";
const schema = readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8");
const mainReport = "# Review alpha\n\n**Report projection schema**: 2\n**PR**: #123\n**Prior review continuity**: CHECKED (fixed 1 / still-open 0 / stale 0)\n\nChanged code.";
const reportLink = /href="(\/workspace\/reports\/[^"/]+)">Review alpha<\/a>/;
const shareLink = /href="(\/s\/[A-Za-z0-9_-]{43,})"/;
const digest = (value) => createHash("sha256").update(value).digest("hex");

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(schema);
  const env = {
    DB: {
      prepare(sql) {
        const stmt = db.prepare(sql);
        const bound = (args) => ({
          bind: (...values) => bound(values),
          async first() { return stmt.get(...args) ?? null; },
          async all() { return { success: true, results: stmt.all(...args) }; },
          async run() { return { success: true, meta: { changes: stmt.run(...args).changes } }; },
        });
        return bound([]);
      },
    },
    GITHUB_CLIENT_ID: "synthetic-client-id",
    GITHUB_CLIENT_SECRET: "synthetic-client-secret",
  };
  const fetch = (path, init) => worker.fetch(new Request(`${origin}${path}`, init), env);

  function account(id, { plan = "free", githubId = id } = {}) {
    const session = `synthetic-session-${id}`;
    const key = `prc_synthetic-key-${id}`;
    db.prepare("INSERT INTO users (id, github_id, github_login, plan) VALUES (?, ?, ?, ?)")
      .run(id, githubId, id, plan);
    db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))")
      .run(digest(session), id);
    db.prepare("INSERT INTO api_keys (id, user_id, name, key_prefix, key_hash) VALUES (?, ?, 'Fixture', ?, ?)")
      .run(id, id, key.slice(0, 12), digest(key));
    return { cookie: `__Host-prc_session=${session}`, key };
  }

  return { fetch, account };
}

function cookieFrom(response, name) {
  const header = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  assert.equal(typeof header, "string", `${name} must be set`);
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) {
    assert.equal(header.split(/;\s*/).includes(flag), true, `cookie must set ${flag}`);
  }
  return header.split(";", 1)[0];
}

function mockGitHub(t, overrides = {}) {
  return t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token") {
      assert.equal(init.method, "POST");
      const exchange = new URLSearchParams(init.body);
      for (const [field, expected] of Object.entries({
        code: "synthetic-code",
        client_id: "synthetic-client-id",
        client_secret: "synthetic-client-secret",
        redirect_uri: `${origin}/auth/github/callback`,
      })) {
        assert.equal(exchange.get(field) === expected, true, `OAuth exchange must include ${field}`);
      }
      return overrides.exchange ? overrides.exchange() : Response.json({ access_token: "synthetic-github-token" });
    }
    assert.equal(url, "https://api.github.com/user");
    assert.equal(new Headers(init.headers).get("Authorization") === "Bearer synthetic-github-token", true, "GitHub user request must authenticate");
    return Response.json(overrides.profile ?? { id: 123, login: "octo-reviewer", avatar_url: "https://avatars.example/person" });
  });
}

async function startLogin(fetch) {
  const response = await fetch("/auth/github");
  assert.equal(response.status, 302, "GitHub login starts with a redirect");
  const cookie = cookieFrom(response, "__Host-prc_oauth_state");
  const target = new URL(response.headers.get("Location"));
  assert.equal(target.origin + target.pathname, "https://github.com/login/oauth/authorize");
  assert.equal(target.searchParams.get("client_id"), "synthetic-client-id");
  assert.equal(target.searchParams.get("redirect_uri"), `${origin}/auth/github/callback`);
  assert.equal(target.searchParams.get("scope"), "read:user");
  const state = target.searchParams.get("state");
  assert.equal(/^[A-Za-z0-9_-]{43,}$/.test(state ?? ""), true, "state must be an opaque random token");
  assert.equal(cookie.endsWith(`=${state}`), true, "state must match the cookie");
  return { cookie, callback: `/auth/github/callback?code=synthetic-code&state=${state}` };
}

const browser = (cookie, body) => ({ method: "POST", headers: { Cookie: cookie, Origin: origin }, body });
const view = (fetch, path, cookie) => fetch(path, cookie ? { headers: { Cookie: cookie } } : undefined);
const cli = (fetch, key, body, filename = "review.md") => fetch(`/api/reports?filename=${encodeURIComponent(filename)}`, {
  method: "POST", headers: { Authorization: `Bearer ${key}` }, body,
});
function formFile(filename, body) {
  const form = new FormData();
  form.set("file", new Blob([body]), filename);
  return form;
}
async function uploadedPath(response) {
  assert.equal(response.status, 201, "CLI upload creates a report");
  const { id } = await response.json();
  assert.match(id, /^[A-Za-z0-9-]+$/);
  return `/workspace/reports/${id}`;
}

async function publish(fetch, path, cookie) {
  const response = await fetch(`${path}/share`, browser(cookie, new URLSearchParams({ confirm_code_anchors: "1" })));
  assert.equal(response.status, 303);
  const page = await view(fetch, response.headers.get("Location"), cookie);
  assert.equal(page.status, 200);
  const link = (await page.text()).match(shareLink)?.[1];
  assert.equal(Boolean(link), true, "owner sees a high-entropy share link");
  return link;
}

async function errorWithoutCredentials(response, { key, cookie, status }) {
  assert.equal(response.status, status);
  const body = await response.text();
  const output = `${body}\n${JSON.stringify([...response.headers])}`;
  if (key) assert.equal(output.includes(key), false, "error must not echo secret");
  if (cookie) {
    assert.equal(output.includes(cookie), false, "error must not echo Cookie");
    assert.equal(output.includes(cookie.split("=", 2)[1]), false, "error must not echo session token");
  }
  return body;
}

test("GitHub login unlocks the workspace, one-time CLI key, history, raw download and logout", async (t) => {
  const { fetch } = fixture(t);
  mockGitHub(t);
  assert.match(await (await fetch("/")).text(), /href="\/auth\/github">Sign in with GitHub/);
  const login = await startLogin(fetch);
  const callback = await view(fetch, login.callback, login.cookie);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("Location"), "/workspace");
  const cookie = cookieFrom(callback, "__Host-prc_session");
  const workspace = await view(fetch, "/workspace", cookie);
  assert.equal(workspace.status, 200);
  const home = await workspace.text();
  assert.match(home, /octo-reviewer/);
  assert.match(home, /Cmd \+ Shift \+ \./);
  assert.match(home, /Ctrl \+ H/);
  assert.match(home, /type="file" name="file"/);

  const issued = await fetch("/workspace/keys", browser(cookie));
  assert.equal(issued.status, 201);
  assert.equal(issued.headers.get("Cache-Control"), "no-store");
  const instruction = await issued.text();
  const key = instruction.match(/\bprc_[A-Za-z0-9_-]{43}\b/)?.[0];
  assert.equal(Boolean(key), true, "creation shows the full key once");
  assert.equal(instruction.includes(`Authorization: Bearer ${key}`), true, "command authenticates with the issued key");
  assert.equal(instruction.includes("--data-binary"), true, "command uploads the file as bytes");
  const dashboard = await (await view(fetch, "/workspace", cookie)).text();
  assert.equal(dashboard.includes(key), false, "workspace must not show the full key again");
  const revoke = dashboard.match(/action="(\/workspace\/keys\/[^"/]+\/revoke)"/)?.[1];
  assert.ok(revoke);
  const path = await uploadedPath(await cli(fetch, key, mainReport));
  const list = await (await view(fetch, "/workspace", cookie)).text();
  assert.equal(list.match(reportLink)?.[1], path);
  assert.match(list, /CHECKED \(fixed 1 \/ still-open 0 \/ stale 0\)/);
  assert.match(list, new RegExp(`\\b${Buffer.byteLength(mainReport)} bytes\\b`));
  assert.match(list, /私有/);
  const raw = await view(fetch, `${path}/raw`, cookie);
  assert.equal(raw.status, 200);
  assert.equal(raw.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.match(raw.headers.get("Content-Disposition"), /^attachment;.*\.md/);
  assert.equal(await raw.text(), mainReport);

  assert.equal((await fetch(revoke, browser(cookie))).status, 303);
  await errorWithoutCredentials(await cli(fetch, key, mainReport), { key, status: 401 });
  await errorWithoutCredentials(await cli(fetch, "prc_synthetic-unknown-key", mainReport), {
    key: "prc_synthetic-unknown-key", status: 401,
  });
  const logout = await fetch("/auth/logout", browser(cookie));
  assert.equal(logout.status, 302);
  assert.equal(logout.headers.get("Location"), "/");
  assert.equal(cookieFrom(logout, "__Host-prc_session"), "__Host-prc_session=");
  assert.equal((await view(fetch, path, cookie)).status, 401, "server invalidates the old session");
});

test("OAuth rejects missing or mismatched state and fails closed on upstream errors", async (t) => {
  const { fetch } = fixture(t);
  let failure = "status";
  const network = mockGitHub(t, {
    exchange() {
      if (failure === "exception") throw new Error("synthetic upstream timeout");
      if (failure === "missing-token") return Response.json({ error: "bad_code" });
      if (failure === "valid" || failure === "missing-id") return Response.json({ access_token: "synthetic-github-token" });
      return new Response("synthetic OAuth provider failure", { status: 503 });
    },
    get profile() { return failure === "missing-id" ? { login: "no-id" } : { id: 123, login: "octo-reviewer" }; },
  });
  const login = await startLogin(fetch);
  for (const [path, cookie] of [
    ["/auth/github/callback?code=synthetic-code", login.cookie],
    ["/auth/github/callback?code=synthetic-code&state=synthetic-unmatched", login.cookie],
    [login.callback, undefined],
  ]) {
    const response = await view(fetch, path, cookie);
    assert.equal(response.status, 400);
    assert.match(await response.text(), /state/i);
    assert.equal(cookieFrom(response, "__Host-prc_oauth_state"), "__Host-prc_oauth_state=");
    assert.equal(response.headers.getSetCookie().some((value) => value.startsWith("__Host-prc_session=")), false);
  }
  assert.equal(network.mock.callCount(), 0);
  for (failure of ["status", "missing-token", "missing-id", "exception"]) {
    const attempt = await startLogin(fetch);
    const response = await view(fetch, attempt.callback, attempt.cookie);
    assert.equal(response.status, 502, failure);
    assert.match(await response.text(), /GitHub/);
    assert.equal(cookieFrom(response, "__Host-prc_oauth_state"), "__Host-prc_oauth_state=");
    assert.equal(response.headers.getSetCookie().some((value) => value.startsWith("__Host-prc_session=")), false);
    assert.equal((await view(fetch, "/workspace", attempt.cookie)).status, 401);
  }
  failure = "valid";
  const next = await startLogin(fetch);
  const callback = await view(fetch, next.callback, next.cookie);
  assert.equal(callback.status, 302);
  assert.equal((await view(fetch, "/workspace", cookieFrom(callback, "__Host-prc_session"))).status, 200);
});

test("file picker and CLI apply identical byte, UTF-8, filename and empty checks", async (t) => {
  const { fetch, account } = fixture(t);
  const { cookie, key } = account("owner");
  const picker = (filename, bytes) => fetch("/workspace/reports", browser(cookie, formFile(filename, bytes)));
  const fromCLI = (filename, bytes) => cli(fetch, key, bytes, filename);
  const max = "# 邊界\r\n" + "x".repeat(131072 - Buffer.byteLength("# 邊界\r\n"));
  const selected = await picker("review.md", max);
  assert.equal(selected.status, 303, "picker accepts exactly 131,072 bytes");
  const selection = selected.headers.get("Location");
  assert.ok(selection?.startsWith("/workspace/reports/"));
  assert.equal((await (await view(fetch, `${selection}/raw`, cookie)).text()) === max, true, "picker must preserve original bytes");
  const path = await uploadedPath(await fromCLI("review.md", max));
  assert.equal((await (await view(fetch, `${path}/raw`, cookie)).text()) === max, true, "CLI must preserve original bytes");

  for (const upload of [picker, fromCLI]) {
    for (const [filename, bytes, status, message] of [
      ["review.md", "", 400, /空白|empty/i],
      ["review.md", " \r\n\t", 400, /空白|empty/i],
      ["review.md", Uint8Array.of(0xc3, 0x28), 400, /UTF-8/i],
      ["review.md", new Uint8Array(131073).fill(0xff), 413, null],
      ["review.AUDIT.MD", mainReport, 400, /主報告.*\.md/],
    ]) {
      const body = await errorWithoutCredentials(await upload(filename, bytes), { key, cookie, status });
      if (message) assert.match(body, message);
    }
  }
  const multipart = await fetch("/api/reports", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: formFile("multipart.md", "No Markdown heading"),
  });
  await uploadedPath(multipart);
  assert.match(await (await view(fetch, "/workspace", cookie)).text(), />multipart\.md<\/a>/);
});

test("raw download preserves the BOM, line endings and embedded NUL of valid UTF-8", async (t) => {
  const { fetch, account } = fixture(t);
  const { cookie, key } = account("raw-owner");
  const original = "﻿# Original\r\n\r\nBefore\u0000After\r\n";
  const path = await uploadedPath(await cli(fetch, key, original));
  const raw = await view(fetch, `${path}/raw`, cookie);
  assert.equal(raw.status, 200);
  assert.deepEqual(Buffer.from(await raw.arrayBuffer()), Buffer.from(original));
});

test("free accounts refuse the twenty-first upload and preserve every original and share", async (t) => {
  const { fetch, account } = fixture(t);
  const { cookie, key } = account("free-owner");
  const paid = account("paid-owner", { plan: "pro_pass", githubId: "123" });
  mockGitHub(t);
  const originals = [];
  for (let i = 1; i < 20; i++) {
    const content = `# Original ${i}\n\nUndisturbed contents ${i}`;
    const path = await uploadedPath(await cli(fetch, key, content));
    const share = i % 2 === 0 ? await publish(fetch, path, cookie) : undefined;
    originals.push({ path, content, share });
  }
  const contenders = ["# Original 20\n\nLast slot via CLI", "# Original 20\n\nLast slot via picker"];
  const [lastCLI, lastPicker] = await Promise.all([
    cli(fetch, key, contenders[0]),
    fetch("/workspace/reports", browser(cookie, formFile("last.md", contenders[1]))),
  ]);
  if (lastCLI.status === 201) {
    assert.equal(lastPicker.status, 409, "only one upload can take the final slot");
    originals.push({ path: await uploadedPath(lastCLI), content: contenders[0] });
  } else {
    assert.equal(lastCLI.status, 409, "only one upload can take the final slot");
    assert.equal(lastPicker.status, 303);
    originals.push({ path: lastPicker.headers.get("Location"), content: contenders[1] });
  }
  const before = await (await view(fetch, "/workspace", cookie)).text();
  assert.equal((before.match(/>Original \d+<\/a>/g) ?? []).length, 20);
  for (const response of [
    await cli(fetch, key, "# Must not be stored via CLI"),
    await fetch("/workspace/reports", browser(cookie, formFile("over.md", "# Must not be stored via picker"))),
  ]) {
    assert.equal([403, 409].includes(response.status), true, "at capacity the new upload must be rejected");
    assert.match(await response.text(), /刪除舊報告.*升級/);
  }
  assert.equal(await (await view(fetch, "/workspace", cookie)).text(), before);
  for (const { path, content, share } of originals) {
    const raw = await view(fetch, `${path}/raw`, cookie);
    assert.equal(raw.status, 200);
    assert.equal(await raw.text(), content);
    const detail = await view(fetch, path, cookie);
    assert.equal((await detail.text()).match(shareLink)?.[1], share);
    if (share) {
      const shared = await fetch(share);
      assert.equal(shared.status, 200);
      assert.equal((await shared.text()).includes(content.split("\n\n")[1]), true);
    }
  }
  for (let i = 1; i <= 20; i++) {
    await uploadedPath(await cli(fetch, paid.key, `# Paid history ${i}`));
  }
  const login = await startLogin(fetch);
  const callback = await view(fetch, login.callback, login.cookie);
  assert.equal(callback.status, 302);
  const renewed = cookieFrom(callback, "__Host-prc_session");
  const existing = await view(fetch, "/workspace", renewed);
  assert.equal(existing.status, 200);
  assert.match(await existing.text(), />Paid history 20<\/a>/);
  const allowed = await fetch("/workspace/reports", browser(renewed, formFile("paid.md", "# Paid report 21")));
  assert.equal(allowed.status, 303, "GitHub re-login preserves the paid quota");
});

test("private reports and raw files enforce ownership and shared links stop working immediately", async (t) => {
  const { fetch, account } = fixture(t);
  const owner = account("share-owner");
  const visitor = account("other-user");
  const report = `${mainReport}\n\n<script>/* fixture */</script>`;
  const path = await uploadedPath(await cli(fetch, owner.key, report));
  const detail = await view(fetch, path, owner.cookie);
  assert.equal(detail.status, 200);
  const privateHtml = await detail.text();
  assert.match(privateHtml, /程式碼錨點片段/);
  assert.match(privateHtml, /name="confirm_code_anchors"/);
  assert.doesNotMatch(privateHtml, shareLink);
  assert.equal((await view(fetch, `${path}/raw`, owner.cookie)).status, 200);
  for (const endpoint of [path, `${path}/raw`]) {
    assert.equal((await fetch(endpoint)).status, 401);
    assert.equal((await view(fetch, endpoint, visitor.cookie)).status, 404);
  }
  assert.equal((await fetch(`${path}/share`, browser(owner.cookie))).status, 400);
  assert.doesNotMatch(await (await view(fetch, path, owner.cookie)).text(), shareLink);
  const confirm = new URLSearchParams({ confirm_code_anchors: "1" });
  assert.equal((await fetch(`${path}/share`, browser(visitor.cookie, confirm))).status, 404);
  assert.equal((await fetch(`${path}/share`, {
    method: "POST", headers: { Cookie: owner.cookie, Origin: "https://other.example" }, body: confirm,
  })).status, 403);
  const share = await publish(fetch, path, owner.cookie);
  const publicPage = await fetch(share);
  assert.equal(publicPage.status, 200);
  assert.equal(publicPage.headers.get("Cache-Control"), "no-store");
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Changed code\./);
  assert.match(publicHtml, /&lt;script&gt;\/\* fixture \*\/&lt;\/script&gt;/);
  assert.doesNotMatch(publicHtml, /<script\b/);
  assert.equal((await fetch(`${path}/unshare`, browser(visitor.cookie))).status, 404);
  await fetch(`${path}/delete`, browser(visitor.cookie));
  assert.equal((await fetch(share)).status, 200, "another account cannot unshare or delete the report");
  for (let i = 0; i < 2; i++) {
    assert.equal((await fetch(`${path}/unshare`, browser(owner.cookie))).status, 303);
    assert.equal((await fetch(share)).status, 404);
  }
  const replacement = await publish(fetch, path, owner.cookie);
  assert.notEqual(replacement, share);
  assert.equal((await fetch(replacement)).status, 200);
  assert.equal((await fetch(share)).status, 404);
  for (let i = 0; i < 2; i++) {
    assert.equal((await fetch(`${path}/delete`, browser(owner.cookie))).status, 303);
    assert.equal((await fetch(replacement)).status, 404);
    assert.equal((await view(fetch, `${path}/raw`, owner.cookie)).status, 404);
  }
});
