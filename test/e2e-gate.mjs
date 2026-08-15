/**
 * dsh-auth-gate — 真机级 E2E 验证（使用真实 DSH 模块，不碰线上实例）
 *
 * 用本机安装的 DSH 0.1.0-rc.6 真实模块搭隔离实例（随机端口）：
 *   - baseline：dsh-host-webserver + dsh-client-connection（复现 403 护栏）
 *   - gated：baseline + 本插件（server.emit 门禁，加载 lib/index.js 编译产物）
 * 假 apiProxy 提供最小 RPC 域方法，让真实 bridge / toFetchHandler / ws downlink
 * 完整跑通。请求来源用本机 LAN IP（10.144.144.7）模拟"非回环远程"，用 127.0.0.1
 * 模拟本机直连。
 *
 * 运行：node test/e2e-gate.mjs   （Node ≥ 22；49 项断言）
 * 依赖：本机 DSH 安装路径（见 DSH_MODULES），与 NOTES.md 第 2 节相同。
 * 注意：改 src/*.ts 后先 npm run build，本测试测的是构建产物。
 */

import { request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

// ── 真实 DSH 模块（绝对路径导入，传递依赖从 DSH 树内解析）──────────────────
const DSH_MODULES = "C:/Users/Bambo/AppData/Roaming/fnm/node-versions/v24.18.0/installation/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
const toUrl = (p) => pathToFileURL(p).href;
const { Context } = await import(toUrl(`${DSH_MODULES}/cordis/lib/index.js`));
const { default: WebServer } = await import(toUrl(`${DSH_MODULES}/dsh-host-webserver/lib/index.js`));
const { default: Loader } = await import(toUrl(`${DSH_MODULES}/cordis-plugin-loader/lib/index.js`));
const connection = await import(toUrl(`${DSH_MODULES}/dsh-client-connection/lib/index.js`));
const gate = await import("../lib/index.js");

// ── 假 apiProxy：满足 toFetchHandler / handleUnary / ws downlink 的最小域 ──
function ok(r, value) {
	return { rpcId: r.rpcId, result: { ok: true, value } };
}
const fakeApi = {
	host: {
		describe: async (r) => ok(r, { version: "e2e", cwd: process.cwd(), attachedSessions: 0, canOpenPath: false }),
		pickDirectory: async (r) => ok(r, { path: null }),
		openPath: async (r) => ok(r, { ok: true })
	},
	settings: {
		describe: async (r) => ok(r, { namespaces: [] }),
		openDocument: async (r) => ok(r, { path: "n/a" }),
		update: async (r) => ok(r, { revision: 1 }),
		replace: async (r) => ok(r, { revision: 1 }),
		mutate: async (r) => ok(r, { revision: 1 })
	},
	credentials: {
		describe: async (r) => ok(r, { credentials: {} }),
		set: async (r) => ok(r, {}),
		unset: async (r) => ok(r, {})
	},
	llm: {
		discoverModels: async (r) => ok(r, { models: [] })
	},
	agentPreset: {
		read: async (r) => ok(r, null),
		copy: async (r) => ok(r, null),
		openDocument: async (r) => ok(r, null),
		remove: async (r) => ok(r, null)
	},
	events: {
		mux: async function* () {},
		host: async function* () {}
	},
	downloads: { sessionLog: async () => new Response("no", { status: 404 }) },
	respond: async () => ({ accepted: false, reason: "test-only" })
};
const fakeApiProxyPlugin = {
	name: "fake-api-proxy",
	apply(ctx) {
		ctx.provide("apiProxy", fakeApi);
	}
};

// ── 假 credentials 服务（模拟 dsh-credentials-local 的层级与事件）─────────
// 层级：进程环境变量（env，只读）> 内部 Map（file，可写）。
function makeFakeCredentialsPlugin(init = {}) {
	const values = new Map(Object.entries(init));
	return {
		name: "fake-credentials",
		apply(ctx) {
			ctx.provide("credentials", {
				async resolve(ref) {
					const fromEnv = process.env[ref];
					if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
					const stored = values.get(ref);
					return stored === undefined ? undefined : { value: stored, source: "file" };
				},
				async describe(ref) {
					if (process.env[ref] !== undefined) return { configured: true, source: "env", writable: false };
					return { configured: values.has(ref), source: values.has(ref) ? "file" : void 0, writable: true };
				},
				async set(ref, value) {
					values.set(ref, value);
					ctx.emit("credentials/updated", ref);
				},
				async unset(ref) {
					values.delete(ref);
					ctx.emit("credentials/updated", ref);
				}
			});
		}
	};
}

// ── 搭一个隔离实例 ────────────────────────────────────────────────────────
async function setup({ withGate, gateConfig, credentialsInit }) {
	const ctx = new Context();
	await ctx.plugin(WebServer, { host: "0.0.0.0", port: 0 });
	// 真实 loader 服务（cordis-plugin-loader）：gate 插件 inject 需要它，
	// 且 pick 路由通过它动态挂载官方 native 后端（真实验证，见用例 20b）。
	// baseUrl 指向 DSH 树：官方包的裸名从此解析（真实 DSH 环境的 loader
	// 由 dsh-app-boot 配置了同样的解析锚点）。
	new Loader(ctx, { baseUrl: toUrl(DSH_MODULES) + "/" });
	await ctx.plugin(makeFakeCredentialsPlugin(credentialsInit));
	await ctx.plugin(fakeApiProxyPlugin);
	await ctx.plugin(connection, { trustedHosts: [], maxRequestBodyBytes: 16 * 1024 * 1024 });
	if (withGate) await ctx.plugin(gate, gateConfig ?? { tokenTtlMs: 3600_000 });
	// 触发 webServer init（懒加载）并等待端口就绪
	const server = ctx.webServer.server;
	const port = await new Promise((resolve, reject) => {
		const t0 = Date.now();
		const timer = setInterval(() => {
			const addr = server.address?.();
			if (addr) { clearInterval(timer); resolve(addr.port); }
			else if (Date.now() - t0 > 8000) { clearInterval(timer); reject(new Error("webserver listen timeout")); }
		}, 40);
	});
	// 诊断路由：回显 socket 来源与（改写后的）请求头 —— 直接证明头改写发生在 node:http 层
	ctx.webServer.register({
		kind: "exact",
		path: "/-/echo",
		handler: (req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({
				remote: req.socket.remoteAddress,
				host: req.headers.host ?? null,
				origin: req.headers.origin ?? null,
				url: req.url
			}));
		}
	});
	// 模拟 SPA fallback（官方由 dsh-web-app 提供）：渲染 index 时应用
	// tapIndex 变换（官方 frontend-static 的行为），供 polyfill 注入测试。
	ctx.webServer.registerFallback((req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(ctx.webServer.applyIndexTaps("<!DOCTYPE html><html><head></head><body>dsh e2e shell</body></html>"));
	});
	return { ctx, port };
}

// ── HTTP 请求助手（可显式设 Host / Origin / Cookie，模拟 curl）──────────────
function rawRequest({ port, via, host, method, path, headers = {}, body }) {
	return new Promise((resolve, reject) => {
		const req = httpRequest(
			{ host: via, port, localAddress: via, method, path, setHost: false, headers: { host, ...headers } },
			(res) => {
				const chunks = [];
				res.on("data", (c) => chunks.push(c));
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
			}
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

// ── WebSocket 握手助手（原始 socket，可控全部头）───────────────────────────
function wsUpgrade({ port, via, path, host, cookie }) {
	return new Promise((resolve, reject) => {
		const socket = netConnect({ host: via, port, localAddress: via });
		let buf = "";
		const done = (v) => { socket.destroy(); resolve(v); };
		socket.setTimeout(5000, () => { socket.destroy(); reject(new Error("ws handshake timeout")); });
		socket.on("connect", () => {
			socket.write([
				`GET ${path} HTTP/1.1`,
				`Host: ${host}`,
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
				"Sec-WebSocket-Version: 13",
				...(cookie ? [`Cookie: ${cookie}`] : []),
				"",
				""
			].join("\r\n"));
		});
		socket.on("data", (d) => {
			buf += d.toString("latin1");
			const idx = buf.indexOf("\r\n\r\n");
			if (idx !== -1) done({ statusLine: buf.slice(0, idx).split("\r\n")[0] });
		});
		socket.on("error", reject);
	});
}

// ── 断言收集器 ────────────────────────────────────────────────────────────
const results = [];
function check(desc, actual, expected, extra = "") {
	const pass = typeof expected === "function" ? expected(actual) : actual === expected;
	results.push({ desc, pass, actual: typeof actual === "string" ? actual : JSON.stringify(actual), expected: typeof expected === "function" ? "(predicate)" : String(expected), extra });
}
const hasStatus = (status) => (r) => r.status === status;
const hasBody = (needle) => (r) => r.body.includes(needle);
const strContains = (needle) => (s) => typeof s === "string" && s.includes(needle);
const jsonOk = (r) => { try { return JSON.parse(r.body).result?.ok === true; } catch { return false; } };

const DOMAIN = "codsh.famlife.top";
const rpc = (method, payload = {}) => JSON.stringify({ type: "client-request", rpcId: "t", method, payload });

// ── 主体 ──────────────────────────────────────────────────────────────────
const LAN = "10.144.144.7"; // 本机 LAN IP（模拟非回环远程来源）
const LOCAL = "127.0.0.1";

const base = await setup({ withGate: false });
// 测试模式：pick 路由不弹真实对话框（自动化环境无法交互），模拟取消。
process.env.DSH_GATE_PICKER_TEST = "1";
// gated：默认无密码 → 先验证"放行模式"，再 set 密码验证"实时生效 + 密码模式"。
const gated = await setup({ withGate: true });
// gatedCidr：预置密码（免密网段在密码模式下仍应放行）。
const gatedCidr = await setup({ withGate: true, gateConfig: { trustedRemotePrefixes: ["10.144.144.0/24"], tokenTtlMs: 3600_000 }, credentialsInit: { DSH_GATE_PASSWORD: "s3cret-pass-123" } });
// gatedEnv：进程环境变量提供密码（credentials 的 env 层，模拟官方层级）。
process.env.DSH_GATE_PASSWORD = "env-pass-456";
const gatedEnv = await setup({ withGate: true, gateConfig: {} });
delete process.env.DSH_GATE_PASSWORD;

console.log(`baseline :${base.port}  gated :${gated.port}  gated-cidr :${gatedCidr.port}  gated-env :${gatedEnv.port}  远程来源=${LAN}`);

// ========== 阶段 1：baseline —— 复现 403 护栏 ==========
{
	// 1. 远程 + 域名 Host + Origin → 403（这就是用户遇到的 bug）
	const r = await rawRequest({ port: base.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}`, "sec-fetch-site": "same-origin" }, body: rpc("host.describe") });
	check("[baseline] 远程 POST host.describe（域名 Host+Origin）→ 403", r.status, 403);
	check("[baseline] 403 响应体为 forbidden", r, hasBody("forbidden"));

	// 2. 远程 + 特权方法 settings.describe → 403（特权白名单钉死 loopback）
	const r2 = await rawRequest({ port: base.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/settings.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}` }, body: rpc("settings.describe") });
	check("[baseline] 远程 POST settings.describe（特权）→ 403", r2.status, 403);

	// 3. 本机直连 Host=127.0.0.1 → 护栏放行 → RPC 正常（假 apiProxy 回 200）
	const r3 = await rawRequest({ port: base.port, via: LOCAL, host: `127.0.0.1:${base.port}`, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json" }, body: rpc("host.describe") });
	check("[baseline] 本机 POST host.describe → 200 server-response", r3, jsonOk);
	check("[baseline] 本机响应体含 server-response", r3, hasBody('"type":"server-response"'));

	// 4. 远程 WS → 403
	const w1 = await wsUpgrade({ port: base.port, via: LAN, path: "/api/events.mux", host: DOMAIN });
	check("[baseline] 远程 WS /api/events.mux → 403", w1.statusLine, "HTTP/1.1 403 Forbidden");

	// 5. 本机 WS → 101
	const w2 = await wsUpgrade({ port: base.port, via: LOCAL, path: "/api/events.mux", host: `127.0.0.1:${base.port}` });
	check("[baseline] 本机 WS /api/events.mux → 101", w2.statusLine, "HTTP/1.1 101 Switching Protocols");
}

// ========== 阶段 2：gated —— 默认无密码放行 → 设置密码实时生效 → 密码模式 ==========
let cookie = "";
{
	// 6. 默认无密码：远程直接放行（等价纯 lan-access）
	const rFree = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}` }, body: rpc("host.describe") });
	check("[gated] 无密码：远程 POST host.describe（域名+Origin）→ 200", rFree, jsonOk);
	const wFree = await wsUpgrade({ port: gated.port, via: LAN, path: "/api/events.mux", host: DOMAIN });
	check("[gated] 无密码：远程 WS → 101", wFree.statusLine, "HTTP/1.1 101 Switching Protocols");

	// 7. 设置密码（模拟设置界面保存 → credentials/updated 事件）→ 实时生效，无需重启
	await gated.ctx.credentials.set("DSH_GATE_PASSWORD", "s3cret-pass-123");
	const r0 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/" });
	check("[gated] 设置密码后（未重启）远程 GET / → 302 立即生效", r0.status, 302);

	// 8. 远程未认证 GET / → 302 登录页
	const r = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/" });
	check("[gated] 远程 GET /（未认证）→ 302", r.status, 302);
	check("[gated] 302 Location 指向登录页", r.headers.location, strContains("/-/auth/login?next=%2F"));

	// 9. 登录页 HTML
	const r2 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/-/auth/login?next=/" });
	check("[gated] 登录页 → 200 且含标题", r2, (x) => x.status === 200 && x.body.includes("DSH 访问认证"));

	// 10. 错误密码 → 401
	const bad = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/auth/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=wrong&next=/" });
	check("[gated] 错误密码 → 401", bad.status, 401);

	// 11. 正确密码 → 302 + Set-Cookie
	const good = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/auth/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=s3cret-pass-123&next=/" });
	check("[gated] 正确密码 → 302", good.status, 302);
	const setCookie = Array.isArray(good.headers["set-cookie"]) ? good.headers["set-cookie"][0] : String(good.headers["set-cookie"] ?? "");
	check("[gated] Set-Cookie 带 HttpOnly+SameSite", setCookie, (s) => strContains("dsh_gate_token=")(s) && strContains("HttpOnly")(s) && strContains("SameSite=Lax")(s));
	cookie = setCookie.split(";")[0];

	// 12. 带 cookie 的远程 RPC（域名 Host + Origin + sec-fetch-site）→ 200 ← 核心证明
	const r3 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}`, "sec-fetch-site": "same-origin", cookie }, body: rpc("host.describe") });
	check("[gated] 远程+域名+Origin+带cookie POST host.describe → 200", r3, jsonOk);

	// 12b. 认证后 cross-site 请求不再被护栏误杀（头改写 + sec-fetch-site 删除）
	const rCross = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", "sec-fetch-site": "cross-site", cookie }, body: rpc("host.describe") });
	check("[gated] 带cookie + sec-fetch-site:cross-site → 200（护栏不再误杀）", rCross, jsonOk);

	// 13. 特权方法（白名单钉死 loopback）→ 全部 200
	for (const m of ["settings.describe", "credentials.describe", "llm.discoverModels", "host.pickDirectory", "host.openPath"]) {
		const payload = m === "credentials.describe" ? { refs: ["VISION_API_KEY"] }
			: m === "llm.discoverModels" ? { settingsNs: "llm" }
			: m === "host.openPath" ? { path: "C:/Windows" }
			: {};
		const r = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: `/api/${m}`, headers: { "content-type": "application/json", origin: `https://${DOMAIN}`, cookie }, body: rpc(m, payload) });
		check(`[gated] 远程特权方法 ${m}（带cookie）→ 200`, r, jsonOk);
	}

	// 14. 垃圾 cookie → 302
	const r4 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", cookie: "dsh_gate_token=deadbeef" }, body: rpc("host.describe") });
	check("[gated] 伪造 cookie → 302", r4.status, 302);

	// 15. 本机直连（回环来源 + 回环 Host）免密放行 → 200
	const r5 = await rawRequest({ port: gated.port, via: LOCAL, host: `127.0.0.1:${gated.port}`, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json" }, body: rpc("host.describe") });
	check("[gated] 本机 POST host.describe（无cookie）→ 200", r5, jsonOk);

	// 14. 回环来源 + 域名 Host（同机 nginx 反代模拟）→ 未认证 302，带 cookie 200
	const r6 = await rawRequest({ port: gated.port, via: LOCAL, host: DOMAIN, method: "GET", path: "/" });
	check("[gated] 同机反代（回环来源+域名Host）未认证 → 302", r6.status, 302);
	const r7 = await rawRequest({ port: gated.port, via: LOCAL, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}`, cookie }, body: rpc("host.describe") });
	check("[gated] 同机反代 + cookie → 200", r7, jsonOk);

	// 15. 非回环来源伪造 Host: 127.0.0.1 → 未认证 302（封住 Host 欺骗穿护栏）
	const r8 = await rawRequest({ port: gated.port, via: LAN, host: "127.0.0.1", method: "POST", path: "/api/settings.describe", headers: { "content-type": "application/json" }, body: rpc("settings.describe") });
	check("[gated] 远程伪造 Host:127.0.0.1（无cookie）→ 302", r8.status, 302);

	// 16. /-/echo：带 cookie 的远程请求 —— 直接证明 node:http 层头改写
	const r9 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/-/echo", headers: { cookie } });
	const echo = JSON.parse(r9.body);
	check("[gated] echo.remote = LAN IP（来源分类正确）", echo.remote, LAN);
	check("[gated] echo.host 已被改写为 127.0.0.1", echo.host, "127.0.0.1");
	check("[gated] echo.origin 已被删除", echo.origin, null);

	// 17. next 参数安全：//evil 被归一化
	const evil = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/auth/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=s3cret-pass-123&next=//evil.example" });
	check("[gated] next=//evil 被归一化为 /", evil.headers.location, "/");

	// 18. WS：远程未认证 403；带 cookie 101；本机 101
	const w1 = await wsUpgrade({ port: gated.port, via: LAN, path: "/api/events.mux", host: DOMAIN });
	check("[gated] 远程 WS 未认证 → 403", w1.statusLine, "HTTP/1.1 403 Forbidden");
	const w2 = await wsUpgrade({ port: gated.port, via: LAN, path: "/api/events.host", host: DOMAIN, cookie });
	check("[gated] 远程 WS 带cookie → 101", w2.statusLine, "HTTP/1.1 101 Switching Protocols");
	const w3 = await wsUpgrade({ port: gated.port, via: LOCAL, path: "/api/events.mux", host: `127.0.0.1:${gated.port}` });
	check("[gated] 本机 WS → 101", w3.statusLine, "HTTP/1.1 101 Switching Protocols");

	// 19. 已登录访问登录页 → 302 跳回
	const r10 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/-/auth/login?next=/workspace", headers: { cookie } });
	check("[gated] 已登录访问登录页 → 302", r10.status, 302);
	check("[gated] 登录页跳回 location=/workspace", r10.headers.location, "/workspace");

	// 20. 本机原生目录选择路由（客户端壳调用）
	const r11 = await rawRequest({ port: gated.port, via: LOCAL, host: `127.0.0.1:${gated.port}`, method: "POST", path: "/-/gate/pick-directory" });
	check("[gated] 本机 pick-directory → 200 {path:null}（test 模式模拟取消）", r11, (x) => x.status === 200 && JSON.parse(x.body).path === null);
	const r12 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/gate/pick-directory" });
	check("[gated] 远程未认证 pick-directory → 302（gate 拦截）", r12.status, 302);
	const r13 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/gate/pick-directory", headers: { cookie } });
	check("[gated] 远程带cookie pick-directory → 403（路由内回环钉死）", r13.status, 403);

	// 20b. 真实 loader 挂载官方 native 后端（isolate realm）—— 上一步已触发 lazy 挂载
	const nativeEntries = Object.entries(gated.ctx.loader.store).filter(([, e]) => e.ctx?.directoryPicker !== undefined);
	check("[gated] loader 已挂载官方 native 后端 entry", nativeEntries.length, (n) => n >= 1);
	if (nativeEntries.length > 0) {
		const capability = nativeEntries[0][1].ctx.directoryPicker.capability();
		check("[gated] 挂载的 capability.kind === native（官方实现，跨平台）", capability.kind, "native");
		check("[gated] capability 提供 pick 函数", typeof capability.pick, "function");
	}

	// 21. randomUUID polyfill 注入（替代 dsh-lan-access 的职责）
	const r14 = await rawRequest({ port: gated.port, via: LAN, host: DOMAIN, method: "GET", path: "/", headers: { cookie } });
	check("[gated] 带cookie GET / → 200 index HTML", r14.status, 200);
	check("[gated] index 注入 randomUUID polyfill 脚本", r14, hasBody("randomUUID"));
	check("[gated] polyfill 幂等守卫存在（不覆盖已存在的实现）", r14, hasBody('typeof crypto.randomUUID !== "function"'));
}

// ========== 阶段 3：免密网段 + 环境变量密码 ==========
{
	// 20. 命中 trustedRemotePrefixes 的 LAN 来源免密放行
	const r = await rawRequest({ port: gatedCidr.port, via: LAN, host: DOMAIN, method: "POST", path: "/api/host.describe", headers: { "content-type": "application/json", origin: `https://${DOMAIN}` }, body: rpc("host.describe") });
	check("[cidr] LAN 来源命中 10.144.144.0/24 → 免密 200", r, jsonOk);

	// 21. CIDR 外的来源（本机另一网卡 192.168.1.3）→ 仍需认证
	try {
		const r2 = await rawRequest({ port: gatedCidr.port, via: "192.168.1.3", host: DOMAIN, method: "GET", path: "/" });
		check("[cidr] CIDR 外来源（192.168.1.3）→ 302 登录", r2.status, 302);
	} catch {
		check("[cidr] CIDR 外来源（192.168.1.3）→ 302 登录", "SKIP：该网卡当前不可达", (s) => s.startsWith("SKIP"));
	}

	// 22. 环境变量密码回退（config.password 缺省）
	const r3 = await rawRequest({ port: gatedEnv.port, via: LAN, host: DOMAIN, method: "POST", path: "/-/auth/login", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "password=env-pass-456&next=/" });
	check("[env] DSH_GATE_PASSWORD 登录 → 302", r3.status, 302);
	const r4 = await rawRequest({ port: gatedEnv.port, via: LAN, host: DOMAIN, method: "GET", path: "/-/auth/login", headers: { cookie: String(r3.headers["set-cookie"]).split(";")[0] } });
	check("[env] 该 cookie 有效（访问登录页跳走）", r4.status, 302);
}

// ── 收尾 ──────────────────────────────────────────────────────────────────
for (const c of [base, gated, gatedCidr, gatedEnv]) {
	try { c.ctx.webServer.server.closeAllConnections?.(); } catch {}
	await new Promise((resolve) => c.ctx.webServer.server.close(() => resolve()));
}

let failed = 0;
console.log("\n==== 结果 ====");
for (const r of results) {
	console.log(`${r.pass ? "PASS" : "FAIL"}  ${r.desc}`);
	if (!r.pass) {
		failed++;
		console.log(`      期望: ${r.expected}`);
		console.log(`      实际: ${r.actual}${r.extra ? `  (${r.extra})` : ""}`);
	}
}
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
