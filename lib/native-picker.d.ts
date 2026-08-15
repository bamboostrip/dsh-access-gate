/**
 * 弹原生目录选择框。
 * @param signal - 调用方生命周期；abort 时杀掉对话框进程并 reject。
 * @returns 选中目录的绝对路径；用户取消返回 null。
 */
export declare function pickDirectory(signal?: AbortSignal): Promise<string | null>;
