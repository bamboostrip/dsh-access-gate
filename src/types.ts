/**
 * dsh-access-gate — 外部契约类型（集中声明对 DSH / node 运行时 API 的依赖）
 *
 * 为什么集中在这里：DSH 是测试版（当前 0.1.0-rc.7），API 可能变化。
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
	 * 因 inject: [loader]，此处非可选（cordis-plugin-loader 提供的服务）。
	 * 用于动态挂载官方 native 目录选择后端到 isolate 作用域（见 native-picker.ts）。
	 */
	loader: LoaderService;
	/**
	 * 因 inject: [credentials]，此处非可选（dsh-credentials seam）。
	 * 访问密码存 credentials 域（设置界面写入 ~/.dsh/.credentials.yaml；
	 * 进程环境变量天然优先，DSH_GATE_PASSWORD 依旧生效）。
	 */
	credentials: CredentialsService;
	/**
	 * 注册 fiber 清理回调。三种用法：
	 *   - `ctx.effect(() => disposer, name)`：callback 返回清理函数（同步）；
	 *   - `ctx.effect(async () => { ...; return disposer; }, name)`：callback
	 *     可异步，resolve 出的函数作为 disposer（官方 auto 的用法）；
	 *   - `ctx.effect(() => value, name)`：注册值型副作用（如路由 disposer）。
	 * 卸载/停用/热更新时按注册逆序执行 disposer。
	 */
	effect<T>(callback: () => T | Promise<T>, name?: string): T;
	/**
	 * 注入式服务依赖：所列服务就绪时执行 callback（服务已在线则立即），
	 * 服务离线时执行其返回的清理函数并等待服务回归后重跑。官方
	 * installSettingsSection 即用此机制挂 settings（弱依赖，服务不存在
	 * 时插件照常工作）。
	 * 出处：@deepseek-ai/cordis 的 Context.inject；dsh-settings/lib/index.js
	 *   installSettingsSection L618-636（用法范式）。
	 */
	inject(deps: ["settings"], callback: (ctx: PluginContext & { settings: SettingsService }) => unknown): () => void;
	/** 订阅事件（credentials/updated 等）。 */
	on(event: string, listener: (...args: unknown[]) => unknown): () => void;
	/** 发布事件。 */
	emit(event: string, ...args: unknown[]): void;
	/** 内置 logger（cordis 核心自带，可选访问以防未来移除）。 */
	logger?: {
		info?(message: string): void;
		warn?(message: unknown): void;
	};
}

// ────────────────────────────────────────────────────────────────────────
// credentials 服务契约（dsh-credentials seam + dsh-credentials-local）
// 出处：@deepseek-ai/dsh-credentials/lib/index.js（服务名 "credentials"、
//   credentials/updated 事件 L43-59）；dsh-credentials-local/lib/index.js
//   （resolve L234 / describe L252 / set L274 / unset L278；层级：进程环境
//   > $DSH_HOME/.credentials.yaml > 调用目录 .env > $DSH_HOME/.env）
// ────────────────────────────────────────────────────────────────────────

export interface CredentialsService {
	/** 解析引用对应的值；未配置返回 undefined。 */
	resolve(ref: string): Promise<{ value: string; source: string } | undefined>;
	/** 描述配置状态（配置界面 badge 用）。 */
	describe(ref: string): Promise<{ configured: boolean; source?: string; writable: boolean }>;
	/** 写入（空值拒绝，用 unset 清除）。 */
	set(ref: string, value: string): Promise<void>;
	/** 清除。 */
	unset(ref: string): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────
// loader 服务契约（cordis-plugin-loader）
// 出处：@deepseek-ai/cordis-plugin-loader/lib/index.js
//   - Loader extends EntryTree：L658；构造时 ctx.reflect.provide("loader", ...) L674
//   - EntryGroup.create(options) → 返回 entry.id（L48-62）
//   - EntryGroup.remove(id)（L68-75）；EntryTree.store[id] → Entry（L51）
//   - Entry.ctx：loader.ctx.extend(...)（L338）；Entry.fiber：插件 fiber（L329）
//   - isolate 选项：entry.options.isolate → 服务隔离 realm（isolate.js L577-650，
//     字符串 label = 共享 GlobalRealm，true = entry 私有 LocalRealm）
// ────────────────────────────────────────────────────────────────────────

export interface LoaderService {
	/** 创建（或复用）一个 loader entry，返回其 id；加载完成才 resolve。 */
	create(options: { name: string; isolate?: Record<string, string> }): Promise<string>;
	/** 卸载 entry（dispose fiber + 移除）。 */
	remove(id: string): Promise<void>;
	/** id → Entry 表。 */
	store: Record<string, LoaderEntry>;
}

export interface LoaderEntry {
	/** entry id（loader.store 的键；含父级前缀的完整 id）。 */
	id: string;
	/** entry 配置（create 时传入的 options；isolate 标签用于残留清扫）。 */
	options?: { name?: string; isolate?: Record<string, string | true> };
	/**
	 * entry 的插件 fiber。服务 provide 的原始记录在 fiber.store[name]：
	 * `{ name, value, fiber, check }`（cordis ReflectService.provide L799-823）。
	 * 读 entry 内服务用这里 —— entry.ctx 的属性读取会触发 cordis 的注入检查
	 * （真实应用 loader 以插件挂载时抛 "cannot get property ... without inject"）。
	 */
	fiber?: {
		store?: Record<string, { value: DirectoryPickerService }>;
	};
	ctx: PluginContext & { directoryPicker?: DirectoryPickerService };
}

/** directoryPicker seam 能力（官方 dsh-host-directory-picker 的 capability 判别联合）。 */
export type DirectoryPickerCapability =
	| { kind: "native"; pick(signal?: AbortSignal): Promise<string | null> }
	| { kind: "browse"; list(path: string | undefined, signal?: AbortSignal): Promise<unknown>; createDirectory(path: string, name: string): Promise<string> };

export interface DirectoryPickerService {
	capability(): DirectoryPickerCapability;
}

// ────────────────────────────────────────────────────────────────────────
// settings 服务契约（dsh-settings seam + dsh-settings-file provider）
// 出处：@deepseek-ai/dsh-settings/lib/index.js（服务名 "settings"，L273 起）
//   - register(ns, schema, options)  L311-344：注册 namespace schema，
//     返回 owner scope；registration 挂调用方 fiber，卸载即撤销
//   - describe(options)              L352-381：全部已注册 namespace 的描述符
//     （官方"插件配置"选项卡的数据源 —— ns 不在表中卡片就不出现）
//   - installSettingsSection         L618-636：官方 wiring 范式
//     （ctx.inject(["settings"]) + 行配置作 base 层 + 服务离线回落）
// ────────────────────────────────────────────────────────────────────────

/** settings namespace 注册返回的 owner scope。 */
export interface SettingsNamespaceScope {
	/** namespace 当前解析值（base 层 + settings 文档用户层，经 schema 解析）。 */
	get(): unknown;
	/** 订阅解析值变化；registration 撤销时自动清理。 */
	watch(callback: () => void): () => void;
}

/** settings 服务（namespace 注册表；wire 面 settings.describe 的数据源）。 */
export interface SettingsService {
	/**
	 * 注册一个 namespace；重复注册抛错。schema 为 schemastery 可调用对象
	 * （本插件经 devDependency @deepseek-ai/schemastery 构造，运行时从
	 * DSH 安装树解析）。options.base 为组合层配置（bundle patch 行 config）。
	 */
	register(ns: string, schema: unknown, options?: { base?: unknown; validate?: (value: unknown) => void }): SettingsNamespaceScope;
	/**
	 * 读任意已注册 namespace 的当前解析值（不限于本插件注册的）。
	 * 出处：dsh-settings/lib/index.js L384-387（get(ns) → resolved）。
	 * 登录页主题同步用它读官方 ui-theme namespace 的 preference。
	 */
	get(ns: string): unknown;
}

// ────────────────────────────────────────────────────────────────────────
// 官方主题偏好（dsh-client-ui-theme）
// 出处：dsh-client-ui-theme/lib/index.js L9-23
//   - THEME_PREFERENCES = ['light','dark','system']，DEFAULT_PREFERENCE='system'
//   - 持久层：settings namespace "ui-theme" 的 preference 字段（host 侧文档）
//   - index.html 注入 bootThemeScript：system 经 matchMedia 解析 →
//     <html>.style.colorScheme + <body> 的 data-ds-dark-theme 布尔标记
// ────────────────────────────────────────────────────────────────────────

/** dsh 的主题偏好（登录页与官方前端同步深浅模式的依据）。 */
export type ThemePreference = "light" | "dark" | "system";

// ────────────────────────────────────────────────────────────────────────
// 本插件行配置（cordis.patch.yml 的 auth-gate 行 config；v0.6.0 起同时是
// settings namespace dsh-access-gate 的 base 层，settings 文档可覆盖）
// ────────────────────────────────────────────────────────────────────────

export interface AuthGateConfig {
	/** 访问密码；缺省回落到 process.env.DSH_GATE_PASSWORD；两者皆无则拒绝启动。 */
	password?: string;
	/** 免密网段（IPv4 CIDR，如 '10.144.144.0/24'），仅对非回环来源生效。 */
	trustedRemotePrefixes?: string[];
	/** 登录有效期毫秒，默认 7 天。 */
	tokenTtlMs?: number;
}
