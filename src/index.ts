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
 * ── 实现机制（已对照 DSH 0.1.0-rc.6 源码逐行核实，E2E 真机级验证通过；
 *    v0.6.0 适配 rc.7：slots API 的 settings.plugin.item 由 list 改 keyed，
 *    host 侧新增 settings namespace 注册，已对照 rc.7 源码核实）──────────
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
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import z from "@deepseek-ai/schemastery";
import { mountNativePicker, type NativePicker } from "./native-picker.js";
import type { AuthGateConfig, PluginContext, ThemePreference } from "./types.js";

/** 稳定插件名（bundle patch 的 name 字段引用它）。 */
export const name = "dsh-access-gate";
/** 需要 webServer（路由/emit 拦截）、loader（官方 native 后端）、credentials（密码）就绪。 */
export const inject = ["webServer", "loader", "credentials"];

/** 访问密码的 credential 引用（设置界面 / 环境变量共用此名）。 */
export const PASSWORD_REF = "DSH_GATE_PASSWORD";

/**
 * 本插件在 host settings 服务注册的 namespace（rc.7 适配，v0.6.0）。
 *
 * 官方"插件配置"选项卡（dsh-client-ui-settings-plugins 的
 * ConfigurablePluginsTabController）渲染的是两侧交集：host 侧 settings.describe
 * 返回的 namespace × client 侧 settings.plugin.item 卡片注册的 key。host 半边
 * 不注册 namespace，client 卡片（src/client.js 的 SETTINGS_NS_KEY）就静默
 * 不出现 —— 两处字面量必须一致。
 */
export const SETTINGS_NAMESPACE = "dsh-access-gate";

/** 默认登录有效期：7 天。 */
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * settings namespace 的 schema（镜像 AuthGateConfig；官方
 * installSettingsSection 同款：行配置作 base 层，settings 文档作用户覆盖层）。
 * password 标记 secret 角色：settings.describe 对 wire 面自动脱敏。
 */
const Config = z.object({
	password: z.string().role("secret"),
	trustedRemotePrefixes: z.array(z.string()),
	tokenTtlMs: z.number().step(1).min(1).default(DEFAULT_TTL_MS),
});

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

// ────────────────────────────────────────────────────────────────────────
// 工具函数
// ────────────────────────────────────────────────────────────────────────

/** IPv4 字符串 → 32 位整数（用于 CIDR 匹配）；非法输入返回 null。 */
function ipToInt(ip: string): number | null {
	const parts = ip.split(".").map(Number);
	if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return null;
	const [a, b, c, d] = parts;
	if (a === undefined || b === undefined || c === undefined || d === undefined) return null;
	return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

/** 简单 CIDR 匹配，仅支持 IPv4，如 '10.144.144.0/24'。 */
function cidrMatch(ip: string, cidr: string): boolean {
	const [net, bitsText] = cidr.split("/");
	if (net === undefined || bitsText === undefined) return false;
	const bits = Number(bitsText);
	if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
	const ipInt = ipToInt(ip);
	const netInt = ipToInt(net);
	if (ipInt === null || netInt === null) return false;
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (ipInt & mask) === (netInt & mask);
}

/** remoteAddress 是否本机回环（含 IPv4-mapped IPv6 形式与整个 127/8）。 */
function isLoopbackRemote(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) return false;
	const plain = remoteAddress.replace(/^::ffff:/, "");
	if (plain === "127.0.0.1" || plain === "::1") return true;
	const int = ipToInt(plain);
	return int !== null && (int >>> 24) === 127;
}

/** Host 头是否指向本机回环权威（127.0.0.1 / localhost / [::1] / 127/8，可带端口）。 */
function isLoopbackAuthority(host: string | undefined): boolean {
	if (!host) return false;
	let hostname: string;
	try {
		hostname = new URL(`http://${host}`).hostname;
	} catch {
		return false;
	}
	if (hostname === "localhost" || hostname === "[::1]") return true;
	const parts = hostname.split(".");
	return parts.length === 4 && parts[0] === "127"
		&& parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** 读取请求体（限流），返回字符串。 */
function readBody(req: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on("data", (chunk: Buffer) => {
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
function sha256Hex(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** 常数时间比较两个 hex 字符串。 */
function safeEqualHex(a: string, b: string): boolean {
	const ba = Buffer.from(a, "hex");
	const bb = Buffer.from(b, "hex");
	return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** 解析 Cookie 头 → { name: value }（畸形百分号编码不抛异常）。 */
function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const eq = part.indexOf("=");
		if (eq === -1) continue;
		const key = part.slice(0, eq).trim();
		let value: string;
		try {
			value = decodeURIComponent(part.slice(eq + 1).trim());
		} catch {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function escapeHtml(value: unknown): string {
	const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	return String(value).replace(/[&<>"']/g, (c) => map[c] ?? c);
}

/** next 参数白名单：相对路径（以 / 开头）、拒绝协议相对与反斜杠/控制字符。 */
function isSafeNext(next: unknown): next is string {
	if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return false;
	return !/[\\\x00-\x1f\x7f]/.test(next);
}

/**
 * 登录页 HTML（v0.6.0 重设计）。
 *
 * 主题同步：与官方前端共用同一持久层与标记 —— host 侧读 ui-theme namespace
 * 的 preference（light/dark/system，官方 DEFAULT_PREFERENCE='system'），
 * 页面内嵌与官方 bootThemeScript 同款的解析脚本（system 经
 * prefers-color-scheme 解析），写相同的 DOM 字段：<html>.colorScheme +
 * <body> 的 data-ds-dark-theme。差异一处：官方脚本是一次性引导（前端
 * ThemePresenter 接管），登录页是独立页面，故 system 模式下挂 matchMedia
 * 监听跟随系统实时切换。色板取自官方前端 token（--dsw-alias-* /
 * --dsw-static-* 的实际值，见 NOTES §12.1），因登录页在未认证状态下拿
 * 不到 /assets 的应用样式（gate 会拦），故内联同值。
 */
function renderLoginPage(next: string, errorText?: string, preference: ThemePreference = "system"): string {
	const nextInput = next ? `<input type="hidden" name="next" value="${escapeHtml(next)}">` : "";
	const error = errorText ? `<p class="gate-error" role="alert">${escapeHtml(errorText)}</p>` : "";
	return `<!DOCTYPE html>
<!-- dsh-access-gate login ui v3：flex 居中 + 首帧防跳（view-source 见此行即最新构建）-->
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>DSH 访问认证</title>
<script>document.documentElement.classList.add("gate-js")</script>
<style>
:root{color-scheme:light dark}
*{box-sizing:border-box}
body{
	margin:0;min-height:100vh;min-height:100svh;display:flex;align-items:center;justify-content:center;padding:24px;
	font-family:system-ui,-apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
	/* 浅色（默认）：dsh light token 实际值 */
	--page-bg:rgb(245,246,247);--card-bg:rgb(255,255,255);--card-border:rgba(0,0,0,.08);
	--label-1:rgb(15,17,21);--label-2:rgb(97,102,107);--label-3:rgb(129,133,140);
	--field-bg:rgb(255,255,255);--field-border:rgba(0,0,0,.14);
	--accent:rgb(65,118,230);--accent-hover:rgb(72,104,178);--accent-contrast:rgb(255,255,255);
	--accent-tint:rgba(65,118,230,.09);--accent-ring:rgba(65,118,230,.18);
	--error:rgb(236,19,19);--error-tint:rgba(236,19,19,.07);
	--glow-1:rgba(65,118,230,.07);--glow-2:rgba(65,118,230,.05);
	--card-shadow:0 1px 2px rgba(15,17,21,.04),0 12px 32px rgba(15,17,21,.07);
	background:
		radial-gradient(560px 320px at 18% 6%,var(--glow-1),transparent 62%),
		radial-gradient(620px 380px at 86% 96%,var(--glow-2),transparent 62%),
		var(--page-bg);
}
/* 深色：官方 body[data-ds-dark-theme] 标记（与 dsh 前端同字段名）*/
body[data-ds-dark-theme]{
	--page-bg:rgb(21,21,23);--card-bg:rgb(35,35,36);--card-border:rgba(255,255,255,.08);
	--label-1:rgb(249,250,251);--label-2:rgb(207,211,214);--label-3:rgb(173,178,184);
	--field-bg:rgb(21,21,23);--field-border:rgba(255,255,255,.14);
	--accent:rgb(103,158,254);--accent-hover:rgb(86,134,254);--accent-contrast:rgb(255,255,255);
	--accent-tint:rgba(103,158,254,.12);--accent-ring:rgba(103,158,254,.28);
	--error:rgb(242,90,90);--error-tint:rgba(242,90,90,.1);
	--glow-1:rgba(103,158,254,.08);--glow-2:rgba(103,158,254,.05);
	--card-shadow:0 1px 2px rgba(0,0,0,.4),0 12px 32px rgba(0,0,0,.35);
}
.gate-card{
	width:360px;max-width:100%;padding:36px 32px 28px;text-align:center;
	background:var(--card-bg);border:1px solid var(--card-border);
	border-radius:16px;box-shadow:var(--card-shadow);
}
.gate-badge{
	width:46px;height:46px;margin:0 auto;display:flex;align-items:center;justify-content:center;
	border-radius:13px;background:var(--accent-tint);color:var(--accent);
}
.gate-badge svg{display:block}
h1{margin:18px 0 6px;font-size:17px;font-weight:600;color:var(--label-1);letter-spacing:.2px}
.gate-desc{margin:0;font-size:13px;line-height:1.6;color:var(--label-2)}
form{margin-top:26px;text-align:left}
.gate-field{position:relative}
input[type=password],input[type=text]{
	width:100%;height:42px;padding:0 44px 0 13px;font:inherit;font-size:14px;
	color:var(--label-1);background:var(--field-bg);
	border:1px solid var(--field-border);border-radius:10px;
	transition:border-color .15s,box-shadow .15s;
}
input[type=password]:focus,input[type=text]:focus{
	outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-ring);
}
input::placeholder{color:var(--label-3)}
.gate-field-error input{border-color:var(--error)}
.gate-field-error input:focus{border-color:var(--error);box-shadow:0 0 0 3px var(--error-tint)}
.gate-eye{
	position:absolute;right:5px;top:50%;transform:translateY(-50%);
	width:32px;height:32px;display:flex;align-items:center;justify-content:center;
	border:none;background:none;padding:0;cursor:pointer;color:var(--label-3);
	border-radius:8px;transition:color .15s;
}
.gate-eye:hover{color:var(--label-1)}
.gate-eye svg{display:none}
.gate-eye .gate-eye-shut{display:block}
.gate-eye.gate-eye-on .gate-eye-shut{display:none}
.gate-eye.gate-eye-on .gate-eye-open{display:block}
.gate-error{
	margin:14px 0 0;display:flex;align-items:center;gap:7px;
	padding:9px 12px;font-size:13px;color:var(--error);
	background:var(--error-tint);border-radius:10px;
}
.gate-error svg{flex:none;display:block}
button[type=submit]{
	width:100%;height:42px;margin-top:16px;font:inherit;font-size:14px;font-weight:500;
	color:var(--accent-contrast);background:var(--accent);border:none;border-radius:10px;
	cursor:pointer;transition:background .15s;
}
button[type=submit]:hover{background:var(--accent-hover)}
button[type=submit]:active{transform:translateY(1px)}
button[type=submit]:focus-visible,input:focus-visible,.gate-eye:focus-visible{
	outline:2px solid var(--accent);outline-offset:2px;box-shadow:none;
}
.gate-foot{margin:20px 0 0;font-size:12px;color:var(--label-3)}
/* 首帧防跳：HTML 流式解析时居中卡片随内容增长会重排（输入框先低后高，
 * 公网慢链路上肉眼可见）。gate-js 由 <head> 内联脚本标记（JS 可用证明），
 * body 先隐藏，解析到末尾脚本加 gate-ready 才显示 —— 用户只看到最终布局。
 * 无 JS 环境不标记 gate-js，页面直接显示（主题回落浅色）。 */
html.gate-js body{visibility:hidden}
html.gate-js body.gate-ready{visibility:visible;animation:gate-in .18s ease}
@keyframes gate-in{from{opacity:0}to{opacity:1}}
@media (prefers-reduced-motion:reduce){html.gate-js body.gate-ready{animation:none}}
</style>
</head>
<body>
<script>
(function () {
	var preference = ${JSON.stringify(preference)};
	var media = typeof matchMedia !== "undefined" ? matchMedia("(prefers-color-scheme: dark)") : undefined;
	var apply = function (dark) {
		document.documentElement.style.colorScheme = dark ? "dark" : "light";
		if (dark) document.body.setAttribute("data-ds-dark-theme", "");
		else document.body.removeAttribute("data-ds-dark-theme");
	};
	apply(preference === "dark" || (preference === "system" && !!media && media.matches));
	if (preference === "system" && media) {
		var onChange = function () { apply(media.matches); };
		if (media.addEventListener) media.addEventListener("change", onChange);
		else if (media.addListener) media.addListener(onChange);
	}
})();
</script>
<main class="gate-card">
	<div class="gate-badge" aria-hidden="true">
		<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
			<rect x="4.5" y="10.5" width="15" height="9.5" rx="2.5"></rect>
			<path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"></path>
			<circle cx="12" cy="15.2" r="1.2" fill="currentColor" stroke="none"></circle>
		</svg>
	</div>
	<h1>DSH 访问认证</h1>
	<p class="gate-desc">此实例已启用密码保护，请输入访问密码继续</p>
	<form method="post" action="${LOGIN_PATH}">
		<div class="gate-field${errorText ? " gate-field-error" : ""}">
			<input id="gate-password" type="password" name="password" placeholder="访问密码"
				autocomplete="current-password" autofocus required enterkeyhint="go">
			<button type="button" class="gate-eye" id="gate-eye" aria-label="显示或隐藏密码">
				<svg class="gate-eye-shut" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"></path>
					<circle cx="12" cy="12" r="2.8"></circle>
				</svg>
				<svg class="gate-eye-open" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
					<path d="M4 4l16 16"></path>
					<path d="M9.9 5.9A9.7 9.7 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17.3 17.3 0 0 1-3.2 3.9M6.6 7.9A16.8 16.8 0 0 0 2.5 12S6 18.5 12 18.5a9.5 9.5 0 0 0 3.4-.6"></path>
					<path d="M9.9 10.3a2.8 2.8 0 0 0 3.9 3.9"></path>
				</svg>
			</button>
		</div>
		${error}
		${nextInput}
		<button type="submit">进入</button>
	</form>
	<p class="gate-foot">受密码保护 · dsh-access-gate</p>
</main>
<script>
(function () {
	document.body.classList.add("gate-ready");
	var input = document.getElementById("gate-password");
	var eye = document.getElementById("gate-eye");
	if (input && eye) eye.addEventListener("click", function () {
		var show = input.type === "password";
		input.type = show ? "text" : "password";
		eye.classList.toggle("gate-eye-on", show);
		input.focus();
	});
})();
</script>
</body>
</html>`;
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
export async function apply(ctx: PluginContext, config: AuthGateConfig = {}): Promise<void> {
	/**
	 * 当前生效配置的读取源：settings 服务在线时指向 resolved scope（行配置作
	 * base 层 + settings 文档用户覆盖层），服务离线/未装载时回落行配置本身。
	 * 读取方（免密网段 / TTL / config 密码）都经它取值 → 配置层变化实时生效。
	 */
	let current = (): AuthGateConfig => config;
	/** token → 过期时间戳。内存态：进程重启后需重新登录。 */
	const tokens = new Map<string, number>();

	/** 当前生效的密码哈希；null = 未配置密码（放行模式）。 */
	let passwordHash: string | null = null;
	const refreshPassword = async (): Promise<void> => {
		const fromConfig = current().password;
		const fromCredentials = fromConfig !== undefined ? undefined : (await ctx.credentials.resolve(PASSWORD_REF))?.value;
		const password = fromConfig ?? fromCredentials;
		passwordHash = password !== undefined && password !== "" && password !== "change-me" ? sha256Hex(password) : null;
	};
	await refreshPassword();
	// 设置界面（或外部编辑 .credentials.yaml）改密码 → 实时生效。
	ctx.on("credentials/updated", (ref) => {
		if (ref === PASSWORD_REF) void refreshPassword();
	});

	// settings namespace 注册（rc.7 适配，v0.6.0）：官方"插件配置"选项卡只渲染
	// "host serve 的 namespace × client 卡片 key"的交集，不注册本卡片永不出现。
	// wiring 照官方 installSettingsSection（dsh-settings/lib/index.js L618）：
	// 行配置作 base 层，settings 文档作用户覆盖层，服务离线回落行配置。
	ctx.inject(["settings"], (sctx) => {
		const scope = sctx.settings.register(SETTINGS_NAMESPACE, Config, { base: config });
		current = () => scope.get() as AuthGateConfig;
		// 登录页主题同步：读官方 ui-theme namespace（theme 插件注册；未注册
		// 时 get 返回 undefined → 回落 system）。
		themePreference = () => {
			const preference = (sctx.settings.get("ui-theme") as { preference?: unknown } | undefined)?.preference;
			return preference === "light" || preference === "dark" ? preference : "system";
		};
		// settings 层变化（用户覆盖 / 撤销覆盖）→ 重读密码，实时生效。
		scope.watch(() => void refreshPassword());
		// 服务离线（provider 重载等）→ 回落行配置；插件自身卸载时此 disposer
		// 只是覆写一个即将随插件一起消亡的闭包变量，无副作用。
		sctx.effect(() => () => {
			current = () => config;
			themePreference = () => "system";
			void refreshPassword();
		}, "auth-gate: settings source fallback");
		void refreshPassword();
	});

	/** 当前生效的免密网段（仅对非回环来源生效）。 */
	const trustedPrefixes = (): string[] => current().trustedRemotePrefixes ?? [];
	/** 当前生效的登录有效期。 */
	const tokenTtl = (): number => current().tokenTtlMs ?? DEFAULT_TTL_MS;

	/**
	 * 官方主题偏好（ui-theme namespace 的 preference：light/dark/system）。
	 * 登录页深浅模式同步用（v0.6.0）：与官方 index.html 的 bootThemeScript
	 * 读同一持久层（host settings 文档），解析规则同款（system 经
	 * prefers-color-scheme 解析）。settings 服务离线或官方 theme 插件未
	 * 组合时回落 "system"（官方 DEFAULT_PREFERENCE）。
	 */
	let themePreference = (): ThemePreference => "system";

	const isAuthorized = (req: IncomingMessage): boolean => {
		const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
		if (!token) return false;
		const expiresAt = tokens.get(token);
		if (expiresAt === undefined) return false;
		if (expiresAt < Date.now()) {
			tokens.delete(token);
			return false;
		}
		return true;
	};

	/** 放行 = 把请求头改写成 loopback 形态，让 DSH 护栏放行（含特权接口）。 */
	const grantLoopback = (req: IncomingMessage): void => {
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
	const handleLogin = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
		if (req.method === "GET") {
			const nextParam = url.searchParams.get("next");
			const next = typeof nextParam === "string" ? nextParam : "/";
			if (isAuthorized(req)) {
				// 已登录还访问登录页：直接送回原目标。
				try {
					res.writeHead(302, { location: isSafeNext(next) ? next : "/", "cache-control": "no-store" });
					res.end();
				} catch { /* 客户端已断开 */ }
				return true;
			}
			try {
				res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
				res.end(renderLoginPage(isSafeNext(next) ? next : "/", undefined, themePreference()));
			} catch { /* 客户端已断开 */ }
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
						res.end(renderLoginPage(safeNext, "密码错误，请重试", themePreference()));
					} catch { /* 客户端已断开 */ }
					return;
				}
				const token = randomBytes(32).toString("hex");
				const ttlMs = tokenTtl();
				tokens.set(token, Date.now() + ttlMs);
				try {
					res.writeHead(302, {
						location: safeNext,
						"set-cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttlMs / 1000)}`
					});
					res.end();
				} catch { /* 客户端已断开 */ }
			}).catch(() => {
				try {
					res.writeHead(400);
					res.end("bad request");
				} catch { /* 客户端已断开 */ }
			});
			return true;
		}
		try {
			res.writeHead(405);
			res.end();
		} catch { /* 客户端已断开 */ }
		return true;
	};

	/** 普通请求门禁。返回 'pass'（放行，已改写头）或 'handled'（已响应）。 */
	const gateRequest = (req: IncomingMessage, res: ServerResponse): "pass" | "handled" => {
		const remote = req.socket.remoteAddress ?? "";
		// 1) 本机直连（回环来源 + 回环 Host）：完全不干预。
		if (isLoopbackRemote(remote) && isLoopbackAuthority(req.headers.host)) return "pass";
		// 2) 免密网段（仅对非回环来源生效；同机反代不适用，见文件头注释 3b）。
		if (!isLoopbackRemote(remote) && trustedPrefixes().some((cidr) => cidrMatch(remote, cidr))) {
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
		} catch { /* 客户端已断开 */ }
		return "handled";
	};

	/** WebSocket 握手门禁（DSH 的 events.mux / events.host）。 */
	const gateUpgrade = (req: IncomingMessage, socket: Duplex): "pass" | "handled" => {
		const remote = req.socket.remoteAddress ?? "";
		if (isLoopbackRemote(remote) && isLoopbackAuthority(req.headers.host)) return "pass";
		if (!isLoopbackRemote(remote) && trustedPrefixes().some((cidr) => cidrMatch(remote, cidr))) {
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
	// 覆盖 server.emit 做前置拦截。类型上 node:http 的 emit 是复杂重载，
	// 我们只关心 'request'/'upgrade' 两个事件，其余原样转发。
	type ServerEmit = Server["emit"];
	const originalEmit: ServerEmit = server.emit;
	server.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
		if (event === "request") {
			const [req, res] = args as [IncomingMessage, ServerResponse];
			if (gateRequest(req, res) === "handled") return true;
		} else if (event === "upgrade") {
			const [req, socket] = args as [IncomingMessage, Duplex];
			if (gateUpgrade(req, socket) === "handled") return true;
		}
		return originalEmit.call(this, event, ...args);
	} as ServerEmit;

	// 本机原生目录选择路由：仅回环来源可用（远程走官方 browse，见 NOTES §8）。
	// 供客户端壳组件调用 —— 弹官方原生 OS 目录对话框（loader 动态挂载官方
	// native 后端，win32 koffi / darwin osascript / linux zenity-kdialog）。
	// 绕开"auto 因 0.0.0.0 绑定固定选 browse"的限制（根因见 NOTES §8.1）。
	let nativePickerPromise: Promise<NativePicker> | null = null;
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
	const disposeNativePicker = async (): Promise<void> => {
		const current = nativePickerPromise;
		nativePickerPromise = null;
		try {
			await current?.catch(() => null).then((picker) => picker?.dispose());
		} catch {
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
				if (!res.writableEnded) controller.abort();
			});
			try {
				const picker = await getNativePicker();
				let path: string | null = null;
				// 测试模式：不弹真实对话框（自动化环境无法交互），模拟用户取消。
				if (process.env.DSH_GATE_PICKER_TEST !== "1") path = await picker.pick(controller.signal);
				if (res.writableEnded) return;
				res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
				res.end(JSON.stringify({ path }));
			} catch (error) {
				// pick 失败（对话框错误 / 客户端中断 / 挂载失败）：释放 loader
				// entry 并清缓存 —— 残留 entry 会让后续挂载报
				// "service "directoryPicker" has been registered"（死锁直到 DSH
				// 重启，见 native-picker.ts 文件头"残留清理"）。
				await disposeNativePicker();
				if (res.writableEnded) return;
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
	const removePolyfill = ctx.webServer.tapIndex((html) =>
		html.includes("randomUUID") ? html : html.replace("</head>", RANDOM_UUID_POLYFILL_SCRIPT + "</head>")
	);
	ctx.effect(() => removePolyfill, "auth-gate: randomUUID polyfill tap");

	// 卸载/停用时还原 server.emit —— 与 bundle patch 随包消失一起保证零残留。
	ctx.effect(() => () => {
		server.emit = originalEmit;
	}, "auth-gate: restore server.emit");

	ctx.logger?.info?.(`dsh-access-gate: 已启用（密码：${passwordHash === null ? "未配置，远程直接放行" : "已配置，远程需认证"}；${trustedPrefixes().length} 个免密网段；本机原生目录选择；randomUUID polyfill）`);
}
