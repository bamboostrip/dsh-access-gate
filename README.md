# dsh-auth-gate

DSH（DeepSeek Harness）远程访问认证门禁插件：让经 nginx 公网域名转发访问时，
所有被浏览器信任护栏 403 拦截的接口（含 `settings.*`、`credentials.*` 等
loopback 特权接口）通过密码认证后全部可用；本机 `127.0.0.1` 访问不受影响；
卸载插件后一切还原，零残留、不污染用户配置。

## 解决的问题

DSH Web GUI 的 `/api` 有浏览器信任护栏（DNS-rebinding 防伪）：Host 必须是
loopback 或 `trustedHosts` 白名单域名，否则一律 403 `forbidden`；其中一组
特权接口更是硬编码只认 loopback。因此 `https://codsh.famlife.top` 这类公网
域名转发下，`host.describe`、`syncInspectManifest`、设置页、API 密钥配置等
全部 403，页面能开但完全没法用。

详见 `NOTES.md`（含源码证据与完整技术方案）。

## 安装

```sh
# 本地目录安装（开发期）：
dsh plugin --profile web add file:/E:/ALLCODE/project/dsh-auth-gate

# 发布到 npm 后：
# dsh plugin --profile web add dsh-auth-gate
```

设置访问密码（二选一）：

```sh
# 推荐：环境变量，不落盘
DSH_GATE_PASSWORD=你的密码
# 或：在 profiles/web/cordis.patch.yml 覆盖 auth-gate 行配置
```

然后重启 DSH 服务生效。

> 前置条件：webserver 必须已绑定 `0.0.0.0` 才能被 nginx 转发到。
> 本插件不管绑定（职责单一），请用 `dsh-lan-access` 或仿照它的
> webserver patch 完成绑定。

## 使用

- 本机访问 `http://127.0.0.1:3080`：免密，行为与未装插件完全一致。
- 远程访问（公网域名 / 局域网 IP）：首次任意请求会 302 到登录页，输入密码后
  种下 HttpOnly Cookie，之后 7 天内免登录（有效期可配）。
- nginx 与 DSH 同机时（remote 恒为 127.0.0.1 但 Host 是域名）同样需要密码，
  登录后正常使用 —— 公网流量无法绕过认证。
- 登录态存在内存：DSH 进程重启后需重新登录。
- **本机添加工作区弹 OS 原生目录对话框**（v0.3.0）：即使因 `dsh-lan-access`
  绑定 0.0.0.0 导致官方 auto 选择器固定为应用内浏览，本机（127.0.0.1 /
  localhost）添加工作区时仍会弹出 Windows 原生文件夹选择框；远程访问时
  自动降级回官方应用内浏览器，体验不变。详见 `NOTES.md` §8。

## 可选配置（在 cordis.patch.yml 覆盖 auth-gate 行）

```yaml
- id: auth-gate
  config:
    password: '你的密码'                    # 或走 DSH_GATE_PASSWORD 环境变量
    trustedRemotePrefixes: ['10.144.144.0/24']   # 内网网段免密（IPv4 CIDR）
    tokenTtlMs: 604800000                  # 登录有效期，默认 7 天
```

## 卸载（零残留）

```sh
dsh plugin --profile web remove dsh-auth-gate
```

卸载后：包与 bundle patch 一起移除，`server.emit` 拦截器随进程重启消失，
DSH 恢复原厂护栏行为。插件不修改任何 DSH 源码、不写入用户配置文件。

## 安全提示

- 本插件提供的是"密码门禁"，不是 TLS 之外的身份体系；请务必配合 nginx 的
  HTTPS（已有）使用，防止密码与 Cookie 明文传输。
- 认证通过后放行的等价于本机操作权限（DSH 本身是远程执行工具），密码务必
  强随机、独立于其他服务。
- 建议 nginx 层再加 IP 白名单 / Basic Auth 双保险。
- 登录接口无失败次数限制（TODO：可加简单限速）。

## 开发

项目是 TypeScript 源码（`src/`）+ tsc 编译产物（`lib/`）的结构 —— DSH 的插件
loader 用原生 `import()` 加载，运行时不支持 `.ts`，所以安装/发布的始终是编译
后的 `lib/index.js`（这是 cordis 插件生态的标准做法，与 DSH 源码自身一致）。

```sh
npm install            # 首次：安装 typescript / @types/node

npm run typecheck      # 只做类型检查（改完代码先跑这个）
npm run build          # 编译 src/ → lib/（含 .d.ts 与 sourcemap）
npm run test:e2e       # 真机级 E2E（40 项断言，用本机真实 DSH 模块）

# 部署到 DSH：改完 src 必须 build，然后重启 DSH 进程生效
```

对 DSH 外部 API 的依赖形状集中在 `src/types.ts`（每个声明附源码出处）。
DSH 是测试版、API 可能变化：升级后对照出处核对新源码，改 `src/types.ts`
一处，编译器会把所有受影响的调用点标出来 —— 不用人肉搜索。

E2E 验证内容与结果见 `NOTES.md` §6.1；部署日真机验收清单见 §6.2。
