/**
 * 对比两种 Loader 安装方式下 entry.ctx.directoryPicker 的读取行为：
 *   A) new Loader(ctx, ...)          —— E2E/旧复现脚本形态
 *   B) ctx.plugin(Loader, ...)       —— 真实应用（dsh-app-boot）形态
 * 运行：node test/repro-ctx.mjs
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FNM_BASE = join(homedir(), "AppData", "Roaming", "fnm", "node-versions");
const candidates = [];
for (const entry of readdirSync(FNM_BASE, { withFileTypes: true })) {
	if (!entry.isDirectory()) continue;
	const candidate = join(FNM_BASE, entry.name, "installation", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai");
	if (existsSync(candidate)) candidates.push(candidate);
}
candidates.sort((a, b) => b.localeCompare(a));
const DSH_MODULES = candidates[0];
const toUrl = (p) => pathToFileURL(p).href;
const { Context } = await import(toUrl(`${DSH_MODULES}/cordis/lib/index.js`));
const { default: Loader } = await import(toUrl(`${DSH_MODULES}/cordis-plugin-loader/lib/index.js`));
const { mountNativePicker } = await import("../lib/native-picker.js");

async function tryRead(ctx, label) {
	try {
		const picker = await mountNativePicker(ctx);
		// mountNativePicker 内部已读 entry.ctx.directoryPicker —— 若抛错会先失败
		const id = Object.keys(ctx.loader.store).find((k) => ctx.loader.store[k].options?.name === "@deepseek-ai/dsh-host-directory-picker-native");
		let read = "?";
		try {
			const cap = ctx.loader.store[id]?.ctx?.directoryPicker;
			read = cap ? `OK kind=${cap.capability().kind}` : "undefined（无抛错）";
		} catch (error) {
			read = `THREW: ${error.message}`;
		}
		console.log(`[${label}] mount OK; 再读 entry.ctx.directoryPicker → ${read}`);
		await picker.dispose();
	} catch (error) {
		console.log(`[${label}] mount FAILED: ${error.message}`);
	}
}

// A) new Loader（E2E 形态）
{
	const ctx = new Context();
	new Loader(ctx, { baseUrl: toUrl(DSH_MODULES) + "/" });
	await tryRead(ctx, "A: new Loader");
}

// B) ctx.plugin(Loader)（真实应用形态）
{
	const ctx = new Context();
	await ctx.plugin(Loader, { baseUrl: toUrl(DSH_MODULES) + "/" });
	await tryRead(ctx, "B: ctx.plugin(Loader)");
}

// B2) 全新 ctx（B 形态）+ 手动 create + 直读 entry.fiber.store（绕过 ctx 服务解析）
{
	const ctx = new Context();
	await ctx.plugin(Loader, { baseUrl: toUrl(DSH_MODULES) + "/" });
	try {
		const id = await ctx.loader.create({
			name: "@deepseek-ai/dsh-host-directory-picker-native",
			isolate: { directoryPicker: "dsh-access-gate:native" }
		});
		const entry = ctx.loader.store[id];
		const impl = entry?.fiber?.store?.["directoryPicker"];
		console.log(`[B2] fiber.store["directoryPicker"] → ${impl ? `OK kind=${impl.value.capability().kind}` : "missing"}`);
		if (impl) await ctx.loader.remove(id);
	} catch (error) {
		console.log(`[B2] fiber.store 直读失败: ${error.message}`);
	}
}

process.exit(0);
