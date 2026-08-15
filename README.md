<div align="center">

# dsh-auth-gate

**DSH 远程访问认证门禁 · Remote access authentication gate for DeepSeek Harness**

[English](#english) · [中文](#中文)

`dsh plugin --profile web add dsh-auth-gate`

</div>

<a name="中文"></a>

# dsh-auth-gate（中文）

DSH（DeepSeek Harness）远程访问认证门禁插件：解决"经 nginx 公网域名转发访问时，`/api/*` 全部 403"的问题 —— 认证通过后所有被浏览器信任护栏拦截的接口（含 `settings.*`、`credentials.*` 等 loopback 钉死的特权接口）全部可用；本机 `127.0.0.1` 访问不受影响；卸载插件一切还原，零残留、不污染用户配置。

同时是 [dsh-lan-access](https://github.com/Leon0555/dsh-lan-access) 的**完整替代品**（0.0.0.0 绑定 + `crypto.randomUUID` polyfill + 远程认证 + 本机原生目录选择，一个包全包）。

## 功能

| 功能 | 说明 |
|---|---|
| 🔐 远程认证门禁 | 配置密码后，除本机直连外的访问（公网域名 / 局域网 IP / 同机 nginx 反代）需密码登录（HttpOnly Cookie，默认 7 天有效） |
| 🔓 默认无密码 | 未配置密码时远程直接放行（等价纯 lan-access），配置密码即启用门禁，设置界面实时生效、无需重启 |
| 🗂 本机原生目录选择 | 本机添加工作区弹**官方原生**目录对话框（Windows IFileOpenDialog / macOS choose folder / Linux zenity-kdialog，跨平台）；远程自动降级官方应用内浏览器 |
| 🌐 替代 dsh-lan-access | webserver 0.0.0.0 绑定 + `crypto.randomUUID` polyfill（幂等注入），卸载 lan-access 后无需额外配置 |
| 🧹 零残留 | 所有副作用随 `ctx.effect` 清理回调还原；不修改 DSH 源码、不写入用户配置文件 |
| 🛡 安全细节 | sha256 + `timingSafeEqual` 密码比较、防开放重定向、Host 欺骗封死、认证后 `sec-fetch-site: cross-site` 不再误杀 |
| 📐 TypeScript | 源码 TS + 编译产物，外部 API 契约集中在 `src/types.ts`（DSH 是测试版，升级可快速定位 API 变化） |

## 安装

```sh
# 方式一：npm 发布后（推荐）
dsh plugin --profile web add dsh-auth-gate

# 方式二：GitHub 直装（lib/ 已提交，装上即用）
dsh plugin --profile web add github:bamboostrip/dsh-auth-gate

# 方式三：本地开发（link: 符号链接，改代码只需 build + 重启）
npm run build
dsh plugin --profile web add link:E:/ALLCODE/project/dsh-auth-gate
```

重启 DSH 生效。**默认无密码**：远程直接可访问。设置访问密码（二选一）：

```sh
# ① 推荐：DSH 设置界面 → 插件配置 → 访问认证 卡片
#    写入 ~/.dsh/.credentials.yaml；保存后实时生效，无需重启
# ② 环境变量（优先于文件层，适合脚本/CI）：
$env:DSH_GATE_PASSWORD='你的密码'   # PowerShell；重启 DSH 生效
```

> 密码来源优先级：`config.password` > 环境变量 `DSH_GATE_PASSWORD` > `~/.dsh/.credentials.yaml` > `.env`。

## 使用

- **默认无密码**：远程（公网域名 / 局域网 IP）直接访问。
- **设置密码后**：本机 `http://127.0.0.1:3080` 免密；远程首次访问 302 到登录页，登录后 7 天内免登录（有效期可配）。
- nginx 与 DSH 同机时（remote 恒为 127.0.0.1 但 Host 是域名）同样需要密码 —— 公网流量无法绕过认证。
- 登录态在内存：DSH 进程重启后需重新登录。

## 公网 nginx 参考配置

```nginx
server {
    listen 443 ssl;
    server_name codsh.famlife.top;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://10.144.144.7:3080;   # 家里 DSH
        proxy_http_version 1.1;                # ★ 必须（默认 1.0 会断 WS）
        proxy_set_header Host $host;           # 域名原样转发
        proxy_set_header Upgrade $http_upgrade;        # ★ WS 必需
        proxy_set_header Connection "upgrade";         # ★ WS 必需
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

公网 403 排查清单见 [NOTES.md](NOTES.md)。

## 可选配置（profiles/web/cordis.patch.yml 覆盖 auth-gate 行）

```yaml
- id: auth-gate
  config:
    # password: 'xxx'                        # 可选：行配置密码（最高优先）
    trustedRemotePrefixes: ['10.144.144.0/24']   # 内网网段免密（IPv4 CIDR）
    tokenTtlMs: 604800000                  # 登录有效期，默认 7 天
```

## 卸载（零残留）

```sh
dsh plugin --profile web remove dsh-auth-gate
```

卸载后：包与 bundle patch 一起移除（webserver 绑定还原 DSH 默认、polyfill 停止注入），`server.emit` 拦截器、原生选择器路由、客户端智能 flow 与设置卡片全部随 `ctx.effect` 清理回调还原，登录态随进程退出消失。完整审计见 [NOTES.md](NOTES.md#10-零残留审计卸载后逐项确认)。

## 安全提示

- 默认无密码时，远程访问等价于本机操作权限（DSH 本身是远程执行工具）—— 公网暴露前请务必配置强密码，并建议 nginx 层加 IP 白名单 / Basic Auth 双保险。
- 请配合 nginx HTTPS 使用，防止密码与 Cookie 明文传输。
- 登录接口无失败次数限制（已知边界，见 NOTES §5）。

## 开发

```sh
npm install            # 首次：typescript / @types/node
npm run typecheck      # 类型检查
npm run build          # 编译 src/ → lib/
npm run check:package  # 包组合验证（防安装后启动失败）
npm run test:e2e       # 真机级 E2E（50 项断言，使用本机真实 DSH 模块）
```

- 结构：`src/`（TypeScript 源码）+ `lib/`（tsc 产物，随包提交保证装上即用）+ `src/client.js`（浏览器半边：智能目录选择 flow + 访问认证设置卡片）
- 对 DSH 外部 API 的依赖形状集中在 `src/types.ts`（每处附源码出处）—— DSH 升级后改这一处，编译器标出所有受影响调用点
- 完整技术方案与验证记录见 [NOTES.md](NOTES.md)

## License

[MIT](LICENSE)

---

<a name="english"></a>

# dsh-auth-gate (English)

An access authentication gate for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web. It fixes the "everything on `/api/*` returns 403 behind a public nginx domain" problem: after password authentication, every endpoint blocked by the browser-trust fence — including the loopback-pinned privileged methods (`settings.*`, `credentials.*`, `host.openPath`, `host.pickDirectory`, `llm.discoverModels`, `agentPreset.*`) — becomes fully usable. Local `127.0.0.1` access is untouched, and uninstalling restores everything with zero residue.

It is also a full replacement for [dsh-lan-access](https://github.com/Leon0555/dsh-lan-access): `0.0.0.0` binding, `crypto.randomUUID` polyfill, remote authentication, and a native folder picker for local workspace selection — one package covers it all.

## Features

| Feature | Description |
|---|---|
| 🔐 Remote authentication gate | With a password configured, every access other than local direct connections (public domain / LAN IP / same-host nginx reverse proxy) requires a password login (HttpOnly cookie, 7-day validity by default) |
| 🔓 Passwordless by default | No password configured → remote clients connect freely (equivalent to plain lan-access); configure a password to enable the gate — takes effect live from the settings page, no restart |
| 🗂 Native folder picker for local users | Adding a workspace from the local machine opens the **official native** directory dialog (Windows IFileOpenDialog / macOS choose folder / Linux zenity-kdialog, cross-platform); remote clients automatically fall back to the official in-app browser |
| 🌐 Replaces dsh-lan-access | webserver `0.0.0.0` binding + `crypto.randomUUID` polyfill (idempotent injection); no extra configuration after removing lan-access |
| 🧹 Zero residue | Every side effect is reverted via `ctx.effect` cleanup callbacks; never modifies DSH source or user config files |
| 🛡 Security details | sha256 + `timingSafeEqual` password comparison, open-redirect protection, Host-spoofing blocked, no more `sec-fetch-site: cross-site` false positives after authentication |
| 📐 TypeScript | TS source + compiled output; the external API contract is centralized in `src/types.ts` (DSH is a developer preview — upgrade breakage is easy to locate) |

## Install

```sh
# Option 1: from npm (recommended after publishing)
dsh plugin --profile web add dsh-auth-gate

# Option 2: straight from GitHub (lib/ is committed, works out of the box)
dsh plugin --profile web add github:bamboostrip/dsh-auth-gate

# Option 3: local development (link: symlink; rebuild + restart DSH after changes)
npm run build
dsh plugin --profile web add link:E:/ALLCODE/project/dsh-auth-gate
```

Restart DSH to activate. **No password by default** — remote clients connect directly. To set an access password:

```sh
# ① Recommended: DSH Settings → Plugin configuration → "Access authentication" card
#    Stored in ~/.dsh/.credentials.yaml; takes effect immediately, no restart
# ② Environment variable (takes precedence over the file layer; handy for scripts/CI):
export DSH_GATE_PASSWORD='your-password'
```

> Password resolution order: `config.password` > env `DSH_GATE_PASSWORD` > `~/.dsh/.credentials.yaml` > `.env`.

## Usage

- **Passwordless by default**: remote access (public domain / LAN IP) works directly.
- **With a password**: local `http://127.0.0.1:3080` stays password-free; remote first visit is 302-redirected to the login page; logged-in sessions skip login for 7 days (configurable).
- When nginx runs on the same host as DSH (remote is always 127.0.0.1 but Host is a domain), a password is still required — public traffic cannot bypass authentication.
- Login state lives in memory: a DSH restart requires re-login.

## Public nginx reference

```nginx
server {
    listen 443 ssl;
    server_name codsh.famlife.top;
    # ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://10.144.144.7:3080;   # your DSH host
        proxy_http_version 1.1;                # ★ required (1.0 breaks WebSocket)
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;        # ★ WebSocket
        proxy_set_header Connection "upgrade";         # ★ WebSocket
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;
        proxy_buffering off;
    }
}
```

A public-403 troubleshooting checklist is in [NOTES.md](NOTES.md).

## Optional configuration (override the auth-gate row in profiles/web/cordis.patch.yml)

```yaml
- id: auth-gate
  config:
    # password: 'xxx'                        # optional: row-level password (highest priority)
    trustedRemotePrefixes: ['10.144.144.0/24']   # password-free LAN CIDRs (IPv4)
    tokenTtlMs: 604800000                  # login TTL, default 7 days
```

## Uninstall (zero residue)

```sh
dsh plugin --profile web remove dsh-auth-gate
```

The package and its bundle patch disappear together (webserver binding returns to DSH defaults, polyfill stops), and the `server.emit` interceptor, native picker route, client smart flow, and settings card are all reverted by `ctx.effect` cleanup. Full audit: [NOTES.md](NOTES.md).

## Security notes

- Without a password, remote access equals local machine privileges (DSH is a remote-execution tool) — configure a strong password before exposing it publicly, and consider an IP allowlist / Basic Auth at the nginx layer.
- Use nginx HTTPS to keep the password and cookie off the wire.
- The login endpoint has no rate limiting yet (known limitation, see NOTES §5).

## Development

```sh
npm install            # first time: typescript / @types/node
npm run typecheck      # type checking
npm run build          # compile src/ → lib/
npm run check:package  # package composition check (prevents boot failures)
npm run test:e2e       # machine-level E2E (50 assertions against the real DSH modules)
```

- Layout: `src/` (TypeScript source) + `lib/` (tsc output, committed so installs work out of the box) + `src/client.js` (browser half: smart directory flow + access-authentication settings card)
- The external DSH API contract lives in `src/types.ts` (each declaration annotated with its source location) — when DSH upgrades, change that one file and the compiler flags every affected call site
- Full technical notes and verification records: [NOTES.md](NOTES.md)

## License

[MIT](LICENSE)
