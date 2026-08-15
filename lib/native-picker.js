/**
 * dsh-auth-gate — 本机原生目录选择（Windows PowerShell FolderBrowserDialog）
 *
 * 为什么自实现而不是调官方 native 后端（@deepseek-ai/dsh-host-directory-picker-native）：
 * 第三方插件无法 import 官方包 —— profiles/web/node_modules 是独立的 pnpm 布局，
 * 里面没有 @deepseek-ai 树（DSH 的包在 fnm 安装树里），node 解析不到；
 * 而 loader 动态挂载方案（entry isolate realm）依赖 loader 内部生命周期，
 * 随 DSH 升级易碎。PowerShell 是 Windows 自带组件，零 npm 依赖、零 loader 介入，
 * 卸载零残留。备选方案（DSH 升级后官方体验变化时切换）见 NOTES.md §8.2。
 *
 * 适用平台：win32。其他平台返回错误（route 层转为 JSON 错误），
 * 客户端壳会降级走官方 browse（远程）或报错（本机非 Windows，TODO）。
 */
import { spawn } from "node:child_process";
/** 对话框标题（与官方 native 后端一致）。 */
const DIALOG_TITLE = "Select Workspace Directory";
/**
 * PowerShell 脚本：以 UTF-8 输出选中路径；取消时无输出（node 侧视为 null）。
 * 说明：
 * - `-STA` 必需：FolderBrowserDialog 只能在 STA 线程创建；
 * - `[Console]::OutputEncoding=UTF8`：防中文路径在 PowerShell 5.1（GBK）下乱码；
 * - 脚本经 spawn 参数数组传递（不经 shell 解析），单引号无转义问题。
 */
const PS_SCRIPT = [
    "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$f = New-Object System.Windows.Forms.FolderBrowserDialog",
    `$f.Description = '${DIALOG_TITLE}'`,
    "$f.ShowNewFolderButton = $true",
    "$r = $f.ShowDialog()",
    "if ($r -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::WriteLine($f.SelectedPath) }"
].join("; ");
/**
 * 弹原生目录选择框。
 * @param signal - 调用方生命周期；abort 时杀掉对话框进程并 reject。
 * @returns 选中目录的绝对路径；用户取消返回 null。
 */
export function pickDirectory(signal) {
    // 测试模式：不弹真实对话框（E2E 等自动化环境无法交互），模拟用户取消。
    if (process.env.DSH_GATE_PICKER_TEST === "1")
        return Promise.resolve(null);
    if (process.platform !== "win32") {
        return Promise.reject(new Error(`dsh-auth-gate: native picker is unsupported on ${process.platform}`));
    }
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-STA", "-Command", PS_SCRIPT], {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"]
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
            out += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk) => {
            err += chunk.toString("utf8");
        });
        const onAbort = () => {
            child.kill();
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.on("error", (error) => {
            signal?.removeEventListener("abort", onAbort);
            reject(error);
        });
        child.on("close", (code) => {
            signal?.removeEventListener("abort", onAbort);
            if (signal?.aborted) {
                reject(new Error("native directory picker aborted"));
                return;
            }
            if (code === 0) {
                const path = out.replace(/[\r\n]+$/, "");
                resolve(path === "" ? null : path);
                return;
            }
            reject(new Error(`native directory picker failed: ${err.trim() || `exit code ${String(code)}`}`));
        });
    });
}
//# sourceMappingURL=native-picker.js.map