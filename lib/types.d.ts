/**
 * dsh-access-gate — 外部契约类型（集中声明对 DSH / node 运行时 API 的依赖）
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
export interface CredentialsService {
    /** 解析引用对应的值；未配置返回 undefined。 */
    resolve(ref: string): Promise<{
        value: string;
        source: string;
    } | undefined>;
    /** 描述配置状态（配置界面 badge 用）。 */
    describe(ref: string): Promise<{
        configured: boolean;
        source?: string;
        writable: boolean;
    }>;
    /** 写入（空值拒绝，用 unset 清除）。 */
    set(ref: string, value: string): Promise<void>;
    /** 清除。 */
    unset(ref: string): Promise<void>;
}
export interface LoaderService {
    /** 创建（或复用）一个 loader entry，返回其 id；加载完成才 resolve。 */
    create(options: {
        name: string;
        isolate?: Record<string, string>;
    }): Promise<string>;
    /** 卸载 entry（dispose fiber + 移除）。 */
    remove(id: string): Promise<void>;
    /** id → Entry 表。 */
    store: Record<string, LoaderEntry>;
}
export interface LoaderEntry {
    /** entry id（loader.store 的键；含父级前缀的完整 id）。 */
    id: string;
    /** entry 配置（create 时传入的 options；isolate 标签用于残留清扫）。 */
    options?: {
        name?: string;
        isolate?: Record<string, string | true>;
    };
    /**
     * entry 的插件 fiber。服务 provide 的原始记录在 fiber.store[name]：
     * `{ name, value, fiber, check }`（cordis ReflectService.provide L799-823）。
     * 读 entry 内服务用这里 —— entry.ctx 的属性读取会触发 cordis 的注入检查
     * （真实应用 loader 以插件挂载时抛 "cannot get property ... without inject"）。
     */
    fiber?: {
        store?: Record<string, {
            value: DirectoryPickerService;
        }>;
    };
    ctx: PluginContext & {
        directoryPicker?: DirectoryPickerService;
    };
}
/** directoryPicker seam 能力（官方 dsh-host-directory-picker 的 capability 判别联合）。 */
export type DirectoryPickerCapability = {
    kind: "native";
    pick(signal?: AbortSignal): Promise<string | null>;
} | {
    kind: "browse";
    list(path: string | undefined, signal?: AbortSignal): Promise<unknown>;
    createDirectory(path: string, name: string): Promise<string>;
};
export interface DirectoryPickerService {
    capability(): DirectoryPickerCapability;
}
export interface AuthGateConfig {
    /** 访问密码；缺省回落到 process.env.DSH_GATE_PASSWORD；两者皆无则拒绝启动。 */
    password?: string;
    /** 免密网段（IPv4 CIDR，如 '10.144.144.0/24'），仅对非回环来源生效。 */
    trustedRemotePrefixes?: string[];
    /** 登录有效期毫秒，默认 7 天。 */
    tokenTtlMs?: number;
}
