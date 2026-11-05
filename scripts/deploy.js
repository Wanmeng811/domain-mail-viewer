#!/usr/bin/env node
// 全自动部署：一条命令搞定 D1 + Cloudflare Access + Worker + 自定义域 + 邮件 catch-all 路由。
//
// 用法:
//   node scripts/deploy.js --domain example.com [--subdomain mail]
//
// 前置:
//   - 域名 example.com 已托管在 Cloudflare
//   - 已 `wrangler login` 或设置环境变量 CLOUDFLARE_API_TOKEN（需权限：
//     Workers 编辑、D1、Access、Email Routing、Workers 自定义域）
//
// 它做了什么:
//   1. 找到 zone / account
//   2. 创建（或复用）D1 数据库并跑迁移
//   3. 创建（或复用）Cloudflare Access 自托管应用，保护 mail.example.com
//   4. 把 Access AUD 作为 Worker secret 写入
//   5. 给 Worker 绑定自定义域 mail.example.com
//   6. 启用 Email Routing 并创建 catch-all 规则 → 把邮件送进该 Worker
//   7. wrangler deploy（用注入的 env 替换 wrangler.toml 里的 ${...}）

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { getApiToken, cfApi, getZone, getAuthDomain } from "./lib.mjs";

const exec = promisify(execFile);

function parseArgs(argv) {
  const a = { domain: null, subdomain: "mail" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain") a.domain = argv[++i];
    else if (argv[i] === "--subdomain") a.subdomain = argv[++i];
  }
  return a;
}

async function run(cmd, args, env) {
  console.log(`\n$ ${cmd} ${args.join(" ")}`);
  const { stdout, stderr } = await exec(cmd, args, {
    env: { ...process.env, ...(env || {}) },
    maxBuffer: 1024 * 1024 * 64,
  });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

async function getExistingD1(token, accountId) {
  const list = await cfApi("GET", `/accounts/${accountId}/d1/database?name=domain-mail-viewer`, token);
  return list.find((d) => d.name === "domain-mail-viewer") || null;
}

async function ensureAccessApp(token, accountId, appDomain) {
  const apps = await cfApi("GET", `/accounts/${accountId}/access/apps?app_type=self_hosted`, token);
  const existing = apps.find((a) => a.domain === appDomain);
  if (existing) return existing;
  const created = await cfApi(
    "POST",
    `/accounts/${accountId}/access/apps`,
    token,
    {
      name: "Domain Mail Viewer",
      type: "self_hosted",
      domain: appDomain,
      session_duration: "24h",
      auto_redirect_to_identity: false,
      policies: [
        {
          name: "Allow authenticated users",
          decision: "allow",
          include: [{ everyone: {} }],
        },
      ],
    }
  );
  return created;
}

async function setSecret(token, accountId, name, value) {
  await cfApi(
    "PUT",
    `/accounts/${accountId}/workers/scripts/domain-mail-viewer/secrets/${name}`,
    token,
    { text: value, type: "secret_text" }
  );
}

async function ensureCustomDomain(token, accountId, zoneId, zoneName, hostname) {
  const existing = await cfApi("GET", `/accounts/${accountId}/workers/domains`, token);
  if (existing.some((d) => d.hostname === hostname)) return;
  await cfApi("POST", `/accounts/${accountId}/workers/domains`, token, {
    hostname,
    service: "domain-mail-viewer",
    environment: "production",
    zone_id: zoneId,
    zone_name: zoneName,
  });
}

async function ensureEmailCatchAll(token, zoneId, zoneName, worker) {
  // 启用 Email Routing（若未启用）
  try {
    await cfApi("POST", `/zones/${zoneId}/email/routing/enable`, token, {
      name: zoneName,
      zone_id: zoneId,
    });
  } catch (_) { /* 已启用 */ }

  const rules = await cfApi("GET", `/zones/${zoneId}/email/routing/rules`, token);
  if (rules.some((r) => r.actions?.some((a) => a.type === "worker" && a.value?.includes(worker)))) {
    return;
  }
  await cfApi("POST", `/zones/${zoneId}/email/routing/rules`, token, {
    zone_id: zoneId,
    name: "catch-all → worker",
    enabled: true,
    priority: 0,
    actions: [{ type: "worker", value: [worker] }],
    matchers: [{ type: "all", value: ["catch_all"] }],
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.domain) {
    console.error("用法: node scripts/deploy.js --domain example.com [--subdomain mail]");
    process.exit(1);
  }
  const ROOT = process.cwd();
  const appDomain = `${args.subdomain}.${args.domain}`;

  const token = getApiToken();
  const { zoneId, accountId } = await getZone(token, args.domain);
  const authDomain = await getAuthDomain(token, accountId); // team.cloudflareaccess.com
  console.log(`✓ 域名 ${args.domain}  (zone=${zoneId}, account=${accountId})`);

  // 1) D1
  let db = await getExistingD1(token, accountId);
  if (!db) {
    console.log("• 创建 D1 数据库…");
    db = await cfApi("POST", `/accounts/${accountId}/d1/database`, token, {
      name: "domain-mail-viewer",
    });
  }
  const databaseId = db.uuid || db.id;
  console.log(`✓ D1 database_id=${databaseId}`);

  // 2) 跑迁移（本地 SQL 文件）
  const sql = readFileSync(`${ROOT}/migrations/0001_init.sql`, "utf8");
  const lines = sql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of lines) {
    await cfApi(
      "POST",
      `/accounts/${accountId}/d1/database/${databaseId}/query`,
      token,
      { sql: stmt }
    );
  }
  console.log("✓ D1 迁移已执行");

  // 3) Access 应用
  const app = await ensureAccessApp(token, accountId, appDomain);
  const aud = app.aud;
  console.log(`✓ Access 应用已就绪 (AUD=${aud}, 保护 ${appDomain})`);

  // 4) 写 secret
  await setSecret(token, accountId, "CF_ACCESS_AUD", aud);
  console.log("✓ Worker secret CF_ACCESS_AUD 已写入");

  // 5) Worker 自定义域
  await ensureCustomDomain(token, accountId, zoneId, args.domain, appDomain);
  console.log(`✓ Worker 自定义域 ${appDomain} 已绑定`);

  // 6) Email Routing catch-all
  await ensureEmailCatchAll(token, zoneId, args.domain, "domain-mail-viewer");
  console.log(`✓ catch-all 邮件路由已创建（所有 *@${args.domain} → Worker）`);

  // 7) wrangler deploy（注入 wrangler.toml 里的 ${...}）
  console.log("\n• 部署 Worker + 前端…");
  await run("npx", ["wrangler", "deploy"], {
    D1_DATABASE_ID: databaseId,
    CF_ACCESS_AUTH_DOMAIN: `https://${authDomain}`,
    APP_DOMAIN: appDomain,
    CLOUDFLARE_API_TOKEN: token,
  });

  console.log(
    `\n🎉 完成！访问 https://${appDomain} 登录后，给任意地址（如 hi@${args.domain}）发邮件即可看到。`
  );
}

main().catch((e) => {
  console.error("\n部署失败：", e.message || e);
  process.exit(1);
});
