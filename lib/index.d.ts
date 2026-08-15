import type { AuthGateConfig, PluginContext } from "./types.js";
/** 稳定插件名（bundle patch 的 name 字段引用它）。 */
export declare const name = "dsh-auth-gate";
/** 需要 webServer 服务就绪后才能注册拦截。 */
export declare const inject: string[];
/**
 * 插件入口。
 * @param ctx - plugin context；因 inject: [webServer]，ctx.webServer 可用。
 * @param config - 行配置（见 src/types.ts AuthGateConfig）。
 */
export declare function apply(ctx: PluginContext, config?: AuthGateConfig): void;
