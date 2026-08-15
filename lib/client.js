/**
 * dsh-auth-gate — 客户端半边（智能工作区目录选择 flow）
 *
 * 背景：dsh-lan-access 把 webserver 绑到 0.0.0.0 后，官方
 * directory-picker-auto 启动时判定"可能远程访问"→ 固定挂 browse（应用内
 * Miller 浏览器），本机用户再也看不到 OS 原生目录对话框（详见 NOTES §8）。
 *
 * 本文件做什么：向两个 directoryFlow slot（conversation.hero.workspace.
 * directoryFlow / sidebar.workspaces.directoryFlow）注册一个 priority -1 的
 * "智能 flow"（shadowing：priority 最低者渲染，官方 UI 是默认 0）：
 *
 *   - 本机访问（location.hostname 为 127.0.0.1 / localhost / [::1]）：
 *     renderless 原生 flow —— 调 host 的 /-/gate/pick-directory 路由，
 *     host 弹 OS 目录对话框（PowerShell FolderBrowserDialog），选中的
 *     路径直接回填工作区创建流程（逻辑与官方 native flow 一致）。
 *   - 远程访问：渲染时抛错 abdicate —— slots 的 shadowing 机制把本 entry
 *     从 cell 退役，官方 browse flow（priority 0）自动接管 → 远程用户
 *     继续使用应用内 Miller 浏览器，行为与未装本插件完全一致。
 *
 * 为什么手写 JS：客户端模块走 window.__ModuleLoader__（CommonJS 闭包
 * factory 格式），tsc 无法产出该形态；官方 client 包同样是打包产物。
 * 逻辑刻意保持最小（~60 行），只依赖 react + slots 两个模块。
 */
window.__ModuleLoader__.load({
	id: "dsh-auth-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		/** host 原生目录选择路由（与 src/index.ts 的 PICK_PATH 一致）。 */
		var PICK_PATH = "/-/gate/pick-directory";

		/** 当前页面是否通过本机回环地址访问。 */
		function isLoopbackPage() {
			if (typeof location === "undefined") return false;
			var host = location.hostname;
			return host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
		}

		/** 调 host 原生目录选择；返回选中路径，用户取消返回 null。 */
		function pickViaHost() {
			return fetch(PICK_PATH, { method: "POST" }).then(function (response) {
				if (!response.ok) throw new Error("picker failed: HTTP " + response.status);
				return response.json().then(function (body) {
					if (body && typeof body.path === "string") return body.path;
					if (body && body.path === null) return null;
					throw new Error(body && body.error ? body.error : "picker returned an invalid response");
				});
			});
		}

		/**
		 * 智能 flow：本机走原生对话框（renderless）；远程 abdicate 让官方
		 * browse flow 接管。renderless 逻辑照抄官方 native flow（armed ref
		 * 保证 open 上升沿只触发一次 pick）。
		 */
		function SmartDirectoryFlow(props) {
			if (!isLoopbackPage()) {
				// abdicate：让 slots 把本 entry 从 cell 退役，官方 browse 接管。
				throw new Error("dsh-auth-gate: remote client — falling back to the in-app directory browser");
			}
			var open = props.open;
			var pick = props.pick;
			var armed = react.useRef(false);
			var outcome = react.useRef(props);
			outcome.current = props;
			var alive = react.useRef(true);
			react.useEffect(function () {
				alive.current = true;
				return function () {
					alive.current = false;
				};
			}, []);
			react.useEffect(function () {
				if (!open) {
					armed.current = false;
					return;
				}
				if (armed.current) return;
				armed.current = true;
				pick().then(function (path) {
					if (!alive.current) return;
					if (path === null) outcome.current.onCancel();
					else outcome.current.onPicked(path);
				}, function (reason) {
					if (!alive.current) return;
					outcome.current.onError(reason instanceof Error ? reason.message : String(reason));
				});
			}, [open, pick]);
			return null;
		}

		/** 需要 slots 服务（directoryFlow slot 注册）。 */
		var inject = ["slots"];

		/** 客户端插件主体：注册智能 flow 到两个 directoryFlow hole。 */
		function apply(ctx) {
			var injected = function () {
				return { pick: pickViaHost };
			};
			ctx.slots.inject("conversation.hero.workspace.directoryFlow", function () {
				return ctx.slots.inject("sidebar.workspaces.directoryFlow", function* () {
					yield ctx.slots.register({
						name: "conversation.hero.workspace.directoryFlow",
						priority: -1,
						inject: injected
					}, SmartDirectoryFlow);
					yield ctx.slots.register({
						name: "sidebar.workspaces.directoryFlow",
						priority: -1,
						inject: injected
					}, SmartDirectoryFlow);
				});
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
