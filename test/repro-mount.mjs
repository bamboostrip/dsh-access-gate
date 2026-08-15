/**
 * 验证 mountNativePicker 修复（构建产物 lib/native-picker.js）：
 *   1) 冷启动：loader 刚构造就挂载（isolate 钩子未就绪）→ 重试成功；
 *   2) 残留自愈：先挂载不 dispose，再次挂载（修复前报
 *      "service directoryPicker has been registered"）→ 清扫后成功；
 *   3) 幂等 dispose：entry 已被清扫移除后 dispose 不抛错。
 * 运行：node test/repro-mount.mjs（先 npm run build）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir, networkInterfaces } from "node:os";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

// DSH 安装树自动探测（与 e2e-gate.mjs 相同；可用 DSH_MODULES 环境变量覆盖）。
const FNM_BASE = join(homedir(), "AppData", "Roaming", "fnm", "node-versions");
let DSH_MODULES = process.env.DSH_MODULES;
if (!DSH_MODULES && existsSync(FNM_BASE)) {
	const candidates = [];
	for (const entry of readdirSync(FNM_BASE, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = join(FNM_BASE, entry.name, "installation", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
		if (existsSync(candidate)) candidates.push(candidate);
	}
	candidates.sort((a, b) => b.localeCompare(a));
	DSH_MODULES = candidates[0];
}
if (!existsSync(join(DSH_MODULES, "cordis", "package.json"))) throw new Error(`DSH_MODULES 路径无效: ${DSH_MODULES}`);
const toUrl = (p) => pathToFileURL(p).href;
const { Context } = await import(toUrl(`${DSH_MODULES}/cordis/lib/index.js`));
const { default: Loader } = await import(toUrl(`${DSH_MODULES}/cordis-plugin-loader/lib/index.js`));
const { mountNativePicker } = await import("../lib/native-picker.js");

let failures = 0;
function check(desc, pass, extra = "") {
	console.log(`${pass ? "PASS" : "FAIL"}  ${desc}${extra ? `  (${extra})` : ""}`);
	if (!pass) failures += 1;
}

// 场景 1：冷启动（无任何 await，构造后立即挂载）
{
	const ctx = new Context();
	new Loader(ctx, { baseUrl: toUrl(DSH_MODULES) + "/" });
	try {
		const picker = await mountNativePicker(ctx);
		check("冷启动：loader 构造后立即挂载成功（重试兜底）", true);
		await picker.dispose();
	} catch (error) {
		check("冷启动：loader 构造后立即挂载成功（重试兜底）", false, error.message);
	}
}

// 场景 2：残留自愈（挂载后不 dispose 直接再次挂载 → 修复前报 already registered）
{
	const ctx = new Context();
	new Loader(ctx, { baseUrl: toUrl(DSH_MODULES) + "/" });
	try {
		const picker1 = await mountNativePicker(ctx);
		const entriesAfterFirst = Object.values(ctx.loader.store).filter((e) => e.options?.name === "@deepseek-ai/dsh-host-directory-picker-native").length;
		const picker2 = await mountNativePicker(ctx); // 修复前：provide 冲突 → 500 死锁
		const entriesAfterSecond = Object.values(ctx.loader.store).filter((e) => e.options?.name === "@deepseek-ai/dsh-host-directory-picker-native").length;
		check("残留自愈：连续两次挂载都成功", true);
		check("残留自愈：第二次挂载后 store 只有 1 个 entry（清扫生效）", entriesAfterSecond === 1, `entries=${entriesAfterSecond}`);
		// 场景 3：幂等 dispose（picker1 的 entry 已被清扫）
		try {
			await picker1.dispose();
			check("幂等 dispose：已被清扫的 entry dispose 不抛错", true);
		} catch (error) {
			check("幂等 dispose：已被清扫的 entry dispose 不抛错", false, error.message);
		}
		await picker2.dispose();
		const entriesAfterDispose = Object.values(ctx.loader.store).filter((e) => e.options?.name === "@deepseek-ai/dsh-host-directory-picker-native").length;
		check("卸载清理：dispose 后 store 无残留", entriesAfterDispose === 0, `entries=${entriesAfterDispose}`);
	} catch (error) {
		check("残留自愈：连续两次挂载都成功", false, error.message);
	}
}

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
