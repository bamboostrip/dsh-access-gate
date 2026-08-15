/**
 * dsh-auth-gate — 外部契约类型（集中声明对 DSH / node 运行时 API 的依赖）
 *
 * 为什么集中在这里：DSH 是测试版（当前 0.1.0-rc.6），API 可能变化。
 * 每个声明都附"出处"注释（包名 + 源码行号 + 形状说明）。DSH 升级后：
 *   1) 对照出处注释核对新源码，API 变了就改本文件；
 *   2) 本插件所有调用点都使用这些类型 —— 编译器会把需要跟着改的地方
 *      全部标出，不用人肉搜。
 * 类型只影响编译期，编译产物（lib/）不含任何类型信息，运行时零开销。
 */
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";

// ────────────────────────────────────────────────────────────────────────
// node:http 路由形状（dsh-host-webserver 的路由表）
// 出处：@deepseek-ai/dsh-host-webserver/lib/index.js
//   - WebServer.register(route)      L53-60：kind/path/handler，重复注册抛错
//   - WebServer.registerUpgrade()    L67-73：path/handler（WS 协议所有者唯一）
//   - handle(req, res)               L104-120：'request' 事件处理链
//   - server.on("upgrade", ...)      L132-165：'upgrade' 事件处理链
// ────────────────────────────────────────────────────────────────────────

/** HTTP 路由 handler（同步或异步皆可；webserver 会 await）。 */
export type WebRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** WebSocket upgrade handler（head = 握手头之后的残留字节）。 */
export type WebUpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;

/** webserver 注册的命名路由。 */
export interface WebRoute {
	kind: "exact" | "prefix";
	path: string;
	handler: WebRouteHandler;
}

/** webserver 注册的 upgrade 路由。 */
export interface WebUpgradeRoute {
	path: string;
	handler: WebUpgradeHandler;
}

// ────────────────────────────────────────────────────────────────────────
// webServer 服务契约
// 出处：@deepseek-ai/dsh-host-webserver/lib/index.js（WebServer 类 L21-215）
//   - server 字段：L121 `this.server = createServer(...)` —— node:http Server，
//     'request'/'upgrade' 的 listener 都挂它上面（覆盖 server.emit 即可前置拦截）
//   - Config schema：L23-26 { host: "127.0.0.1" | "0.0.0.0", port: number }
// ────────────────────────────────────────────────────────────────────────

export interface WebServerService {
	/** node:http 服务器实例；本插件的 server.emit 覆盖目标。 */
	server: Server;
	/** 注册 HTTP 路由，返回取消函数。 */
	register(route: WebRoute): () => void;
	/** 注册 upgrade 路由，返回取消函数。 */
	registerUpgrade(route: WebUpgradeRoute): () => void;
	/**
	 * 注册 index.html 响应变换（fallback 渲染 index 时按注册序应用），
	 * 返回取消函数。出处：dsh-host-webserver/lib/index.js L95-101。
	 */
	tapIndex(transform: (html: string) => string): () => void;
}

// ────────────────────────────────────────────────────────────────────────
// Cordis 插件上下文（本插件用到的子集）
// 出处：@deepseek-ai/cordis/lib/types/context.d.ts、fiber.d.ts、logger.d.ts
//   - ctx.plugin(inject: [webServer]) → apply 执行前 webServer 必已可用
//   - ctx.effect(callback, name) → 返回 disposer；插件卸载时按逆序执行
// ────────────────────────────────────────────────────────────────────────

export interface PluginContext {
	/** 因 inject: [webServer]，此处非可选。 */
	webServer: WebServerService;
	/**
	 * 注册 fiber 清理回调。本插件用法：`ctx.effect(() => () => { ...还原... }, name)`。
	 * 卸载/停用/热更新时执行返回的 disposer。
	 */
	effect<T extends () => unknown>(callback: () => T, name?: string): ReturnType<T>;
	/** 内置 logger（cordis 核心自带，可选访问以防未来移除）。 */
	logger?: {
		info?(message: string): void;
		warn?(message: unknown): void;
	};
}

// ────────────────────────────────────────────────────────────────────────
// 本插件行配置（cordis.patch.yml 的 auth-gate 行 config）
// ────────────────────────────────────────────────────────────────────────

export interface AuthGateConfig {
	/** 访问密码；缺省回落到 process.env.DSH_GATE_PASSWORD；两者皆无则拒绝启动。 */
	password?: string;
	/** 免密网段（IPv4 CIDR，如 '10.144.144.0/24'），仅对非回环来源生效。 */
	trustedRemotePrefixes?: string[];
	/** 登录有效期毫秒，默认 7 天。 */
	tokenTtlMs?: number;
}
