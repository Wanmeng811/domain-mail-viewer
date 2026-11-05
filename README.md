# 域名邮件查看器 (Domain Mail Viewer)

一个跑在 **Cloudflare** 上的「只收不能发」网站：你域名下**任意邮箱地址**收到的邮件，
都会被捕获、存入 D1 数据库，并在一个漂亮的网页里集中查看。

- ✉️ **捕获全部地址** — 用 Email Routing 的 catch-all 规则把所有邮件「Send to a Worker」
- 📥 **只收不发** — Worker 不转发、不回复、不拒绝，邮件即被接受（receive-only）
- 🔐 **登录保护** — Cloudflare Access（Google / GitHub 等一键登录）
- 🗄️ **存储** — D1 (SQLite)，附件只存元数据（文件名/类型/大小），不存内容
- 🎨 **界面** — 原生 HTML/CSS/JS 单页，左侧列表 + 右侧阅读窗，支持明暗主题、搜索、XSS 防护
- 🤖 **全自动部署** — 一条命令在 Cloudflare 上自动建好 D1 / Access / Worker / 自定义域 / 邮件路由

---

## 一键部署（推荐）

本项目**不走** Cloudflare 的 "Deploy" 按钮——那个按钮只会建 Worker + 前端，建不了本 App 必需的 **D1 数据库 / Access 登录应用 / Email Routing catch-all**（这些依赖它无法自动创建，点了也跑不起来）。

真正的一键就是本地这一行命令，它会用 Cloudflare API 把上面三样 + Worker + 前端**全自动建好**：

```bash
cd domain-mail-viewer
npm install
wrangler login                       # 或用环境变量 CLOUDFLARE_API_TOKEN
node scripts/deploy.js --domain example.com        # 站点将出现在 mail.example.com
# 想用别的子域： node scripts/deploy.js --domain example.com --subdomain inbox
```

`deploy.js` 会用你的域名**自动完成**以下全部步骤（无需在 CF 后台手动点）：

1. 解析 zone / account
2. 创建（或复用）D1 数据库 `domain-mail-viewer` 并执行迁移
3. 创建（或复用）Cloudflare Access 自托管应用，保护 `mail.example.com`
4. 把 Access 的 AUD 作为 Worker secret `CF_ACCESS_AUD` 写入
5. 给 Worker 绑定自定义域 `mail.example.com`
6. 启用 Email Routing 并创建 catch-all 规则 → 所有 `*@example.com` 邮件送进该 Worker
7. `wrangler deploy`（自动把域名等注入 `wrangler.toml` 的 `${...}` 占位符）

完成后访问 `https://mail.example.com`，登录后给任意地址（如 `hi@example.com`）发邮件即可看到。

> 需要的 API 权限：`wrangler login` 的默认 token 已包含 Workers / D1 / Access / Email Routing 等。
> 若用 `CLOUDFLARE_API_TOKEN`，请确保它具备对应资源编辑权限。

---

## 手动分步部署（可选）

如果你更想在 CF 控制台逐项操作，原来的人工步骤见下；占位符说明见文末清单。

1. `wrangler d1 create domain-mail-viewer` → 把 `database_id` 填进 `wrangler.toml`
2. `wrangler d1 execute domain-mail-viewer --remote --file=./migrations/0001_init.sql`
3. 在 Zero Trust → **Access → Applications** 新建 Self-hosted 应用，域名 `mail.example.com`，记下 AUD
4. `wrangler secret put CF_ACCESS_AUD`；在 `wrangler.toml` 的 `[vars]` 填 `CF_ACCESS_AUTH_DOMAIN` / `APP_DOMAIN`
5. `wrangler deploy`，并给 Worker 绑定自定义域 `mail.example.com`
6. `node scripts/setup-email-routing.js example.com` 创建 catch-all 邮件路由

---

## 配置说明

`wrangler.toml` 中所有域名/ID 都用 `${...}` 占位符，由 `deploy.js` 在部署时注入，
**仓库里无需硬编码任何域名**，可直接提交到 GitHub。

| 占位符 | 注入来源（全自动部署时） |
|--------|--------------------------|
| `D1_DATABASE_ID` | 新建/复用的 D1 数据库 ID |
| `CF_ACCESS_AUTH_DOMAIN` | 你的 Access 团队域名 |
| `APP_DOMAIN` | 站点自定义域名 |

---

## 安全说明
- Worker 内对 Cloudflare Access JWT 做 RS256 校验（JWKS 缓存 1 小时），失败即 401，纵深防御。
- 邮件 HTML 正文经 DOMPurify 净化后放入 `sandbox="allow-same-origin"` 的 iframe，杜绝 XSS。
- 本项目**没有任何发送邮件的代码路径**，从根上保证「只收不能发」。

## 文件结构
```
domain-mail-viewer/
├─ wrangler.toml               # 通用占位符配置（无硬编码域名）
├─ package.json                # npm run deploy → 全自动部署
├─ src/
│  ├─ worker.js                # email() 入库 + fetch() 前端/API
│  └─ access.js                # Cloudflare Access JWT 校验
├─ migrations/0001_init.sql    # D1 表结构
├─ public/{index.html,styles.css,app.js}
└─ scripts/
   ├─ deploy.js                # 一键全自动部署
   ├─ setup-email-routing.js   # 单独创建 catch-all 邮件路由
   └─ lib.mjs                  # 共用 Cloudflare API 封装
```
