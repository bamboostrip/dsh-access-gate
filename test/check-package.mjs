/**
 * 包组合验证 —— 模拟 dsh-client-modules 的 resolveMeta 检查逻辑，
 * 确保 dsh-auth-gate 的 client 半边声明能被 DSH 组合层正确解析。
 *
 * 背景（踩坑记录）：v0.3.0 的 package.json 声明了 dsh.client 但没有
 * exports["./client"]，用户安装后启动报
 *   "dsh-auth-gate declares dsh.client but exports no \"./client\" bundle"
 * （dsh-client-modules/lib/index.js L256 clientExportOf）。E2E 直接挂 host
 * 插件不经过 client-modules 组合流程，所以没抓到 —— 本脚本补上这个盲区。
 *
 * 运行：npm run check:package
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const ok = (desc) => console.log(`PASS  ${desc}`);
const fail = (desc) => { failures.push(desc); console.log(`FAIL  ${desc}`); };

// 1) package.json 基础结构
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
ok(`name = ${pkg.name}`);

// 2) dsh.client 声明（parseDshClient 等价检查）
const decl = pkg.dsh?.client;
if (typeof decl?.platform !== "string") fail("dsh.client.platform 必须是字符串");
else if (decl.platform !== "web") fail(`dsh.client.platform 必须是 "web"，实际 ${decl.platform}`);
else ok(`dsh.client.platform = "${decl.platform}"`);
if (decl?.inject !== undefined) {
	if (!Array.isArray(decl.inject) || decl.inject.some((i) => typeof i !== "string")) fail("dsh.client.inject 必须是字符串数组");
	else ok(`dsh.client.inject = ${decl.inject.join(", ")}`);
}

// 3) exports["./client"]（clientExportOf 等价检查）—— 之前踩的坑
const clientExport = pkg.exports?.["./client"];
let clientRel;
if (typeof clientExport === "string") clientRel = clientExport;
else if (typeof clientExport === "object" && clientExport !== null && typeof clientExport.default === "string") clientRel = clientExport.default;
if (clientRel === undefined) fail('exports["./client"] 缺失（dsh-client-modules 会抛 "declares dsh.client but exports no ./client bundle"）');
else {
	ok(`exports["./client"] = ${clientRel}`);
	const clientPath = join(root, clientRel);
	if (!existsSync(clientPath)) fail(`client bundle 文件不存在：${clientRel}（先 npm run build）`);
	else {
		ok(`client bundle 文件存在（${clientPath}）`);
		// 4) client.js 的模块 id 必须与包名一致（window.__ModuleLoader__.load({id, ...})）
		const source = readFileSync(clientPath, "utf8");
		const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source);
		if (!idMatch) fail("client bundle 缺少 __ModuleLoader__.load({ id, factory })");
		else if (idMatch[1] !== pkg.name) fail(`client 模块 id 应为 ${pkg.name}，实际 ${idMatch[1]}`);
		else {
			ok(`client 模块 id = ${pkg.name}`);
			// 4.5) settings.plugin.item 必须按 keyed slot 注册（rc.7 起为 keyed；
			// v0.5.0 用 list 的 id/order 注册，rc.7 启动即抛
			// "keyed slot \"settings.plugin.item\" requires options.key"，整个插件加载失败）
			const keyMatch = /ctx\.slots\.inject\("settings\.plugin\.item"[\s\S]*?key:\s*(?:"([^"]+)"|([A-Za-z_$][\w$]*))/.exec(source);
			if (!keyMatch) fail('settings.plugin.item 注册缺少 key（rc.7 keyed slot 要求 options.key）');
			else if (/\bctx\.slots\.inject\("settings\.plugin\.item"[\s\S]*?\bid:\s*"/.test(source)) fail("settings.plugin.item 注册混入了 id（keyed slot 不认 id）");
			else {
				// key 可以是字面量，也可以是 `var NAME = "..."` 常量（client 源码风格）
				const keyValue = keyMatch[1] ?? new RegExp(`var\\s+${keyMatch[2]}\\s*=\\s*"([^"]+)"`).exec(source)?.[1];
				if (keyValue === undefined) fail(`settings.plugin.item 的 key 常量 ${keyMatch[2]} 缺少字符串定义`);
				else {
					ok(`settings.plugin.item keyed 注册 key = ${keyValue}`);
					// key 必须与 host 半边注册的 settings namespace 一致：官方选项卡只渲染
					// "host serve 的 namespace × client 卡片 key"的交集，不一致卡片静默消失
					const hostSource = existsSync(join(root, pkg.main)) ? readFileSync(join(root, pkg.main), "utf8") : "";
					const nsMatch = /SETTINGS_NAMESPACE\s*=\s*"([^"]+)"/.exec(hostSource);
					if (!nsMatch) fail("host 半边缺少 SETTINGS_NAMESPACE（不注册 namespace，设置卡片永不出现）");
					else if (nsMatch[1] !== keyValue) fail(`client key (${keyValue}) ≠ host namespace (${nsMatch[1]})，卡片不会渲染`);
					else ok(`host settings namespace = ${nsMatch[1]}（与 client key 一致）`);
				}
			}
		}
	}
}

// 5) exports["."] / main / types 指向存在
const mainPath = join(root, pkg.main ?? "");
if (!existsSync(mainPath)) fail(`main 不存在：${pkg.main}`);
else ok(`main = ${pkg.main}`);
if (pkg.types !== undefined && !existsSync(join(root, pkg.types))) fail(`types 不存在：${pkg.types}`);
if (pkg.exports?.["."] === undefined) fail('exports["."] 缺失');
else ok('exports["."] 存在');

// 6) dsh.bundle.patch 存在（loader reconcile 用它决定加入 bundles）
const patchRel = pkg.dsh?.bundle?.patch;
if (patchRel === undefined) fail("dsh.bundle.patch 缺失（dsh plugin add 不会把它加进 bundles 层栈）");
else if (!existsSync(join(root, patchRel))) fail(`bundle patch 不存在：${patchRel}`);
else ok(`dsh.bundle.patch = ${patchRel}`);

console.log(failures.length === 0 ? "\n包组合验证全部通过" : `\n${failures.length} 项失败`);
process.exit(failures.length === 0 ? 0 : 1);
