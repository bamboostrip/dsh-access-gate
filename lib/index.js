/**
 * dsh-access-gate — DSH 远程访问认证门禁（核心实现）
 *
 * ── 背景 ────────────────────────────────────────────────────────────────
 * DSH 的 `/api` 浏览器信任护栏（@deepseek-ai/dsh-client-connection 的
 * `isTrustedApiRequest`）要求每个请求的 Host 是 loopback 或在 trustedHosts
 * 白名单里；其中一组"特权方法"（settings.*、credentials.*、host.openPath、
 * host.pickDirectory、llm.discoverModels、agentPreset.read/copy/openDocument/remove）
 * 更是硬编码钉死在 loopback（源码传空白名单）。因此经 nginx 用公网域名转发时，
 * 这些接口全部返回 403 Forbidden —— 这是设计使然（护栏是可达性策略，不是认证；
 * 源码注释明说 "this fence is not an auth layer"）。
 *
 * ── 本插件做的事 ────────────────────────────────────────────────────────
 * 1) 非本机直连的请求必须先通过密码登录（发 HttpOnly cookie）；
 * 2) 认证通过后，把请求头改写为 loopback 形态（Host → 127.0.0.1，删除 Origin），
 *    使 DSH 的护栏放行 —— 特权接口随之全部可用；
 * 3) 卸载插件：server.emit 随 ctx.effect 还原、bundle patch 随包消失，
 *    不修改任何 DSH 源码 / 用户配置文件 → 零残留还原。
 *
 * ── 实现机制（已对照 DSH 0.1.0-rc.6 源码逐行核实，E2E 真机级验证通过）──────
 * - dsh-host-webserver 用 node:http createServer 监听，路由 handler 都挂在
 *   server 的 'request'/'upgrade' 事件上；我们覆盖 server.emit 做前置拦截
 *   （node 允许覆盖实例方法），可同步决定"已处理"（return true 阻止原 listener
 *   链）还是"放行"（改写头后走原 emit）。
 * - 护栏读取的是 req.headers（dsh-client-connection/lib/index.js L553/L570），
 *   bridge 构造 Request 也拷贝 req.headers（L67）→ 改写 req.headers 即生效。
 * - isLoopbackHostname('127.0.0.1') === true；Origin 被删除后 origin===undefined
 *   → 护栏直接放行（sec-fetch-site 为 same-origin 时不拦）。
 *
 * ── 门禁判定（最终行为）─────────────────────────────────────────────────
 * 1) 回环来源 + 回环 Host（本机直连 127.0.0.1 / localhost / [::1] / 127/8）：
 *    完全放行，不干预 —— 本机体验与未装插件一致；
 * 2) 非回环来源命中 trustedRemotePrefixes（可选免密网段，IPv4 CIDR）：
 *    改写头放行；
 * 3) 未配置密码（放行模式）→ 其余一切改写头直接放行（等价纯 lan-access）；
 * 4) 配置了密码 → 其余一切必须密码登录，登录后改写头放行。包括：
 *    a. 公网域名 / 局域网 IP 来源（nginx 在不同机器）；
 *    b. 回环来源但 Host 是域名 —— 即 nginx 与 DSH 同机的反代拓扑。若放行则
 *       公网流量可绕过密码（remote 恒为 127.0.0.1），故必须认证；
 *    c. 非回环来源伪造 Host: 127.0.0.1 —— 护栏不查 socket 地址，这种请求
 *       本来能直接穿护栏，现在被门禁挡住（认证是唯一门槛）。
 *
 * ── 密码策略（默认无密码，v0.4.0）───────────────────────────────────────
 * - 未配置密码 → 放行模式：所有非本机请求改写头放行（等价纯 lan-access，
 *   远程直接可访问）；配置了密码 → 除本机直连外全部要求认证；
 * - 密码来源：config.password > credentials 域（进程环境变量
 *   DSH_GATE_PASSWORD > ~/.dsh/.credentials.yaml > .env）。设置界面
 *   （插件配置 → 访问认证卡片）可配置/清除密码，经 credentials/updated
 *   实时生效，无需重启；
 * - 登录态在内存：进程重启需重新登录。
 *
 * ── 已知边界（详见 NOTES.md §5）─────────────────────────────────────────
 * - 登录接口无限速（TODO）；
 * - 免密网段仅支持 IPv4 CIDR；
 * - cookie 未加 Secure（兼容 LAN 明文 HTTP 直连场景），务必配合 HTTPS 使用。
 *
 * ── 类型说明 ────────────────────────────────────────────────────────────
 * 本文件是 TypeScript 源码；DSH 的插件 loader 用原生 import() 加载，运行时不
 * 支持 .ts，因此发布/安装的是 tsc 编译产物（lib/index.js + lib/index.d.ts）。
 * 对外部 DSH API 的依赖形状集中在 src/types.ts（附源码出处），DSH 升级后按
 * 出处核对、改一处即可，编译器会标出所有受影响调用点。构建：npm run build。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mountNativePicker } from "./native-picker.js";
/** 稳定插件名（bundle patch 的 name 字段引用它）。 */
export const name = "dsh-access-gate";
/** 需要 webServer（路由/emit 拦截）、loader（官方 native 后端）、credentials（密码）就绪。 */
export const inject = ["webServer", "loader", "credentials"];
/** 访问密码的 credential 引用（设置界面 / 环境变量共用此名）。 */
export const PASSWORD_REF = "DSH_GATE_PASSWORD";
/** 登录页/登录接口路径（放在 DSH 不会使用的 /-/ 前缀下）。 */
const LOGIN_PATH = "/-/auth/login";
/** 本机原生目录选择路由（客户端壳调用；仅回环来源可访问）。 */
const PICK_PATH = "/-/gate/pick-directory";
const COOKIE_NAME = "dsh_gate_token";
/**
 * crypto.randomUUID polyfill（替代 dsh-lan-access 的职责之二）：
 * 浏览器只在安全上下文（HTTPS 或 localhost）暴露 crypto.randomUUID；
 * LAN 明文 HTTP（如 http://10.144.144.x:3080）下不存在，DSH 浏览器端 RPC
 * 全部抛 "crypto.randomUUID is not a function"。注入带幂等守卫的兜底实现，
 * 仅用于功能可用性，非安全用途（与 dsh-lan-access 同款）。
 */
const RANDOM_UUID_POLYFILL_SCRIPT = `<script>
if (typeof crypto !== "undefined" && typeof crypto.randomUUID !== "function") {
	crypto.randomUUID = function () {
		return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
			const r = (Math.random() * 16) | 0;
			const v = c === "x" ? r : (r & 0x3) | 0x8;
			return v.toString(16);
		});
	};
}
</script>`;
/** 登录 POST 请求体上限（表单足够）。 */
const MAX_BODY_BYTES = 64 * 1024;
/** 默认登录有效期：7 天。 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// ────────────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────────────
/** IPv4 字符串 → 32 位整数（用于 CIDR 匹配）；非法输入返回 null。 */
function ipToInt(ip) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255))
        return null;
    const [a, b, c, d] = parts;
    if (a === undefined || b === undefined || c === undefined || d === undefined)
        return null;
    return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}
/** 简单 CIDR 匹配，仅支持 IPv4，如 '10.144.144.0/24'。 */
function cidrMatch(ip, cidr) {
    const [net, bitsText] = cidr.split("/");
    if (net === undefined || bitsText === undefined)
        return false;
    const bits = Number(bitsText);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32)
        return false;
    const ipInt = ipToInt(ip);
    const netInt = ipToInt(net);
    if (ipInt === null || netInt === null)
        return false;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (ipInt & mask) === (netInt & mask);
}
/** remoteAddress 是否本机回环（含 IPv4-mapped IPv6 形式与整个 127/8）。 */
function isLoopbackRemote(remoteAddress) {
    if (!remoteAddress)
        return false;
    const plain = remoteAddress.replace(/^::ffff:/, "");
    if (plain === "127.0.0.1" || plain === "::1")
        return true;
    const int = ipToInt(plain);
    return int !== null && (int >>> 24) === 127;
}
/** Host 头是否指向本机回环权威（127.0.0.1 / localhost / [::1] / 127/8，可带端口）。 */
function isLoopbackAuthority(host) {
    if (!host)
        return false;
    let hostname;
    try {
        hostname = new URL(`http://${host}`).hostname;
    }
    catch {
        return false;
    }
    if (hostname === "localhost" || hostname === "[::1]")
        return true;
    const parts = hostname.split(".");
    return parts.length === 4 && parts[0] === "127"
        && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/** 读取请求体（限流），返回字符串。 */
function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
/** sha256 hex，用于密码比较与 token 派生。 */
function sha256Hex(value) {
    return createHash("sha256").update(value).digest("hex");
}
/** 常数时间比较两个 hex 字符串。 */
function safeEqualHex(a, b) {
    const ba = Buffer.from(a, "hex");
    const bb = Buffer.from(b, "hex");
    return ba.length === bb.length && timingSafeEqual(ba, bb);
}
/** 解析 Cookie 头 → { name: value }（畸形百分号编码不抛异常）。 */
function parseCookies(header) {
    const out = {};
    if (!header)
        return out;
    for (const part of header.split(";")) {
        const eq = part.indexOf("=");
        if (eq === -1)
            continue;
        const key = part.slice(0, eq).trim();
        let value;
        try {
            value = decodeURIComponent(part.slice(eq + 1).trim());
        }
        catch {
            continue;
        }
        out[key] = value;
    }
    return out;
}
function escapeHtml(value) {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return String(value).replace(/[&<>"']/g, (c) => map[c] ?? c);
}
/** next 参数白名单：相对路径（以 / 开头）、拒绝协议相对与反斜杠/控制字符。 */
function isSafeNext(next) {
    if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//"))
        return false;
    return !/[\\\x00-\x1f\x7f]/.test(next);
}
/** 登录页 HTML（简陋够用；TODO：可换更好看的样式）。 */
function renderLoginPage(next, errorText) {
    const nextInput = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
    const error = errorText ? `<p class="error">${escapeHtml(errorText)}</p>` : "";
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 访问认证</title>
<style>
body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
.card{background:#1c1c1c;border:1px solid #333;border-radius:12px;padding:32px 40px;width:320px}
h1{font-size:18px;margin:0 0 4px} p{color:#999;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid #444;background:#111;color:#eee;margin-bottom:14px}
button{width:100%;padding:10px;border:0;border-radius:8px;background:#4f8cff;color:#fff;font-size:14px;cursor:pointer}
.error{color:#ff6b6b;font-size:13px;margin-bottom:10px}
</style></head>
<body><form class="card" method="post" action="${LOGIN_PATH}">
<h1>DSH 访问认证</h1><p>此实例需要密码才能远程访问</p>
<input type="password" name="password" placeholder="访问密码" autofocus required>
${nextInput}
${error}
<button type="submit">进入</button>
</form></body></html>`;
}
// ────────────────────────────────────────────────────────────────────────
// 插件主体
// ────────────────────────────────────────────────────────────────────────
/**
 * 插件入口。
 * @param ctx - plugin context；inject: [webServer, loader, credentials]。
 * @param config - 行配置（见 src/types.ts AuthGateConfig）。
 *
 * 密码策略（默认无密码）：
 *   - 未配置任何密码 → 放行模式：所有非本机请求改写头放行（等价纯
 *     lan-access 行为，远程直接可访问）；
 *   - 配置了密码 → 除本机直连（回环来源 + 回环 Host）外全部要求认证。
 *   密码来源优先级：config.password > credentials 域
 *   （进程环境变量 DSH_GATE_PASSWORD > ~/.dsh/.credentials.yaml > .env）；
 *   设置界面改密码经 credentials/updated 事件实时生效，无需重启。
 */
export async function apply(ctx, config = {}) {
    const trustedRemotePrefixes = config.trustedRemotePrefixes ?? [];
    const tokenTtlMs = config.tokenTtlMs ?? DEFAULT_TTL_MS;
    /** token → 过期时间戳。内存态：进程重启后需重新登录。 */
    const tokens = new Map();
    /** 当前生效的密码哈希；null = 未配置密码（放行模式）。 */
    let passwordHash = null;
    const refreshPassword = async () => {
        const fromConfig = config.password;
        const fromCredentials = fromConfig !== undefined ? undefined : (await ctx.credentials.resolve(PASSWORD_REF))?.value;
        const password = fromConfig ?? fromCredentials;
        passwordHash = password !== undefined && password !== "" && password !== "change-me" ? sha256Hex(password) : null;
    };
    await refreshPassword();
    // 设置界面（或外部编辑 .credentials.yaml）改密码 → 实时生效。
    ctx.on("credentials/updated", (ref) => {
        if (ref === PASSWORD_REF)
            void refreshPassword();
    });
    const isAuthorized = (req) => {
        const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
        if (!token)
            return false;
        const expiresAt = tokens.get(token);
        if (expiresAt === undefined)
            return false;
        if (expiresAt < Date.now()) {
            tokens.delete(token);
            return false;
        }
        return true;
    };
    /** 放行 = 把请求头改写成 loopback 形态，让 DSH 护栏放行（含特权接口）。 */
    const grantLoopback = (req) => {
        req.headers.host = "127.0.0.1";
        delete req.headers.origin;
        // 护栏最后一个拒绝条件：sec-fetch-site: cross-site（L190 硬拒，头改写
        // 无效）。认证/放行通过后它是冗余的：带 HttpOnly + SameSite=Lax
        // cookie 的请求天然同站（Lax 禁止跨站请求携带 cookie），跨站攻击者
        // 无法构造；而 nginx 反代下个别请求（预加载/跳转等）确实会带
        // cross-site，删掉避免误杀。未认证路径不经过护栏（gate 直接 302）。
        delete req.headers["sec-fetch-site"];
    };
    /**
     * 登录流程的"已处理"分支（同步判定 → 异步收尾）：
     * 返回 true 表示本插件已接管该请求（后续 DSH listener 不再执行）。
     */
    const handleLogin = (req, res, url) => {
        if (req.method === "GET") {
            const nextParam = url.searchParams.get("next");
            const next = typeof nextParam === "string" ? nextParam : "/";
            if (isAuthorized(req)) {
                // 已登录还访问登录页：直接送回原目标。
                try {
                    res.writeHead(302, { location: isSafeNext(next) ? next : "/", "cache-control": "no-store" });
                    res.end();
                }
                catch { /* 客户端已断开 */ }
                return true;
            }
            try {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                res.end(renderLoginPage(isSafeNext(next) ? next : "/"));
            }
            catch { /* 客户端已断开 */ }
            return true;
        }
        if (req.method === "POST") {
            // 异步读 body 校验，先同步"接管"请求，防止 DSH 的 handler 同时处理。
            readBody(req).then((body) => {
                const params = new URLSearchParams(body);
                const next = params.get("next") ?? "/";
                const safeNext = isSafeNext(next) ? next : "/";
                // passwordHash 为 null（放行模式）时 gateRequest 已短路；此处 ?? "" 保证永不匹配。
                if (!safeEqualHex(sha256Hex(params.get("password") ?? ""), passwordHash ?? "")) {
                    try {
                        res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
                        res.end(renderLoginPage(safeNext, "密码错误"));
                    }
                    catch { /* 客户端已断开 */ }
                    return;
                }
                const token = randomBytes(32).toString("hex");
                tokens.set(token, Date.now() + tokenTtlMs);
                try {
                    res.writeHead(302, {
                        location: safeNext,
                        "set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(tokenTtlMs / 1000)}`
                    });
                    res.end();
                }
                catch { /* 客户端已断开 */ }
            }).catch(() => {
                try {
                    res.writeHead(400);
                    res.end("bad request");
                }
                catch { /* 客户端已断开 */ }
            });
            return true;
        }
        try {
            res.writeHead(405);
            res.end();
        }
        catch { /* 客户端已断开 */ }
        return true;
    };
    /** 普通请求门禁。返回 'pass'（放行，已改写头）或 'handled'（已响应）。 */
    const gateRequest = (req, res) => {
        const remote = req.socket.remoteAddress ?? "";
        // 1) 本机直连（回环来源 + 回环 Host）：完全不干预。
        if (isLoopbackRemote(remote) && isLoopbackAuthority(req.headers.host))
            return "pass";
        // 2) 免密网段（仅对非回环来源生效；同机反代不适用，见文件头注释 3b）。
        if (!isLoopbackRemote(remote) && trustedRemotePrefixes.some((cidr) => cidrMatch(remote, cidr))) {
            grantLoopback(req);
            return "pass";
        }
        // 2.5) 未配置密码 → 放行模式：改写头穿透护栏（等价纯 lan-access，远程直接访问）。
        if (passwordHash === null) {
            grantLoopback(req);
            return "pass";
        }
        // 3) 密码模式：其余一律要求认证。
        const url = new URL(req.url ?? "/", "http://dsh.internal");
        if (url.pathname === LOGIN_PATH) {
            return handleLogin(req, res, url) ? "handled" : "pass";
        }
        if (isAuthorized(req)) {
            grantLoopback(req);
            return "pass";
        }
        // 未认证：跳登录页（带上原路径，登录后跳回）。Connection: close 避免
        // 未读请求体导致 keep-alive 连接上的解析错位。
        const next = encodeURIComponent(url.pathname + url.search);
        try {
            res.writeHead(302, { location: `${LOGIN_PATH}?next=${next}`, "cache-control": "no-store", connection: "close" });
            res.end();
        }
        catch { /* 客户端已断开 */ }
        return "handled";
    };
    /** WebSocket 握手门禁（DSH 的 events.mux / events.host）。 */
    const gateUpgrade = (req, socket) => {
        const remote = req.socket.remoteAddress ?? "";
        if (isLoopbackRemote(remote) && isLoopbackAuthority(req.headers.host))
            return "pass";
        if (!isLoopbackRemote(remote) && trustedRemotePrefixes.some((cidr) => cidrMatch(remote, cidr))) {
            grantLoopback(req);
            return "pass";
        }
        if (passwordHash === null) {
            grantLoopback(req);
            return "pass";
        }
        if (isAuthorized(req)) {
            grantLoopback(req);
            return "pass";
        }
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return "handled";
    };
    const server = ctx.webServer.server;
    const originalEmit = server.emit;
    server.emit = function (event, ...args) {
        if (event === "request") {
            const [req, res] = args;
            if (gateRequest(req, res) === "handled")
                return true;
        }
        else if (event === "upgrade") {
            const [req, socket] = args;
            if (gateUpgrade(req, socket) === "handled")
                return true;
        }
        return originalEmit.call(this, event, ...args);
    };
    // 本机原生目录选择路由：仅回环来源可用（远程走官方 browse，见 NOTES §8）。
    // 供客户端壳组件调用 —— 弹官方原生 OS 目录对话框（loader 动态挂载官方
    // native 后端，win32 koffi / darwin osascript / linux zenity-kdialog）。
    // 绕开"auto 因 0.0.0.0 绑定固定选 browse"的限制（根因见 NOTES §8.1）。
    let nativePickerPromise = null;
    const getNativePicker = () => {
        if (nativePickerPromise === null) {
            nativePickerPromise = mountNativePicker(ctx).catch((error) => {
                nativePickerPromise = null;
                throw error;
            });
        }
        return nativePickerPromise;
    };
    /** 卸载 picker（移除 loader entry + 清缓存）；无挂载时静默。 */
    const disposeNativePicker = async () => {
        const current = nativePickerPromise;
        nativePickerPromise = null;
        try {
            await current?.catch(() => null).then((picker) => picker?.dispose());
        }
        catch {
            // 清理失败不阻塞（entry 残留由下次 mount 前的清扫兜底）。
        }
    };
    const pickRoute = ctx.webServer.register({
        kind: "exact",
        path: PICK_PATH,
        handler: async (req, res) => {
            // 双保险：gate 只放行本机直连/已认证请求，这里再钉死回环来源。
            if (!isLoopbackRemote(req.socket.remoteAddress)) {
                res.writeHead(403);
                res.end("forbidden");
                return;
            }
            if (req.method !== "POST") {
                res.writeHead(405);
                res.end();
                return;
            }
            const controller = new AbortController();
            // 客户端断开（fetch abort / 页面关闭）→ 关闭对话框（官方 pick 支持 abort）。
            req.on("close", () => {
                if (!res.writableEnded)
                    controller.abort();
            });
            try {
                const picker = await getNativePicker();
                let path = null;
                // 测试模式：不弹真实对话框（自动化环境无法交互），模拟用户取消。
                if (process.env.DSH_GATE_PICKER_TEST !== "1")
                    path = await picker.pick(controller.signal);
                if (res.writableEnded)
                    return;
                res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
                res.end(JSON.stringify({ path }));
            }
            catch (error) {
                // pick 失败（对话框错误 / 客户端中断 / 挂载失败）：释放 loader
                // entry 并清缓存 —— 残留 entry 会让后续挂载报
                // "service "directoryPicker" has been registered"（死锁直到 DSH
                // 重启，见 native-picker.ts 文件头"残留清理"）。
                await disposeNativePicker();
                if (res.writableEnded)
                    return;
                res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
                res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
            }
        }
    });
    ctx.effect(() => pickRoute, "auth-gate: native pick route");
    // 卸载/停用时卸下官方 native picker entry（若已挂载）。
    // 注意：disposer 必须在此刻（卸载时）读取 nativePickerPromise —— 若像
    // 旧写法那样在 effect 注册时就读，当时 promise 恒为 null，entry 会泄漏。
    ctx.effect(() => () => disposeNativePicker(), "auth-gate: native picker entry");
    // randomUUID polyfill 注入（每次 index.html 响应时应用；幂等守卫防重复）。
    const removePolyfill = ctx.webServer.tapIndex((html) => html.includes("randomUUID") ? html : html.replace("</head>", RANDOM_UUID_POLYFILL_SCRIPT + "</head>"));
    ctx.effect(() => removePolyfill, "auth-gate: randomUUID polyfill tap");
    // 卸载/停用时还原 server.emit —— 与 bundle patch 随包消失一起保证零残留。
    ctx.effect(() => () => {
        server.emit = originalEmit;
    }, "auth-gate: restore server.emit");
    ctx.logger?.info?.(`dsh-access-gate: 已启用（密码：${passwordHash === null ? "未配置，远程直接放行" : "已配置，远程需认证"}；${trustedRemotePrefixes.length} 个免密网段；本机原生目录选择；randomUUID polyfill）`);
}
//# sourceMappingURL=index.js.map