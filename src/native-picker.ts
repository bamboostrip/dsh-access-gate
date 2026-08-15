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
 *
 * ── 残留清理（2026-08-16 修复）──────────────────────────────────────────
 * entry 挂在 loader 根组（不属于本插件 fiber），若卸载/热重载时清理失败会
 * 留在 loader.store 里；同一 isolate 标签对应同一个 GlobalRealm 符号，残留
 * entry 的 directoryPicker 服务仍注册在该符号上，新的 create() 在 apply
 * 阶段 provide 会撞上已注册的实现，抛
 *   "service "directoryPicker" has been registered at <NativeDirectoryPicker>"
 * —— 之后所有 pick 请求 500，直到 DSH 重启。因此：
 *   1) mountNativePicker 挂载前先清扫同包名 + 同 isolate 标签的残留 entry；
 *   2) 冷启动竞态（loader 的 isolate 钩子随 ctx.plugin(isolate) 异步注册，
 *      紧接构造的第一次 create 可能抛 "Cyclic __proto__ value"）重试一次。
 */
import type { LoaderEntry, PluginContext } from "./types.js";

/** 官方 native 目录选择后端包名（loader 按 DSH 模块解析加载）。 */
export const NATIVE_PICKER_PACKAGE = "@deepseek-ai/dsh-host-directory-picker-native";
/** 本插件挂载官方后端时使用的 isolate 标签（entry.options.isolate.directoryPicker）。 */
export const NATIVE_PICKER_ISOLATE_LABEL = "dsh-access-gate:native";

/** 挂载的官方 picker 句柄。 */
export interface NativePicker {
	/** 弹官方原生目录对话框；返回选中路径，取消返回 null。 */
	pick(signal?: AbortSignal): Promise<string | null>;
	/** 卸载 loader entry（插件清理时调用）。 */
	dispose(): Promise<void>;
}

/**
 * 清掉本插件此前创建但未清理的 loader entry（同包名 + 同 isolate 标签）。
 * 幂等：entry 不存在/已在移除时静默跳过。见文件头"残留清理"注释。
 */
async function sweepStaleEntries(ctx: PluginContext): Promise<void> {
	for (const entry of Object.values(ctx.loader.store)) {
		const options = entry.options as { name?: string; isolate?: Record<string, string | true> } | undefined;
		if (options?.name !== NATIVE_PICKER_PACKAGE) continue;
		if (options.isolate?.directoryPicker !== NATIVE_PICKER_ISOLATE_LABEL) continue;
		try {
			await ctx.loader.remove(entry.id);
		} catch {
			// 已在移除中 / 已被删除：忽略。
		}
	}
}

/** 创建官方 native 后端 entry；冷启动 isolate 竞态时重试一次。 */
async function createNativeEntry(ctx: PluginContext): Promise<string> {
	const createOnce = () => ctx.loader.create({
		name: NATIVE_PICKER_PACKAGE,
		isolate: { directoryPicker: NATIVE_PICKER_ISOLATE_LABEL }
	});
	try {
		return await createOnce();
	} catch {
		// loader 的 isolate 钩子随 `ctx.plugin(isolate)`（Loader 构造内未 await）
		// 异步注册：紧接构造的第一次 create 会错过 entry-init，patch-context 时
		// `setPrototypeOf(map, map)` 抛 "Cyclic __proto__ value"。等一个 tick
		// 让钩子就绪后重试一次即恢复（失败的 create 已自清理，无残留）。
		await new Promise((resolve) => setTimeout(resolve, 50));
		await sweepStaleEntries(ctx);
		return await createOnce();
	}
}

/**
 * 挂载官方 native 后端并返回句柄。
 * 每次调用创建独立 entry；调用方应缓存并负责 dispose。
 * @param ctx - plugin context（loader 服务由 inject 保证可用）。
 * @returns native picker 句柄。
 */
export async function mountNativePicker(ctx: PluginContext): Promise<NativePicker> {
	// 先清残留（见文件头注释），再挂载 —— 自愈历史遗留状态。
	await sweepStaleEntries(ctx);
	const entryId = await createNativeEntry(ctx);
	const entry: LoaderEntry | undefined = ctx.loader.store[entryId];
	if (entry === undefined) throw new Error(`dsh-access-gate: loader entry "${entryId}" missing after create`);
	// 直读 entry.fiber.store：官方包以 Service 类插件挂载时，provide 记录存在
	// fiber.store[name]（{ name, value, fiber, check }）。不能用 entry.ctx
	// 的属性读取 —— 真实应用里 loader 以插件形式挂载（dsh-app-boot 的
	// ctx.plugin(Loader)），entry.ctx.directoryPicker 会走 cordis 的注入检查
	// 并抛 "cannot get property \"directoryPicker\" without inject"（而 E2E
	// 的 new Loader 形态不会抛，两种形态行为不一致）；fiber.store 无此限制。
	const capability = entry.fiber?.store?.["directoryPicker"]?.value?.capability();
	if (capability === undefined || capability.kind !== "native") {
		await ctx.loader.remove(entryId);
		throw new Error(`dsh-access-gate: expected native directory picker capability, got ${capability?.kind ?? "none"}`);
	}
	return {
		pick: (signal) => capability.pick(signal),
		// 幂等：entry 已被（清扫/其他路径）移除时静默。
		dispose: () => (ctx.loader.store[entryId] === undefined
			? Promise.resolve()
			: ctx.loader.remove(entryId))
	};
}
