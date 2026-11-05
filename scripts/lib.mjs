// Shared Cloudflare helpers for the deploy / setup scripts.
// Supports two auth modes:
//   A) Global API Key:  CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL
//      (unrestricted, no token scope limits)
//   B) API Token:       CLOUDFLARE_API_TOKEN
// Works with either `wrangler login` credentials file too (token mode).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Returns auth headers object for cfApi.
export function getAuthHeaders() {
  if (process.env.CLOUDFLARE_API_KEY && process.env.CLOUDFLARE_EMAIL) {
    return {
      "X-Auth-Key": process.env.CLOUDFLARE_API_KEY,
      "X-Auth-Email": process.env.CLOUDFLARE_EMAIL,
    };
  }
  const token = getApiToken();
  return { Authorization: `Bearer ${token}` };
}

export function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const p = join(homedir(), ".cloudflare", "credentials.toml");
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/token\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error(
    "未找到 Cloudflare 凭据。请设置 CLOUDFLARE_API_KEY+CLOUDFLARE_EMAIL，或 CLOUDFLARE_API_TOKEN。"
  );
}

export async function cfApi(method, path, token, body) {
  const headers = getAuthHeaders();
  headers["Content-Type"] = "application/json";
  const res = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json();
  if (!data.success) {
    throw new Error(`CF API ${method} ${path} 失败: ${JSON.stringify(data.errors)}`);
  }
  return data.result;
}

// Returns { zoneId, accountId } for a managed domain.
export async function getZone(token, domain) {
  const list = await cfApi("GET", `/zones?name=${encodeURIComponent(domain)}`, token);
  const z = list.find((x) => x.name === domain);
  if (!z) throw new Error(`未找到域名 ${domain}（确认已托管在 Cloudflare）。`);
  return { zoneId: z.id, accountId: z.account.id };
}

// auth_domain lives under the Access organization, not /access/settings
// (which 404s on some accounts).
export async function getAuthDomain(token, accountId) {
  const orgs = await cfApi("GET", `/accounts/${accountId}/access/organizations`, token);
  return orgs.auth_domain; // e.g. team.cloudflareaccess.com
}
