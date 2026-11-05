import PostalMime from "postal-mime";
import { verify as verifyAccess } from "./access.js";

// Max characters stored per body field (keep D1 rows well under the 1MB limit).
const MAX_BODY = 500 * 1024;

export default {
  // ---- Email handler: triggered by Cloudflare Email Routing ("Send to a Worker") ----
  async email(message, env, ctx) {
    try {
      const buf = new Uint8Array(await new Response(message.raw).arrayBuffer());
      const parsed = await PostalMime.parse(buf);

      const fromAddr = parsed.from?.address || message.from || "";
      const fromName = parsed.from?.name || "";
      const toAddr = parsed.to?.length
        ? parsed.to.map((t) => t.address).join(", ")
        : message.to || "";
      const subject = parsed.subject || "(无主题)";
      const date = parsed.date || message.headers.get("date") || null;
      const messageId = parsed.messageId || message.headers.get("message-id") || null;

      const bodyText = (parsed.text || "").slice(0, MAX_BODY);
      const bodyHtml = (parsed.html || "").slice(0, MAX_BODY);

      const attachments = (parsed.attachments || []).map((a) => ({
        name: a.filename || "attachment",
        type: a.mimeType || "application/octet-stream",
        size: a.size || 0,
      }));

      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO emails
             (message_id, from_addr, from_name, to_addr, subject, date,
              body_text, body_html, raw_size, attach_count, attach_meta, created_at)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)`
        )
          .bind(
            messageId,
            fromAddr,
            fromName,
            toAddr,
            subject,
            date,
            bodyText,
            bodyHtml,
            message.rawSize || buf.length,
            attachments.length,
            JSON.stringify(attachments),
            Date.now()
          )
          .run()
      );
    } catch (err) {
      // Receive-only: never forward or reject. On parse failure the message is
      // still accepted (best-effort) and simply not stored.
      console.error("email handler error:", err);
    }
  },

  // ---- Fetch handler: serves the frontend + JSON API ----
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    // Everything else is a static asset (index.html etc.) served by [assets].
    return env.ASSETS.fetch(request);
  },
};

async function handleApi(request, env, url) {
  const authed = await checkAccess(request, env);
  if (!authed) {
    return json({ error: "unauthorized" }, 401);
  }

  // List emails (newest first), paginated by created_at cursor.
  if (url.pathname === "/api/emails" && request.method === "GET") {
    const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10) || 50, 200);
    const before = url.searchParams.get("before");
    let result;
    if (before) {
      result = await env.DB.prepare(
        `SELECT id, message_id, from_addr, from_name, to_addr, subject, date, raw_size, attach_count, created_at
           FROM emails WHERE created_at < ?1
           ORDER BY created_at DESC LIMIT ?2`
      )
        .bind(parseInt(before, 10), limit)
        .all();
    } else {
      result = await env.DB.prepare(
        `SELECT id, message_id, from_addr, from_name, to_addr, subject, date, raw_size, attach_count, created_at
           FROM emails ORDER BY created_at DESC LIMIT ?1`
      )
        .bind(limit)
        .all();
    }
    return json(result.results || []);
  }

  // Single email detail.
  const detailMatch = url.pathname.match(/^\/api\/emails\/(\d+)$/);
  if (detailMatch && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT * FROM emails WHERE id = ?1`)
      .bind(detailMatch[1])
      .first();
    if (!row) return json({ error: "not found" }, 404);
    return json(row);
  }

  // Delete an email.
  if (detailMatch && request.method === "DELETE") {
    await env.DB.prepare(`DELETE FROM emails WHERE id = ?1`).bind(detailMatch[1]).run();
    return json({ ok: true });
  }

  return json({ error: "not found" }, 404);
}

async function checkAccess(request, env) {
  const authDomain = env.CF_ACCESS_AUTH_DOMAIN;
  const aud = env.CF_ACCESS_AUD;
  if (!authDomain || !aud) return false; // fail closed if Access not configured
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return false;
  try {
    await verifyAccess(token, authDomain, aud);
    return true;
  } catch (err) {
    console.error("access verify failed:", err);
    return false;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
