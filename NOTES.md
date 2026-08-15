# dsh-auth-gate — 交接文档（新会话必读）

> 本文档记录完整前因后果、源码证据、技术方案与验证清单。
> **实现状态：已完成。** 核心机制已通过真机级 E2E 验证（见 §6.1），
> 待办只剩"真实 nginx + 公网域名"的部署日验收（§6.2）。

## 1. 背景与目标

用户家中有多台内网机器跑 DSH Web GUI（端口 3080），用 nginx 做公网域名
反向代理：

- `homedsh.famlife.top` → `10.144.144.3:3080`
- `codsh.famlife.top` → `10.144.144.7:3080`

现象：页面能打开（静态资源 OK），但所有 `/api/*` 的 POST 请求返回
`403 Forbidden`（如 `host.describe`、`dynamicCordisRunner/syncInspectManifest`），
WebSocket 事件流也连不上，GUI 完全无法使用。

已确认：**不是 nginx 的问题**（nginx 转发配置正确），是 DSH 后端的
**浏览器信任护栏**在拦。

目标：开发一个 DSH 插件——

1. 让被 403 拦截的接口（含 loopback 钉死的特权接口）在**密码认证后**全部开放；
2. 非 `127.0.0.1` 来源必须输密码，本机访问不受影响；
3. 卸载插件一切还原、不污染用户配置（用户核心诉求）。

## 2. 根因（源码证据，DSH 0.1.0-rc.6）

所有路径基于本机安装：

```
C:\Users\Bambo\AppData\Roaming\fnm\node-versions\v24.18.0\installation\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\
```

### 2.1 护栏判定 — `dsh-client-connection/lib/index.js`

- `isTrustedApiRequest(request, trustedHosts)`（L184-198）：
  - Host 必须 loopback 或命中 `trustedHosts`；否则 **false → 403**；
  - `sec-fetch-site: cross-site` 一律拒；
  - 带 `Origin` 时必须与 Host 完全一致。
- `/api` 前缀路由 handler（L550-561）：每个请求先过护栏，不过 → `403 "forbidden"`。
  这就是 `host.describe` 403 的来源（`trustedHosts` 默认 `[]`，域名不在内）。
- 特权方法（L504-520 `PRIVILEGED_METHODS`，L538 用**空白名单**重新过护栏，
  等于钉死 loopback）：
  `agentPreset.read/copy/openDocument/remove`、`host.pickDirectory`、
  `host.openPath`、`settings.describe/openDocument/update/replace/mutate`、
  `credentials.describe/set/unset`、`llm.discoverModels`。
  → 这就是"设置页、API 密钥配置公网下 403"的来源。
- WebSocket downlinks（`/api/events.mux`、`/api/events.host`，L566-584）：
  upgrade 前同样过护栏（L570）→ 公网下握手被拒（403）。

### 2.2 放行可行性（已核实）

- 护栏读的是 `req.headers`（`header()` L121-125 直接取 `headers[name]`）；
- `/api` 路由的 `bridge()`（L38-87）构造 `new Request()` 时也是
  `Object.fromEntries(Object.entries(req.headers))`（L67）拷贝；
  → **在请求到达 DSH 路由之前改写 `req.headers.host` 并删除
  `req.headers.origin`，护栏即放行**，特权接口也随之放开。
- `isLoopbackHostname`（L100-104）：`127.0.0.1` / `localhost` / `[::1]` / 127/8 全段。
  改写 `host = "127.0.0.1"` 即可命中。
- `Origin` 删除后 `origin === void 0 → return true`（同源请求的
  `sec-fetch-site` 为 `same-origin`，不拦；`cross-site` 被拦是预期的安全行为）。

### 2.3 webserver 结构 — `dsh-host-webserver/lib/index.js`

- node:http `createServer(handler)`，handler 注册在 `server` 的 `'request'`
  事件上（L121）；upgrade 处理注册在 `'upgrade'` 事件（L132）。
- **node 的 EventEmitter 会依次调用同事件的所有 listener**，所以不能简单地
  prepend 一个 listener 后"替它响应"（原 handler 还会跑，对已 end 的 res 再
  写会抛 ERR_HTTP_HEADERS_SENT）。
- 因此采用**覆盖 `server.emit`** 的拦截方案（见下），可同步决定"已接管"
  （return true，原 listener 链不执行）还是"放行"（改写头后调原 emit）。

### 2.4 配置入口 — `dsh-web-app/cordis.patch.yml`

- `connection` 行（id: `connection`）配置 `trustedHosts` 来自
  `ctx.webRuntime.trustedHosts`（= CLI `--trusted-host` 或 LAN IP 推导）。
- 本插件**不动**这一行 —— 通过 HTTP 层头改写统一绕过，省去部署域名配置。

## 3. 方案（当前骨架已按此实现）

```
浏览器 ──HTTPS──> nginx ──> DSH(node:http, :3080)
                              │
                              ├─ server.emit 拦截（本插件）
                              │   ├─ remote == loopback        → 原样放行
                              │   ├─ 命中免密网段（可选）       → 改写头放行
                              │   ├─ cookie 有效               → 改写头放行
                              │   ├─ 未认证                    → 302 登录页（或 WS 403）
                              │   └─ 登录 POST                 → 校验密码 → 种 cookie → 302 回原页
                              │
                              └─ DSH 原有路由（护栏已因改写头而放行）
```

- 放行 = `req.headers.host = "127.0.0.1"; delete req.headers.origin;`
- 登录态：内存 Map（token → 过期时间），HttpOnly + SameSite=Lax Cookie，
  默认 7 天；进程重启重新登录（可接受，注释已说明）。
- 密码：`config.password` 或 `DSH_GATE_PASSWORD` 环境变量；两者皆无 → 拒绝启动。
- 登录页：内嵌 HTML 表单（`/-/auth/login`），登录后 302 回 `next`（防开放
  重定向：只允许 `/` 开头的相对路径）。
- WebSocket 握手走同一门禁；认证失败直接 socket 403。

## 4. 零残留设计

- 代码行与 bundle patch 都在包内（`cordis.patch.yml` 随 `dsh plugin add`
  进入 `profiles/web/node_modules`，卸载时整包移除，patch 不再应用）——
  与官方插件 `dsh-lan-access` 完全相同的机制；
- `server.emit` 的还原放在 `ctx.effect` 清理回调里（插件停用/卸载时执行）；
- 插件不写任何用户配置文件、不改 DSH 源码；
- 唯一进程内残留是登录 token Map（进程退出即消失）。

## 4.1 TypeScript 化（v0.2.0）

**为什么运行时还是 JS**：DSH 的插件 loader 用原生 `import()` 加载插件文件
（`cordis-plugin-loader/lib/index.js` L260-269），没有内置 TS 编译 ——
`__rewriteRelativeImportExtension`（L137-142）只是把源码里的 `.ts` 相对导入
改写为 `.js`，面向"源码写 TS、磁盘上是编译后 JS"的构建产物模式。所以：

- **源码**：`src/index.ts`（业务逻辑）+ `src/types.ts`（外部契约）；
- **产物**：`npm run build`（tsc）→ `lib/index.js` + `lib/index.d.ts`，
  loader 加载的是 `lib/index.js`；`lib/` 随包发布且保留在工作区，
  保证 `dsh plugin add file:` 装上即用；
- **开发**：改 `src/` → `npm run typecheck` → `npm run build` → 重启 DSH。

**类型契约与 DSH 升级核对**（针对"DSH 是测试版、API 会变"）：

- `src/types.ts` 集中声明本插件对 DSH / node 的所有外部依赖形状
  （`WebServerService`、`PluginContext`、路由形状、行配置），每个声明带
  "出处"注释（包名 + 源码行号 + 形状说明）；
- 刻意**不引用** DSH 树里的 `.d.ts`：它们内部用 `.ts` 后缀导出
  （cordis `lib/types/index.d.ts` 是 `export * from './context.ts'`），
  外部 NodeNext 解析不兼容，且 DSH 树路径是机器相关的 —— 本地契约
  更稳、可移植；
- DSH 升级流程：读 `src/types.ts` 的出处注释 → 对照新源码核对形状 →
  有变就改 `src/types.ts`（编译器会把所有受影响调用点标出）→
  `npm run typecheck && npm run build && npm run test:e2e`。

E2E 测试 `test/e2e-gate.mjs` 保持 JS：它测的是**编译产物**（`lib/index.js`），
等价于 DSH 实际加载的代码，且不引入额外工具链。

## 5. 已知边界 / 待决策

0. **默认无密码（v0.4.0）**：未配置密码时远程直接放行（等价纯 lan-access）。
   密码来源优先级：`config.password` > credentials 域（进程环境变量
   `DSH_GATE_PASSWORD` > `~/.dsh/.credentials.yaml` > `.env`）。设置界面
   （插件配置 → 访问认证卡片）配置/清除密码，经 `credentials/updated`
   实时生效，无需重启。E2E 已验证（§6.1 第 20/21 条）。
1. ~~**本机用域名访问会 403**~~ **已解决（实现为默认行为）**：现在门禁按
   "回环来源 **且** 回环 Host" 才放行；回环来源 + 域名 Host（= nginx 与 DSH
   同机的反代拓扑）同样走密码认证 + 头改写。这样同机 nginx 反代开箱即用，
   且公网流量无法借 "remote 恒为 127.0.0.1" 绕过密码。代价：本机用域名访问
   也要输一次密码（本机用 `127.0.0.1` 则完全免密）。E2E 已验证（§6.1 第
   14/15 条）。
2. **登录接口无限速**：可加简单失败计数/延时（TODO）。
3. **免密网段** `trustedRemotePrefixes` 默认空；IPv4 CIDR 已实现，IPv6 未实现。
   注意：免密网段只对非回环来源生效；回环来源 + 域名 Host 不适用（见第 1 条）。
4. `host.describe` 等非特权接口 + 特权接口统一放开 —— 认证是唯一门槛，
   符合用户诉求；如未来 DSH 官方出认证层，本插件可退役。
5. 密码明文比较走 sha256 + timingSafeEqual，无明文日志。
6. **护栏不查 socket 地址**（只读 header）：任何能连到端口的人发
   `Host: 127.0.0.1` 就能穿护栏（DSH 源码注释明说这是可达性策略非认证）。
   本插件按 `req.socket.remoteAddress` 判定，非回环来源一律要密码（密码模式
   下），顺带封掉了这个 Host 欺骗漏洞（E2E 第 15 条）。
7. cookie 未加 `Secure`：兼容 LAN 明文 HTTP 直连（dsh-lan-access 场景）。
   公网部署务必 HTTPS（nginx 已配）。

## 6. 验证

### 6.1 已通过：本机真机级 E2E（`test/e2e-gate.mjs`，49/49 通过）

用**本机安装的真实 DSH 模块**搭隔离实例（随机端口，不碰线上 3080 实例）：
`@deepseek-ai/cordis` Context + `dsh-host-webserver`（真实 node:http server）+
`dsh-client-connection`（**真实护栏 / bridge / ws downlink**）+ 假 apiProxy
（最小 RPC 域方法，让链路完整跑通）。请求来源用本机 LAN IP `10.144.144.7`
模拟非回环远程（对应 nginx 转发拓扑），`127.0.0.1` 模拟本机直连。

```sh
node test/e2e-gate.mjs     # 需本机 DSH 安装（路径见 §2），Node ≥ 22
```

关键结论（与 NOTES.md §6.2 清单的对应关系）：

| # | 验证点 | 结果 |
|---|--------|------|
| 1 | baseline 远程 + 域名 Host + Origin → **403 复现**（`host.describe`） | PASS |
| 2 | baseline 远程特权方法 `settings.describe` → **403 复现** | PASS |
| 3 | baseline 本机直连 RPC → 200 `server-response`（对照正常） | PASS |
| 4 | baseline 远程 WS `/api/events.mux` → 403；本机 WS → 101 | PASS |
| 5 | 远程未认证 → 302 登录页；错密码 401；对密码 302 + HttpOnly cookie | PASS |
| 6 | **远程 + 域名 Host + Origin + cookie → 200**（头改写穿透护栏） | PASS |
| 7 | **5 个特权方法全部 200**：settings.describe / credentials.describe / llm.discoverModels / host.pickDirectory / host.openPath（loopback 钉死被穿透） | PASS |
| 8 | 伪造 cookie → 302；远程伪造 `Host: 127.0.0.1` → 302（Host 欺骗封死） | PASS |
| 9 | 本机直连（无 cookie）→ 200，**零影响** | PASS |
| 10 | 同机反代（回环来源 + 域名 Host）未认证 302、带 cookie 200 | PASS |
| 11 | `/-/echo` 直证：DSH 侧 `req.headers.host === "127.0.0.1"`、`origin === null` | PASS |
| 12 | `next=//evil` 归一化为 `/`（开放重定向防护） | PASS |
| 13 | 远程 WS 未认证 403、带 cookie 101；本机 WS 101 | PASS |
| 14 | 已登录访问登录页 → 302 跳回原目标 | PASS |
| 15 | `trustedRemotePrefixes: ['10.144.144.0/24']` → LAN 来源免密 200；CIDR 外来源（本机另一网卡 192.168.1.3）→ 302 | PASS |
| 16 | `DSH_GATE_PASSWORD` 环境变量回退（config.password 缺省）→ 登录可用 | PASS |
| 17 | 本机 `/-/gate/pick-directory` → 200 `{path:null}`（test 模式模拟取消） | PASS |
| 18 | 远程 pick-directory：未认证 302（gate 拦）、带 cookie 403（路由内回环钉死） | PASS |
| 19 | **真实 loader 挂载官方 native 后端**：store 出现官方包 entry，`capability.kind === "native"`（跨平台实现就位） | PASS |
| 20 | **默认无密码**：远程 POST（域名+Origin）→ 200、远程 WS → 101（放行模式，等价 lan-access） | PASS |
| 21 | **设置密码实时生效**：`credentials.set` + updated 事件后（未重启）远程 → 302 | PASS |
| 22 | 环境变量密码（`DSH_GATE_PASSWORD`，credentials env 层优先）→ 登录可用 | PASS |
| 23 | index 注入 randomUUID polyfill + 幂等守卫（替代 lan-access 职责） | PASS |

### 6.2 部署日真机验收清单（真实 nginx + 公网域名，逐项测）

1. 启动：`DSH_GATE_PASSWORD=xxx dsh --profile web`（确保已绑 0.0.0.0，
   可用 `dsh-lan-access` 或仿照它的 webserver patch —— 本插件 patch 不管绑定）。
2. 本机 `http://127.0.0.1:3080`：免密、功能全通（对照装插件前）。✅ 已被 E2E 第 9 条覆盖
3. 公网 `https://codsh.famlife.top`：首访 302 → 登录页；输错密码 401；
   输对 → 302 回原页，页面与 WebSocket 全通。✅ 流程已被 E2E 第 5/6/13 条覆盖
4. 验证特权接口：设置页、模型/凭据配置（`credentials.set` 等）公网可操作。
   ✅ 已被 E2E 第 7 条覆盖
5. `curl -X POST https://codsh.famlife.top/api/host.describe -H 'Content-Type:
   application/json' -H 'Origin: https://codsh.famlife.top' --data
   '{"rpcId":"t","method":"host.describe","payload":{}}'` → 无 cookie 应 302；
   带 cookie 应返回 `server-response`。✅ 已被 E2E 第 6 条覆盖（等价形态）
6. 卸载 `dsh plugin --profile web remove dsh-auth-gate` → 重启 → 复测第 3 步
   应回到 403（护栏还原），`profiles/web` 下无本插件残留文件。
   ⚠️ 仅此条必须在真实实例上做（依赖 `dsh plugin` 的包管理流程）。
7. **本机添加工作区弹 OS 原生对话框**（v0.3.0 新功能）：本机用
   `http://127.0.0.1:3080` 打开 → 添加工作区 → 应弹出**官方原生**目录
   选择框（win32 新式 IFileOpenDialog / darwin choose folder /
   linux zenity-kdialog，与官方 auto 在 loopback 绑定时一致）；选中路径 →
   工作区创建成功。远程（公网域名）添加工作区 → 仍是应用内 Miller 浏览器。
   ⚠️ 真实弹窗只能在真机验证（自动化无法交互）；E2E 已覆盖路由门禁 +
   真实 loader 挂载官方包 + capability.kind === "native"。

### 6.3 本机安装测试步骤（开发循环）

```powershell
# 1) 构建（改过 src/ 后必须跑）
cd E:\ALLCODE\project\dsh-auth-gate
npm run build

# 2) 安装（开发期用 link: 符号链接 —— 之后改代码只需 build + 重启 DSH，
#    不用重新 add；file: 则会拷贝一份，改动需重新 add）
dsh plugin --profile web add link:E:/ALLCODE/project/dsh-auth-gate

# 3) 启动（默认无密码；或先设置密码再启动）
$env:DSH_GATE_PASSWORD='你的强密码'   # 可选：环境变量方式（credentials env 层优先）
dsh web      # 或 dsh --profile web

# 4) 验证（对照 §6.2 清单）：
#    - 默认无密码：远程直接可访问（等价 lan-access）
#    - 设置密码（设置界面 → 插件配置 → 访问认证，或环境变量）：
#      本机 http://127.0.0.1:3080 免密全通；添加工作区弹原生对话框；
#      公网域名：302 → 登录页 → 密码 → 全通（页面/WS/特权接口/设置页）
#    - 卸载前先测：dsh plugin --profile web remove dsh-lan-access
#      再重启 —— 绑定 0.0.0.0 与 randomUUID polyfill 由本插件接管后应无感

# 5) 改代码循环：npm run build → 重启 DSH → 复测
```

注意：`dsh plugin` 是 pnpm 转发器（`lib/plugin-*.js`）—— 安装即
`pnpm add`，成功后自动把带 `dsh.bundle` 的包加入 `dsh.profile.bundles`
层栈；相对路径（`./`、`file:./`、`link:./`）会锚定到**调用目录**。

## 7. 参考链接

- 本机已装同类插件（绑定 0.0.0.0 + randomUUID polyfill）：
  `C:\Users\Bambo\.dsh\profiles\web\node_modules\dsh-lan-access\`

### 7.1 公网 nginx 参考配置（阿里云等云服务器反代）

公网域名 403 最常见根源是 nginx 转发形态与 DSH 预期不符。参考配置（HTTP + WS 全通）：

```nginx
server {
    listen 80;
    server_name codsh.famlife.top;
    # 若配了 TLS：listen 443 ssl; ssl_certificate ...; ssl_certificate_key ...;

    location / {
        proxy_pass http://10.144.144.7:3080;   # 家里 DSH（需公网可达：路由器端口转发/内网穿透）
        proxy_http_version 1.1;                # ★ 必须：HTTP/1.1（默认 1.0 会断 WS 与 keepalive）
        proxy_set_header Host $host;           # ★ 域名原样转发（默认 $proxy_host 会变 IP:端口）
        proxy_set_header Upgrade $http_upgrade;        # ★ WS 必需
        proxy_set_header Connection "upgrade";         # ★ WS 必需
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;              # WS 长连接不超时
        proxy_buffering off;                   # SSE/WS 不缓冲
    }
}
```

注意：`proxy_set_header Host $host;` 把域名传给 DSH —— 门禁按"来源 + Host"
判定：阿里云来源（非回环）→ 密码认证 → 认证后头改写放行。用默认
`$proxy_host`（Host=10.144.144.7:3080）也一样工作（仍走认证），两者都支持。

### 7.2 公网 403 排查清单（按概率排序）

1. **WS 转发缺失**（nginx 未配 §7.1 的 Upgrade/Connection/proxy_http_version）：
   事件流 `/api/events.mux` 握手失败 → 页面"能开但动不了"。Network 面板可见
   events.mux 失败。
2. **`sec-fetch-site: cross-site` 误杀**（v0.4.1 已修复：认证后删除该头，
   护栏不再误杀反代下的跨站形态请求）。旧版本升级即可。
3. **未认证请求被护栏 403 而非 302**：装了插件但没生效（未重启/旧版本）——
   远程未认证应 302 登录页，直接 403 说明门禁没在跑。
4. **浏览器缓存了旧 `__DSH_BOOT__`**：改插件后需重启 DSH + 浏览器硬刷新
   （Ctrl+Shift+R）。
5. **nginx 层 403**（阿里云 WAF/安全组/证书域名不符）—— 响应体是 HTML 页面
   而非 `forbidden` 文本。
- DSH 源码（护栏/webserver/bridge）见第 2 节路径。

## 8. 本机原生目录选择（v0.3.0）

### 8.1 根因

- 官方 `dsh-host-directory-picker-auto`（web profile 默认挂）启动时**采样一次**：
  `resolveDirectoryPickerBackend`（lib/index.js）—— `bindHost !== "127.0.0.1"` → `browse`；
  绑 loopback 且非 SSH 且 win32/darwin → `native`。
- `dsh-lan-access` 把 webserver 绑到 `0.0.0.0` → auto 判定"可能远程访问"→
  固定挂 browse（应用内 Miller 浏览器）+ browse 后端。
- 结果：本机用户（127.0.0.1）也失去 OS 原生文件夹选择框（"最开始直接选文件夹"
  是 auto 判定 native 时的行为）。

### 8.2 方案（零侵入官方组合）

- **host 侧**：注册 exact 路由 `/-/gate/pick-directory`（`src/index.ts`）：
  仅回环来源（路由内二次钉死，gate 之外再拦一次）；客户端断开自动 abort
  （传给官方 pick 的 signal，官方会关对话框/杀子进程）。
- **官方实现复用**（`src/native-picker.ts`）：`mountNativePicker()` 用
  `ctx.loader.create({ name: "@deepseek-ai/dsh-host-directory-picker-native",
  isolate: { directoryPicker: "dsh-auth-gate:native" } })` 把官方 native
  后端动态挂到**隔离 realm**（directoryPicker 服务与 root 的 browse 后端
  共存不冲突），取 `capability().pick(signal)` 弹对话框 —— 与官方 auto
  在 loopback 绑定时给出的交互完全一致：
  - win32：koffi + worker 子进程弹新式 IFileOpenDialog；
  - darwin：osascript "choose folder"；
  - linux：zenity / kdialog（与 auto 的探测条件一致）。
- **client 侧**：`src/client.js`（构建复制到 lib/）注册 priority -1 的
  "智能 flow" 到两个 directoryFlow slot（官方 UI 默认 priority 0，shadowing
  规则最低者渲染）：
  - 本机（`location.hostname` ∈ {127.0.0.1, localhost, [::1]}）→ renderless
    原生 flow：调 `/-/gate/pick-directory`，选中路径直接回填工作区创建；
  - 远程 → 渲染时抛错 **abdicate**（slots 官方设计的崩溃退役机制）→
    官方 browse flow（priority 0）自动接管 → 远程行为与未装插件完全一致。
- **不需要动 auto / web-app 组合**：auto 仍按绑定判定挂 browse 后端（远程
  必需），壳只负责本机场景的"加料"。

### 8.3 为什么用 loader 动态挂载而不是 node import

- 第三方插件**无法 import 官方包**：`profiles/web/node_modules` 是独立 pnpm
  布局，没有 `@deepseek-ai` 树（DSH 的包在 fnm 安装树里），node 解析不到；
- loader 的模块解析（ModuleLoader + ctx.baseUrl）从 DSH 安装树解析官方包
  —— 官方 `directory-picker-auto` 正是用 `ctx.loader.create` 动态挂载官方
  包的（同一官方 API，`cordis-plugin-loader` 的 create/remove/store）；
- 挂载是 **lazy**（首次 pick 时）且失败不致命：官方包解析/挂载失败 → 路由
  返回 500 → 客户端壳 onError 显示；认证门禁不受影响；
- 卸载零残留：entry 随插件卸载 `ctx.loader.remove(id)`。

### 8.4 已知限制 / 待办

- 官方 native 后端要求有桌面会话（与 auto 的 native 判定条件一致）：无显示
  会话的环境（SSH 转发、无头服务器）弹不出对话框 —— 这类环境 auto 本来就
  选 browse，本插件壳在本机仍会尝试 pick（会报错），后续可加"探测可用性后
  降级"（TODO）；
- 对话框无超时：用户不操作则请求一直挂起（与官方 native 行为一致）；
- 真机验收：见 §6.2 第 7 条（win32 弹 koffi 新式对话框；mac/linux 同理）。

## 9. 替代 dsh-lan-access（v0.3.0）

`dsh-auth-gate` 是 `dsh-lan-access` 的**完整替代品**，覆盖其全部职责：

| dsh-lan-access 职责 | 替代位置 |
|---|---|
| webserver 绑定 0.0.0.0（nginx 可达） | `cordis.patch.yml` 的 `- id: webserver` 覆盖（同款配置） |
| `crypto.randomUUID` polyfill（LAN 明文 HTTP 必需） | `src/index.ts` 的 `RANDOM_UUID_POLYFILL_SCRIPT`（tapIndex 注入，幂等守卫） |
| （lan-access 没有）远程认证门禁 | 本插件核心 |
| （lan-access 没有）本机原生目录选择 | §8 智能 flow + pick 路由 |

迁移步骤：装好 dsh-auth-gate 并验证通过后，
`dsh plugin --profile web remove dsh-lan-access` → 重启 DSH → 按 §6.2 复测。
过渡期两者共存无害（webserver 覆盖值相同；polyfill 都有幂等守卫，
重复注入不叠加）。

## 10. 零残留审计（卸载后逐项确认）

插件**全部**运行时副作用都在 ctx.effect 清理回调或包文件里，卸载 =
`dsh plugin --profile web remove dsh-auth-gate` + 重启 DSH：

| 副作用 | 清理机制 | 验证方法（卸载重启后） |
|---|---|---|
| `server.emit` 覆盖（门禁） | `ctx.effect` 还原（§"restore server.emit"） | 远程 POST `/api/host.describe` → 回到 403；`/-/auth/login` → 404 |
| `/-/gate/pick-directory` 路由 | `register()` disposer → `ctx.effect` | POST 该路径 → 404 |
| randomUUID polyfill 注入 | `tapIndex()` disposer → `ctx.effect` | GET `/` index.html 不含 `randomUUID` |
| 客户端智能 flow + 设置卡片（slot 注册） | slots.inject 的 disposer（随 client 插件卸载） | 添加工作区对话框 = 官方 auto 判定结果；设置界面无"访问认证"卡片 |
| bundle patch（webserver 覆盖 + insert 行） | 随包移除后不再应用（loader 按 `dsh.profile.bundles` 应用） | `profiles/web/package.json` 的 bundles 无 dsh-auth-gate |
| profile dependencies | `dsh plugin remove` = pnpm remove（官方机制） | `profiles/web/package.json` 无 dsh-auth-gate |
| 登录 token Map | 进程内存 | 进程退出即消失 |
| 官方 native picker loader entry | `ctx.loader.remove(id)`（插件清理回调） | `profiles/web` 无残留；进程内无孤儿对话框 worker |

不触碰：用户 `cordis.patch.yml`、DSH 源码、任何用户配置文件。密码若经设置
界面配置过，留在 `~/.dsh/.credentials.yaml`（DSH 官方凭据库，非本插件写入；
卸载后可用设置界面"移除密码"或直接编辑该文件清除）。`credentials/updated`
监听随插件 fiber 卸载。注：若同时卸载了 dsh-lan-access，webserver 绑定恢复
127.0.0.1（DSH 默认）——公网不可达是卸载后的**预期还原**，不是残留。

## 11. 本地 git（2026-08-15 初始化）

- `git init -b main`，提交记录：`c9f6f7c`（v0.3.0 全量）、`5aa2caf`（文档）；
- 仓库级身份：`bamboostrip <55238760+bamboostrip@users.noreply.github.com>`
  —— SSH 连通性已实测确认：GitHub 认证为 `bamboostrip`、Gitee 为
  `hank(@bamboostrip)`（`~/.ssh` 配置了 github/gitee/gitea.famlife.top 三个
  key）；推送前如需真实邮箱自行 `git config user.email`；
- `.gitignore`：node_modules / *.tsbuildinfo；**lib/ 是构建产物但必须提交**
  （`dsh plugin add link:` 装上即用的前提）；
- 推送流程：真机验收通过 → `git add -A && git commit` → 建远程仓库
  （GitHub：gh 已认证，`gh repo create`；或 Gitee / 自建 gitea.famlife.top）
  → `git remote add origin <ssh-url>` → `git push -u origin main`。
