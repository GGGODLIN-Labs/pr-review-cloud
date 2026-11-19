import { Webhook } from "standardwebhooks";
import { redirect, type Env } from "./auth.ts";
import { readBoundedBody } from "./body.ts";

const encoder = new TextEncoder();
const fields = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown) => typeof value === "string" && value.trim() ? value : undefined;

function referenceKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// Separate checkout references from the Standard Webhooks signing input.
const referenceMessage = (userId: string) => encoder.encode(`pr-review-cloud/checkout-reference/v1:${userId}`);

async function checkoutReference(secret: string, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await referenceKey(secret), referenceMessage(userId));
  const tag = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${userId}.${tag}`;
}

async function eventUser(data: Record<string, unknown>, secret: string): Promise<string | undefined> {
  const metadata = fields(data.metadata);
  // Hosted Checkout Links carry reference_id as editable query metadata.
  if (metadata?.reference_id !== undefined) {
    const match = text(metadata.reference_id)?.match(/^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/);
    if (!match) return undefined;
    const [, userId, tag] = match;
    const mac = Uint8Array.from(tag.match(/../g) ?? [], (byte) => Number.parseInt(byte, 16));
    return await crypto.subtle.verify("HMAC", await referenceKey(secret), mac, referenceMessage(userId)) ? userId : undefined;
  }
  return text(fields(data.customer)?.external_id) ?? text(data.external_customer_id) ?? text(metadata?.user_id);
}

export async function startCheckout(env: Env, userId: string, plan: string | null): Promise<Response> {
  if (env.BILLING_MODE !== "polar_live") return new Response("付費升級即將開放。", { status: 403 });
  if (plan !== "pro" && plan !== "pro_pass") return new Response("無效的付費方案。", { status: 400 });
  const configured = plan === "pro" ? env.POLAR_PRO_CHECKOUT_URL : env.POLAR_PRO_PASS_CHECKOUT_URL;
  const target = URL.parse(configured ?? "");
  if (!env.POLAR_WEBHOOK_SECRET || !target || target.protocol !== "https:" || target.username || target.password) {
    return new Response("結帳暫時無法使用。", { status: 503 });
  }
  target.searchParams.set("customer_external_id", userId);
  target.searchParams.set("metadata[user_id]", userId);
  target.searchParams.set("metadata[plan]", plan);
  target.searchParams.set("reference_id", await checkoutReference(env.POLAR_WEBHOOK_SECRET, userId));
  return redirect(target.href);
}

// null is a valid event that leaves entitlements unchanged; undefined lacks information to decide.
function planAfter(type: string, data: Record<string, unknown>): "free" | "pro" | "pro_pass" | null | undefined {
  switch (type) {
    case "subscription.active":
      return "pro";
    case "subscription.revoked":
      return "free";
    case "subscription.canceled": {
      const endedAt = Date.parse(text(data.ended_at) ?? "");
      return endedAt <= Date.now() || data.status === "unpaid" ? "free" : null;
    }
    case "order.paid": {
      const recurring = fields(data.product)?.is_recurring;
      if (text(data.subscription_id) || recurring === true) return "pro";
      if (data.subscription_id === null || recurring === false || fields(data.metadata)?.plan === "pro_pass") return "pro_pass";
      return undefined;
    }
    case "order.refunded": {
      if (data.status === "refunded") return "free";
      if (data.status === "partially_refunded") return null;
      const { refunded_amount: refunded, net_amount: net } = data;
      if (typeof refunded !== "number" || !Number.isSafeInteger(refunded) || refunded < 0 ||
          typeof net !== "number" || !Number.isSafeInteger(net) || net < 0) return undefined;
      return net > 0 && refunded >= net ? "free" : null;
    }
    default:
      return null;
  }
}

export async function polarWebhook(request: Request, env: Env): Promise<Response> {
  const badRequest = () => new Response("無效的 Polar 通知。", { status: 400 });
  const secret = env.POLAR_WEBHOOK_SECRET;
  if (!secret) return new Response("Polar 通知暫時無法使用。", { status: 503 });
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (!id || !timestamp || !signature || !/^\d{1,12}$/.test(timestamp)) return badRequest();
  const bytes = await readBoundedBody(request, 1_048_576).catch(() => null);
  if (!bytes) return badRequest();

  let body: string;
  let event: Record<string, unknown> | undefined;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
    try {
      new Webhook(secret).verify(body, headers, { jsonParse: false });
    } catch {
      // Older Polar endpoints sign with the UTF-8 bytes of the full secret.
      new Webhook(encoder.encode(secret), { format: "raw" }).verify(body, headers, { jsonParse: false });
    }
    event = fields(JSON.parse(body));
  } catch {
    return badRequest();
  }
  const type = text(event?.type);
  const data = fields(event?.data);
  if (!type || !data) return badRequest();
  const db = env.DB;
  if (!db) return new Response("Polar 通知暫時無法使用。", { status: 503 });
  if (await db.prepare("SELECT 1 FROM billing_events WHERE event_id = ?").bind(id).first()) return new Response("OK");

  const plan = planAfter(type, data);
  if (plan === null) return new Response("OK");
  const userId = await eventUser(data, secret);
  if (!plan || !userId) return badRequest();
  const parsedTs = Date.parse(text(event?.timestamp) ?? "");
  const eventTs = Number.isFinite(parsedTs) ? parsedTs : Number(timestamp) * 1000;
  const subscriptionScoped = type.startsWith("subscription.") ||
    Boolean(text(data.subscription_id)) || fields(data.product)?.is_recurring === true ? 1 : 0;

  // Recheck event_id and per-lane event_ts inside the transaction so duplicate or out-of-order deliveries cannot regress
  // entitlements within the same lane, while subscription churn never blocks or overwrites a one-time pro_pass purchase.
  const results = await db.batch([
    db.prepare(`
      UPDATE users
      SET plan = CASE WHEN ? = 1 AND users.plan = 'pro_pass' THEN 'pro_pass' ELSE ? END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM billing_events WHERE event_id = ?)
        AND NOT EXISTS (
          SELECT 1 FROM billing_events
          WHERE user_id = users.id
            AND event_ts > ?
            AND (
              (? = 1 AND (event_type LIKE 'subscription.%' OR event_type = 'order.refunded' OR plan_after = 'pro'))
              OR (? = 0 AND (plan_after = 'pro_pass' OR event_type = 'order.refunded'))
            )
        )
    `).bind(subscriptionScoped, plan, userId, id, eventTs, subscriptionScoped, subscriptionScoped),
    db.prepare(`
      INSERT INTO billing_events (event_id, event_type, user_id, plan_after, event_ts, payload_json)
      VALUES (?, ?, (SELECT id FROM users WHERE id = ?), ?, ?, ?) ON CONFLICT (event_id) DO NOTHING
    `).bind(id, type, userId, plan, eventTs, body),
  ]);
  if (results.some((result) => !result.success)) return new Response("Polar 通知暫時無法使用。", { status: 503 });
  return new Response("OK");
}
