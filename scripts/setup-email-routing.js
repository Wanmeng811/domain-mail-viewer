#!/usr/bin/env node
// 单独创建 Email Routing 的 catch-all 规则（全自动部署脚本已内含此步骤）。
// 用法: node scripts/setup-email-routing.js <zone-domain> [worker-name]

import { getApiToken, cfApi, getZone } from "./lib.mjs";

const ZONE = process.argv[2];
const WORKER = process.argv[3] || "domain-mail-viewer";
if (!ZONE) {
  console.error("用法: node scripts/setup-email-routing.js <zone-domain> [worker-name]");
  process.exit(1);
}

const token = getApiToken();
const { zoneId } = await getZone(token, ZONE);

try {
  await cfApi("POST", `/zones/${zoneId}/email/routing/enable`, token, {
    name: ZONE,
    zone_id: zoneId,
  });
} catch (_) {}

await cfApi("POST", `/zones/${zoneId}/email/routing/rules`, token, {
  zone_id: zoneId,
  name: "catch-all → worker",
  enabled: true,
  priority: 0,
  actions: [{ type: "worker", value: [WORKER] }],
  matchers: [{ type: "all", value: ["catch_all"] }],
});

console.log(`✓ 所有发往 *@${ZONE} 的邮件 → Worker「${WORKER}」`);
