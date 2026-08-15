/** 官方 native 目录选择后端包名（loader 按 DSH 模块解析加载）。 */
export const NATIVE_PICKER_PACKAGE = "@deepseek-ai/dsh-host-directory-picker-native";
/** 本插件挂载官方后端时使用的 isolate 标签（entry.options.isolate.directoryPicker）。 */
export const NATIVE_PICKER_ISOLATE_LABEL = "dsh-access-gate:native";
/**
 * 清掉本插件此前创建但未清理的 loader entry（同包名 + 同 isolate 标签）。
 * 幂等：entry 不存在/已在移除时静默跳过。见文件头"残留清理"注释。
 */
async function sweepStaleEntries(ctx) {
    for (const entry of Object.values(ctx.loader.store)) {
        const options = entry.options;
        if (options?.name !== NATIVE_PICKER_PACKAGE)
            continue;
        if (options.isolate?.directoryPicker !== NATIVE_PICKER_ISOLATE_LABEL)
            continue;
        try {
            await ctx.loader.remove(entry.id);
        }
        catch {
            // 已在移除中 / 已被删除：忽略。
        }
    }
}
/** 创建官方 native 后端 entry；冷启动 isolate 竞态时重试一次。 */
async function createNativeEntry(ctx) {
    const createOnce = () => ctx.loader.create({
        name: NATIVE_PICKER_PACKAGE,
        isolate: { directoryPicker: NATIVE_PICKER_ISOLATE_LABEL }
    });
    try {
        return await createOnce();
    }
    catch {
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
export async function mountNativePicker(ctx) {
    // 先清残留（见文件头注释），再挂载 —— 自愈历史遗留状态。
    await sweepStaleEntries(ctx);
    const entryId = await createNativeEntry(ctx);
    const entry = ctx.loader.store[entryId];
    if (entry === undefined)
        throw new Error(`dsh-access-gate: loader entry "${entryId}" missing after create`);
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
//# sourceMappingURL=native-picker.js.map