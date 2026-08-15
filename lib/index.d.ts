import type { AuthGateConfig, PluginContext } from "./types.js";
/** 稳定插件名（bundle patch 的 name 字段引用它）。 */
export declare const name = "dsh-auth-gate";
/** 需要 webServer（路由/emit 拦截）、loader（官方 native 后端）、credentials（密码）就绪。 */
export declare const inject: string[];
/** 访问密码的 credential 引用（设置界面 / 环境变量共用此名）。 */
export declare const PASSWORD_REF = "DSH_GATE_PASSWORD";
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
export declare function apply(ctx: PluginContext, config?: AuthGateConfig): Promise<void>;
