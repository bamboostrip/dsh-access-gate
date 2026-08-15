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
   本插件按 `req.socket.remoteAddress` 判定，非回环来源一律要密码，
   顺带封掉了这个 Host 欺骗漏洞（E2E 第 15 条）。
7. cookie 未加 `Secure`：兼容 LAN 明文 HTTP 直连（dsh-lan-access 场景）。
   公网部署务必 HTTPS（nginx 已配）。

## 6. 验证

### 6.1 已通过：本机真机级 E2E（`test/e2e-gate.mjs`，40/40 通过）

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
   `http://127.0.0.1:3080` 打开 → 添加工作区 → 应弹出 Windows 原生
   "Select Workspace Directory" 文件夹选择框；选中路径 → 工作区创建成功。
   远程（公网域名）添加工作区 → 仍是应用内 Miller 浏览器。⚠️ 真实弹窗
   只能在真机验证（自动化无法交互）；E2E 只覆盖了路由门禁与 test 模式。

## 7. 参考链接

- 本机已装同类插件（绑定 0.0.0.0 + randomUUID polyfill）：
  `C:\Users\Bambo\.dsh\profiles\web\node_modules\dsh-lan-access\`
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
  （杀掉对话框进程）。对话框实现 `src/native-picker.ts`：
  Windows 自带 `powershell.exe -STA` + `System.Windows.Forms.FolderBrowserDialog`
  （UTF-8 输出防中文路径乱码；取消 → null）。
- **client 侧**：`src/client.js`（构建复制到 lib/）注册 priority -1 的
  "智能 flow" 到两个 directoryFlow slot（官方 UI 默认 priority 0，shadowing
  规则最低者渲染）：
  - 本机（`location.hostname` ∈ {127.0.0.1, localhost, [::1]}）→ renderless
    原生 flow：调 `/-/gate/pick-directory`，选中路径直接回填工作区创建；
  - 远程 → 渲染时抛错 **abdicate**（slots 官方设计的崩溃退役机制）→
    官方 browse flow（priority 0）自动接管 → 远程行为与未装插件完全一致。
- **不需要动 auto / web-app 组合**：auto 仍按绑定判定挂 browse 后端（远程
  必需），壳只负责本机场景的"加料"。

### 8.3 为什么自实现 PowerShell 而不是调官方 native 后端

- 第三方插件**无法 import 官方包**：`profiles/web/node_modules` 是独立 pnpm
  布局，没有 `@deepseek-ai` 树（DSH 的包在 fnm 安装树里），node 解析不到；
- loader 动态挂载官方 native 包到 isolate realm（`loader.create({name,
  isolate: {directoryPicker: ...}})`）可复用官方 koffi 新式对话框，但依赖
  loader 内部生命周期 API，随 DSH 升级易碎 —— 记为备选（§8.4）；
- PowerShell FolderBrowserDialog：Windows 自带、零 npm 依赖、零 loader 介入、
  卸载零残留。代价：老式对话框外观、无属主窗口（不置顶）、Windows only。

### 8.4 已知限制 / 待办

- 仅 win32 实现（`src/native-picker.ts` 对其他平台返回错误，壳会走 onError；
  远程场景不受影响——abdicate 降级 browse）；
- 对话框无超时：用户不操作则请求一直挂起（与官方 native 行为一致）；
- 备选方案：DSH 升级后若官方对话框体验变化，可切到 loader isolate 动态挂载
  官方 native 后端（复用 koffi 新式 IFileOpenDialog）；
- 真机验收：见 §6.2 第 7 条。
