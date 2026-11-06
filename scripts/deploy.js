#!/usr/bin/env node
// 全自动部署：一条命令搞定 D1 + Cloudflare Access + Worker + 入口路由 + 邮件 catch-all 路由。
//
// 用法:
//   node scripts/deploy.js --domain example.com [--subdomain mail]
//   （--subdomain 留空则用裸域名，即 --subdomain "" → example.com）
//
// 前置:
//   - 域名 example.com 已托管在 Cloudflare
//   - 已 `wrangler login` 或设置环境变量 CLOUDFLARE_API_TOKEN（需权限：
//     Workers 编辑、D1、Access、Email Routing、DNS 记录、Workers 路由）
//
// 它做了什么:
//   1. 找到 zone / account
//   2. 创建（或复用）D1 数据库并跑迁移
//   3. 创建（或复用）Cloudflare Access 自托管应用，保护 mail.example.com
//   4. 把 Access AUD 作为 Worker secret 写入
//   5. 给入口主机名建一条「橙色云（proxied）」A 记录，保证 Cloudflare 边缘接管
//      （Access 才能先于 Worker 运行）；再用 Worker Route 把该主机名指向 Worker
//   6. 启用 Email Routing 并创建 catch-all 规则 → 把邮件送进该 Worker
//   7. wrangler deploy（用注入的 env 替换 wrangler.toml 里的 ${...}）
//
// 为什么用 Worker Route 而不是 Workers 自定义域？
//   Workers 自定义域（workers/domains）是一个独立入口，Cloudflare Access 应用
//   不会覆盖它，导致 /api/* 直接被 Worker 拦下（401）而页面却不要求登录。
//   Worker Route 跑在「橙色云代理」的主机名上，Access 在边缘先完成登录、注入
//   Cf-Access-Jwt-Assertion，再交给 Worker —— 登录保护才能生效。

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { getApiToken, cfApi, getZone, getAuthDomain } from "./lib.mjs";

const exec = promisify(execFile);
const IS_WIN = process.platform === "win32";

// 跨平台跑 `npx <args>`。pipeInput 作为 stdin 喂给子进程（用于 wrangler secret put）。
async function run(args, env, pipeInput) {
  const cmd = IS_WIN ? "cmd" : "npx";
  const cmdArgs = IS_WIN ? ["/c", "npx", ...args] : args;
  console.log(`\n$ npx ${args.join(" ")}`);
  const execOpts = {
    env: { ...process.env, ...(env || {}) },
    maxBuffer: 1024 * 1024 * 64,
  };
  if (pipeInput) execOpts.input = pipeInput;
  const { stdout, stderr } = await exec(cmd, cmdArgs, execOpts);
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  return stdout;
}

function parseArgs(argv) {
  const a = { domain: null, subdomain: "mail" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--domain") a.domain = argv[++i];
    else if (argv[i] === "--subdomain") a.subdomain = argv[++i];
  }
  return a;
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

// 给入口主机名建一条「橙色云（proxied）」A 记录。Cloudflare Access 只覆盖走
// Cloudflare 边缘代理（橙色云）的主机名；没有 proxied A 记录时，自定义域/路由都
// 不会触发 Access 登录，导致 /api/* 直接被 Worker 拦下（401）。
async function ensureProxiedRecord(token, zoneId, hostname) {
  const recs = await cfApi("GET", `/zones/${zoneId}/dns_records?name=${hostname}`, token);
  if (recs.some((r) => r.type === "A" && r.proxied)) return;
  await cfApi("POST", `/zones/${zoneId}/dns_records`, token, {
    type: "A",
    name: hostname,
    content: "192.0.2.1", // 占位；橙色云下真实源站由 Cloudflare 托管，不会真正访问此 IP
    proxied: true,
    ttl: 1,
  });
}

// 用 Worker Route（而非 Workers 自定义域）把入口主机名指向 Worker。
// Workers 自定义域是独立入口，Access 应用不会覆盖它 → /api/* 直接被 Worker 拦（401）。
async function ensureWorkerRoute(token, zoneId, hostname) {
  const routes = await cfApi("GET", `/zones/${zoneId}/workers/routes`, token);
  if (routes.some((r) => r.pattern === `${hostname}/*` && r.script_name === "domain-mail-viewer")) {
    return;
  }
  // 清掉同 pattern 但未绑定 Worker 的孤儿 route（script_name 为 null）
  for (const r of routes.filter((r) => r.pattern === `${hostname}/*` && !r.script_name)) {
    try { await cfApi("DELETE", `/zones/${zoneId}/workers/routes/${r.id}`, token); } catch (_) {}
  }
  await cfApi("POST", `/zones/${zoneId}/workers/routes`, token, {
    pattern: `${hostname}/*`,
    script_name: "domain-mail-viewer",
  });
}

async function ensureEmailCatchAll(token, zoneId, zoneName, worker) {
  // 启用 Email Routing（若未启用）
  try {
    await cfApi("POST", `/zones/${zoneId}/email/routing/enable`, token, {
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

  // Auth is handled by lib.mjs getAuthHeaders() (global key+email OR token),
  // read from env. `token` is only kept for API calls that still thread it.
  const token = process.env.CLOUDFLARE_API_TOKEN || null;
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

  // 4) Worker secret 通过 wrangler 写入（CF API 不再支持 PUT secret，
  //    只有 GET/DELETE；必须用 wrangler secret put）。
  console.log("• 写入 Worker secret CF_ACCESS_AUD…");
  await run(["wrangler", "secret", "put", "CF_ACCESS_AUD"], {
    CLOUDFLARE_ACCOUNT_ID: accountId,
    CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
    CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
  }, aud);

  // 5) 入口主机名：先建橙色云（proxied）A 记录，再挂 Worker Route
  //    （确保 Access 在边缘先完成登录，再交 Worker 处理，登录保护才生效）
  await ensureProxiedRecord(token, zoneId, appDomain);
  await ensureWorkerRoute(token, zoneId, appDomain);
  console.log(`✓ Worker 入口 ${appDomain} 已就绪（proxied 记录 + Worker Route）`);

  // 6) Email Routing catch-all
  await ensureEmailCatchAll(token, zoneId, args.domain, "domain-mail-viewer");
  console.log(`✓ catch-all 邮件路由已创建（所有 *@${args.domain} → Worker）`);

  // 7) wrangler deploy
  //    Wrangler does NOT substitute ${...} placeholders in wrangler.toml, so we
  //    generate a concrete deploy config with real values and point wrangler at it.
  console.log("\n• 部署 Worker + 前端…");
  const deployCfg = `${ROOT}/wrangler.deploy.toml`;
  writeFileSync(
    deployCfg,
    `# auto-generated by deploy.js — do not edit\n` +
    `name = "domain-mail-viewer"\n` +
    `main = "src/worker.js"\n` +
    `compatibility_date = "2025-08-01"\n` +
    `compatibility_flags = ["nodejs_compat"]\n\n` +
    `[[d1_databases]]\n` +
    `binding = "DB"\n` +
    `database_name = "domain-mail-viewer"\n` +
    `database_id = "${databaseId}"\n\n` +
    `[assets]\n` +
    `directory = "public"\n` +
    `not_found_handling = "single-page-application"\n\n` +
    `[vars]\n` +
    `CF_ACCESS_AUTH_DOMAIN = "https://${authDomain}"\n` +
    `APP_DOMAIN = "${appDomain}"\n`
  );
  await run(["wrangler", "deploy", "--config", "wrangler.deploy.toml"], {
    CLOUDFLARE_API_KEY: process.env.CLOUDFLARE_API_KEY,
    CLOUDFLARE_EMAIL: process.env.CLOUDFLARE_EMAIL,
    CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID: accountId,
  });

  console.log(
    `\n🎉 完成！访问 https://${appDomain} 登录后，给任意地址（如 hi@${args.domain}）发邮件即可看到。`
  );
}

main().catch((e) => {
  console.error("\n部署失败：", e.message || e);
  process.exit(1);
});
