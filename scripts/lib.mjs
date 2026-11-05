// Shared Cloudflare helpers for the deploy / setup scripts.
// Works with either CLOUDFLARE_API_TOKEN or a `wrangler login` credentials file.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function getApiToken() {
  if (process.env.CLOUDFLARE_API_TOKEN) return process.env.CLOUDFLARE_API_TOKEN;
  const p = join(homedir(), ".cloudflare", "credentials.toml");
  if (existsSync(p)) {
    const m = readFileSync(p, "utf8").match(/token\s*=\s*"([^"]+)"/);
    if (m) return m[1];
  }
  throw new Error(
    "未找到 Cloudflare 凭据。请先 `wrangler login` 或设置环境变量 CLOUDFLARE_API_TOKEN。"
  );
}

export async function cfApi(method, path, token, body) {
  const res = await fetch("https://api.cloudflare.com/client/v4" + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
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

export async function getAuthDomain(token, accountId) {
  const s = await cfApi("GET", `/accounts/${accountId}/access/settings`, token);
  return s.auth_domain; // e.g. team.cloudflareaccess.com
}
