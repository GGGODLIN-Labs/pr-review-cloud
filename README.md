# PR Review Cloud

**PR Review Cloud** (`https://app.gggodlin.com`) is the zero-LLM-burn cloud workspace for [claude-pr-review](https://github.com/GGGODLIN/claude-pr-review), built and operated by [GGGODLIN Labs](https://gggodlin.com) on Cloudflare Workers and Cloudflare D1.

## Architecture

- **Local CLI inference, cloud persistence**: Developers run multi-axis PR reviews locally with [claude-pr-review](https://github.com/GGGODLIN/claude-pr-review) using their own model credentials. PR Review Cloud never stores model API keys and never invokes LLM inference on the server.
- **Pre-computed cross-round continuity**: Round-to-round finding reconciliation (`FIXED`, `STILL_OPEN`, `STALE`) is verified locally against real source code before upload and rendered directly from `Report projection schema: 2` Markdown reports without lossy cloud diffing.
- **Private by default & revocable sharing**: Uploaded `.md` reports default to owner-only access (`128 KB` per-report cap; `.audit.md` sidecars rejected). Public read-only links require explicit confirmation and carry `Cache-Control: no-store` so revocation takes effect immediately (`404`).
- **Safe Markdown rendering**: Raw inline HTML is escaped and link/image protocols are restricted to `http:` and `https:`.
- **Bounded plans & Polar Merchant of Record**: `Free` (`20` reports), `Pro` (`$19/mo`, `500` reports), and one-time `Pro Pass` (`$49`, `500` reports with a 12-month operation guarantee and pro-rata retirement refund). Billing is gated behind `BILLING_MODE` (`disabled` | `polar_live`) and deduplicated atomically in `billing_events` via Standard Webhooks verification.

Architecture decision records live under [/openspec/decisions](/openspec/decisions).

## Local Development & Verification

Requires Node.js 24+ (uses built-in `node:test` and `node:sqlite` for end-to-end Worker + SQLite integration tests).

```bash
npm ci
npm run typecheck
npm test
npx wrangler deploy --dry-run --config wrangler.jsonc
```

## Production Configuration

- **Cloudflare D1**: Create `pr-review-cloud-db`, set repository variable `D1_DATABASE_ID` and `CLOUDFLARE_ACCOUNT_ID`, and apply [/migrations/0001_init.sql](/migrations/0001_init.sql).
- **Worker Secrets**:
  - `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` (GitHub OAuth callback `https://app.gggodlin.com/auth/github/callback`)
  - `POLAR_WEBHOOK_SECRET`, `POLAR_PRO_CHECKOUT_URL`, and `POLAR_PRO_PASS_CHECKOUT_URL` (required when `BILLING_MODE="polar_live"`)
