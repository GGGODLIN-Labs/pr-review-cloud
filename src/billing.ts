import { Webhook } from "standardwebhooks";
import { redirect, type Env } from "./auth.ts";
import { readBoundedBody } from "./body.ts";
import { errorPage } from "./page.ts";

const encoder = new TextEncoder();
const orderAmountKeys = [
  "amount",
  "net_amount",
  "total_amount",
  "subtotal_amount",
  "tax_amount",
  "refunded_amount",
  "refunded_tax_amount",
] as const;

const fields = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

const text = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const exactEventType = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value === value.trim() ? value : undefined;

const isOptionalObject = (value: unknown): boolean =>
  value === undefined || value === null || fields(value) !== undefined;

const isNonNegativeSafeInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

function hasValidOrderAmounts(data: Record<string, unknown>): boolean {
  for (const key of orderAmountKeys) {
    const value = data[key];
    if (value !== undefined && !isNonNegativeSafeInt(value)) return false;
  }
  return true;
}

function parseOrderScope(data: Record<string, unknown>): {
  hasSubId: boolean;
  recurring: boolean | undefined;
  metadataPlan: string | undefined;
} | null {
  if (data.subscription_id !== undefined && data.subscription_id !== null) {
    if (typeof data.subscription_id !== "string" || !text(data.subscription_id)) return null;
  }
  const recurring = fields(data.product)?.is_recurring;
  if (recurring !== undefined && typeof recurring !== "boolean") return null;
  const rawPlan = fields(data.metadata)?.plan;
  let metadataPlan: string | undefined;
  if (rawPlan !== undefined && rawPlan !== null) {
    if (typeof rawPlan !== "string" || !rawPlan || rawPlan !== rawPlan.trim()) return null;
    if (rawPlan !== "pro" && rawPlan !== "pro_pass") return null;
    metadataPlan = rawPlan;
  }
  const hasSubId = Boolean(text(data.subscription_id));
  if (hasSubId && recurring === false) return null;
  if (data.subscription_id === null && recurring === true) return null;
  const isRecurringOrder = hasSubId || recurring === true;
  if (isRecurringOrder && metadataPlan !== undefined && metadataPlan !== "pro") return null;
  const isOneTimeOrder = data.subscription_id === null || recurring === false;
  if (isOneTimeOrder && metadataPlan !== undefined && metadataPlan !== "pro_pass") return null;
  return { hasSubId, recurring, metadataPlan };
}

function referenceKey(secret: string) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

const referenceMessage = (userId: string) => encoder.encode(`pr-review-cloud/checkout-reference/v1:${userId}`);

async function checkoutReference(secret: string, userId: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await referenceKey(secret), referenceMessage(userId));
  const tag = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${userId}.${tag}`;
}

async function eventUser(data: Record<string, unknown>, secret: string): Promise<string | undefined> {
  const metadata = fields(data.metadata);
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
  if (env.BILLING_MODE !== "polar_live") {
    return errorPage("付費升級即將開放", "付費升級即將開放。目前工作區免費方案（最多 20 份報告）已可直接試用。", 403, { signedIn: true });
  }
  if (plan !== "pro" && plan !== "pro_pass") {
    return errorPage("無效的付費方案", "無效的付費方案，請從工作區選擇 Pro 或 Pro Pass。", 400, { signedIn: true });
  }
  const configured = plan === "pro" ? env.POLAR_PRO_CHECKOUT_URL : env.POLAR_PRO_PASS_CHECKOUT_URL;
  const target = URL.parse(configured ?? "");
  const secret = env.POLAR_WEBHOOK_SECRET;
  if (!secret || !secret.trim() || !target || target.protocol !== "https:" || target.username || target.password) {
    return errorPage("結帳暫時無法使用", "結帳暫時無法使用，請稍後再試。", 503, { signedIn: true });
  }
  target.searchParams.set("customer_external_id", userId);
  target.searchParams.set("metadata[user_id]", userId);
  target.searchParams.set("metadata[plan]", plan);
  target.searchParams.set("reference_id", await checkoutReference(secret, userId));
  return redirect(target.href);
}

function planAfter(type: string, data: Record<string, unknown>): "free" | "pro" | "pro_pass" | null | undefined {
  if (!isOptionalObject(data.customer) || !isOptionalObject(data.metadata) || !isOptionalObject(data.product)) {
    return undefined;
  }
  switch (type) {
    case "subscription.active":
      if (data.status !== undefined && data.status !== "active" && data.status !== "trialing") {
        return undefined;
      }
      return "pro";
    case "subscription.revoked":
      if (data.status !== undefined && (typeof data.status !== "string" || data.status === "active" || data.status === "trialing")) {
        return undefined;
      }
      return "free";
    case "subscription.canceled": {
      if (data.status !== undefined && typeof data.status !== "string") return undefined;
      let endedAt = Number.NaN;
      if (data.ended_at !== undefined && data.ended_at !== null) {
        const rawEndedAt = text(data.ended_at);
        if (!rawEndedAt) return undefined;
        endedAt = Date.parse(rawEndedAt);
        if (!Number.isFinite(endedAt)) return undefined;
      }
      return (Number.isFinite(endedAt) && endedAt <= Date.now()) || data.status === "unpaid" || data.status === "revoked"
        ? "free"
        : null;
    }
    case "order.paid": {
      if (!hasValidOrderAmounts(data)) return undefined;
      if (data.paid !== undefined && data.paid !== true) return undefined;
      if (data.status !== undefined && data.status !== "paid") return undefined;
      const scope = parseOrderScope(data);
      if (!scope) return undefined;
      if (scope.hasSubId || scope.recurring === true) return "pro";
      if (data.subscription_id === null || scope.recurring === false || scope.metadataPlan === "pro_pass") {
        return "pro_pass";
      }
      return undefined;
    }
    case "order.refunded": {
      if (!hasValidOrderAmounts(data)) return undefined;
      const scope = parseOrderScope(data);
      if (!scope) return undefined;
      if (!scope.hasSubId && scope.recurring !== true && scope.metadataPlan === "pro") {
        return undefined;
      }
      if (data.status !== undefined && data.status !== "refunded" && data.status !== "partially_refunded") {
        return undefined;
      }
      if (data.status === "refunded") {
        if (
          typeof data.refunded_amount === "number" &&
          typeof data.net_amount === "number" &&
          data.net_amount > 0 &&
          data.refunded_amount === 0
        ) {
          return undefined;
        }
        return "free";
      }
      if (data.status === "partially_refunded") return null;
      const { refunded_amount: refunded, net_amount: net } = data;
      if (!isNonNegativeSafeInt(refunded) || !isNonNegativeSafeInt(net)) return undefined;
      return net > 0 && refunded >= net ? "free" : null;
    }
    default:
      return null;
  }
}

export async function polarWebhook(request: Request, env: Env): Promise<Response> {
  const badRequest = () => new Response("無效的 Polar 通知。", { status: 400 });
  const secret = env.POLAR_WEBHOOK_SECRET;
  if (!secret || !secret.trim()) return new Response("Polar 通知暫時無法使用。", { status: 503 });
  const id = request.headers.get("webhook-id");
  const timestamp = request.headers.get("webhook-timestamp");
  const signature = request.headers.get("webhook-signature");
  if (
    !id || !id.trim() || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id) ||
    !timestamp || !/^[1-9]\d{0,11}$/.test(timestamp) ||
    !signature || !signature.trim() || signature.length > 4096 || /[\u0000-\u001f\u007f]/.test(signature)
  ) return badRequest();
  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request, 1_048_576);
  } catch {
    return badRequest();
  }
  if (bytes === null) return new Response("Polar 通知超過大小上限。", { status: 413 });

  let body: string;
  let event: Record<string, unknown> | undefined;
  try {
    body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const headers = { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature };
    try {
      new Webhook(secret).verify(body, headers, { jsonParse: false });
    } catch {
      new Webhook(encoder.encode(secret), { format: "raw" }).verify(body, headers, { jsonParse: false });
    }
    event = fields(JSON.parse(body));
  } catch {
    return badRequest();
  }
  const type = exactEventType(event?.type);
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
              (? = 1 AND (
                event_type LIKE 'subscription.%'
                OR plan_after = 'pro'
                OR (
                  event_type = 'order.refunded'
                  AND CASE WHEN json_valid(payload_json) THEN (
                    (typeof(json_extract(payload_json, '$.data.subscription_id')) = 'text'
                      AND trim(json_extract(payload_json, '$.data.subscription_id')) != '')
                    OR COALESCE(json_type(payload_json, '$.data.product.is_recurring') = 'true', 0)
                  ) ELSE 0 END = 1
                )
              ))
              OR (? = 0 AND (
                plan_after = 'pro_pass'
                OR (
                  event_type = 'order.refunded'
                  AND CASE WHEN json_valid(payload_json) THEN (
                    (typeof(json_extract(payload_json, '$.data.subscription_id')) = 'text'
                      AND trim(json_extract(payload_json, '$.data.subscription_id')) != '')
                    OR COALESCE(json_type(payload_json, '$.data.product.is_recurring') = 'true', 0)
                  ) ELSE 0 END = 0
                )
              ))
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
