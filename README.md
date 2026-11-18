# PR Review Cloud

The local PR review CLI runs the models and reconciles findings across rounds. PR Review Cloud is a Cloudflare Worker that stores Markdown reports in D1 and displays the reconciliation already recorded in each report. The Worker makes zero model calls and needs no model credentials.

Open `/` or `/sample` to read the bundled two-round example without an account or a database. `/s/:shareToken` displays a stored report to anyone with its share link. Clear the report’s `share_token` in D1 to revoke that link.

## Local checks

Use Node.js 24 or newer.

```sh
npm ci
npm run typecheck
npm test
npx wrangler dev
```

The tests call the Worker’s `fetch` entry point. The share-route fixtures use in-memory SQLite, so the suite runs without Cloudflare credentials.

## Deployment

Create the `pr-review-cloud-db` D1 database and make `app.gggodlin.com` available as a Worker custom domain in the same Cloudflare account. In GitHub Actions, set repository variables `CLOUDFLARE_ACCOUNT_ID` and `D1_DATABASE_ID` and the secret `CLOUDFLARE_API_TOKEN`. Scope the token to the account and grant the permissions needed to migrate D1 and deploy the Worker and custom domain.

A push to `main` runs the checks, applies D1 migrations, deploys the Worker, and checks both public routes for HTTP 200 and the version marker.
