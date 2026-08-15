/** 官方 native 目录选择后端包名（loader 按 DSH 模块解析加载）。 */
export const NATIVE_PICKER_PACKAGE = "@deepseek-ai/dsh-host-directory-picker-native";
/**
 * 挂载官方 native 后端并返回句柄。
 * 每次调用创建独立 entry；调用方应缓存并负责 dispose。
 * @param ctx - plugin context（loader 服务由 inject 保证可用）。
 * @returns native picker 句柄。
 */
export async function mountNativePicker(ctx) {
    const entryId = await ctx.loader.create({
        name: NATIVE_PICKER_PACKAGE,
        isolate: { directoryPicker: "dsh-access-gate:native" }
    });
    const entry = ctx.loader.store[entryId];
    if (entry === undefined)
        throw new Error(`dsh-access-gate: loader entry "${entryId}" missing after create`);
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
//# sourceMappingURL=native-picker.js.map