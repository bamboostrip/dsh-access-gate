/**
 * dsh-access-gate — 本机原生目录选择（复用官方 native 后端，跨平台）
 *
 * 通过 loader 动态挂载官方 `@deepseek-ai/dsh-host-directory-picker-native`
 * 包到 isolate 作用域（directoryPicker 服务隔离，与 root 的 browse 后端
 * 共存不冲突），然后调用其 capability.pick() —— 与官方 auto 选择器在
 * loopback 绑定时给出的交互完全一致：
 *
 *   - win32：koffi + worker 子进程弹新式 IFileOpenDialog；
 *   - darwin：osascript "choose folder"；
 *   - linux：zenity / kdialog（与 auto 的探测条件一致）。
 *
 * 为什么能 import 官方包：第三方插件的 node import 解析不到官方包
 * （profile 的 node_modules 是独立 pnpm 布局，没有 @deepseek-ai 树），
 * 但 loader 的模块解析（ModuleLoader）从 DSH 安装树解析 —— 官方
 * directory-picker-auto 正是用 ctx.loader.create 动态挂载官方包的。
 * 本实现模仿同一官方 API（cordis-plugin-loader 的 create/remove/store）。
 *
 * 生命周期：lazy 挂载（首次 pick 时），entry 随插件卸载 remove（零残留）。
 */
import type { LoaderEntry, PluginContext } from "./types.js";

/** 官方 native 目录选择后端包名（loader 按 DSH 模块解析加载）。 */
export const NATIVE_PICKER_PACKAGE = "@deepseek-ai/dsh-host-directory-picker-native";

/** 挂载的官方 picker 句柄。 */
export interface NativePicker {
	/** 弹官方原生目录对话框；返回选中路径，取消返回 null。 */
	pick(signal?: AbortSignal): Promise<string | null>;
	/** 卸载 loader entry（插件清理时调用）。 */
	dispose(): Promise<void>;
}

/**
 * 挂载官方 native 后端并返回句柄。
 * 每次调用创建独立 entry；调用方应缓存并负责 dispose。
 * @param ctx - plugin context（loader 服务由 inject 保证可用）。
 * @returns native picker 句柄。
 */
export async function mountNativePicker(ctx: PluginContext): Promise<NativePicker> {
	const entryId = await ctx.loader.create({
		name: NATIVE_PICKER_PACKAGE,
		isolate: { directoryPicker: "dsh-access-gate:native" }
	});
	const entry: LoaderEntry | undefined = ctx.loader.store[entryId];
	if (entry === undefined) throw new Error(`dsh-access-gate: loader entry "${entryId}" missing after create`);
	const capability = entry.ctx.directoryPicker?.capability();
	if (capability === undefined || capability.kind !== "native") {
		await ctx.loader.remove(entryId);
		throw new Error(`dsh-access-gate: expected native directory picker capability, got ${capability?.kind ?? "none"}`);
	}
	return {
		pick: (signal) => capability.pick(signal),
		dispose: () => ctx.loader.remove(entryId)
	};
}
