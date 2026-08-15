/**
 * dsh-access-gate — 客户端半边
 *
 * 两个职责：
 *
 * 1) 智能工作区目录选择 flow（v0.3.0）：
 *    - 本机访问（location.hostname 为 127.0.0.1 / localhost / [::1]）：
 *      renderless 原生 flow —— 调 host 的 /-/gate/pick-directory 路由，
 *      host 弹官方原生目录对话框（loader 动态挂载官方 native 后端），
 *      选中路径回填工作区创建流程；
 *    - 远程访问：渲染时抛错 abdicate —— slots 的 shadowing 机制把本 entry
 *      从 cell 退役，官方 browse flow（priority 0）自动接管。
 *
 * 2) 访问认证设置卡片（v0.4.0）：注册到官方"插件配置"选项卡
 *    （settings.plugin.item list slot），配置/清除访问密码：
 *    - 密码存 credentials 域（官方惯例，同 Models 页面的 API key）：
 *      ~/.dsh/.credentials.yaml，进程环境变量 DSH_GATE_PASSWORD 天然优先；
 *    - 控件 write-only（SecretField 风格）：只显示"已配置/未配置"状态，
 *      值永不回传；空输入不写（保持现有密码）；"移除密码"清除；
 *    - 保存后 host 经 credentials/updated 实时生效，无需重启。
 *
 * 为什么手写 JS：客户端模块走 window.__ModuleLoader__（CommonJS 闭包
 * factory 格式），tsc 无法产出该形态；官方 client 包同样是打包产物。
 */
window.__ModuleLoader__.load({
	id: "dsh-access-gate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");

		// ── 智能目录选择 flow（v0.3.0）──────────────────────────────────────

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
				throw new Error("dsh-access-gate: remote client — falling back to the in-app directory browser");
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

		// ── 访问认证设置卡片（v0.4.0）───────────────────────────────────────

		/** 访问密码的 credential 引用（与 host 侧 PASSWORD_REF 一致）。 */
		var GATE_REF = "DSH_GATE_PASSWORD";
		/** 本卡片的 locale 命名空间。 */
		var SETTINGS_NS = "dsh-access-gate-settings";

		/** 简化卡片：标题行 + 密码框 + 状态 + 保存/放弃/移除。 */
		function AuthGateCard(props) {
			var t = props.t;
			var [open, setOpen] = react.useState(false);
			var [text, setText] = react.useState("");
			var [configured, setConfigured] = react.useState(false);
			var [saving, setSaving] = react.useState(false);
			var [failed, setFailed] = react.useState(false);
			var dirty = text.length > 0;
			var readState = function () {
				props.api.credentials.describe({ refs: [GATE_REF] }).then(function (response) {
					if (response.result && response.result.ok) {
						var view = response.result.value.credentials[GATE_REF];
						setConfigured(!!view && view.configured === true);
					}
				}).catch(function () {});
			};
			react.useEffect(function () {
				readState();
				var off = props.remote.$on("credentials/updated", function (ref) {
					if (ref === GATE_REF) readState();
				});
				return off;
			}, []);
			var save = function () {
				var value = text.trim();
				if (value === "" || saving) return;
				setSaving(true);
				setFailed(false);
				props.api.credentials.set({ ref: GATE_REF, value: value }).then(function (response) {
					setSaving(false);
					if (response.result && response.result.ok) {
						setText("");
						readState();
					} else {
						setFailed(true);
					}
				}).catch(function () {
					setSaving(false);
					setFailed(true);
				});
			};
			var remove = function () {
				if (saving) return;
				setSaving(true);
				setFailed(false);
				props.api.credentials.unset({ ref: GATE_REF }).then(function (response) {
					setSaving(false);
					if (response.result && response.result.ok) {
						setText("");
						readState();
					} else {
						setFailed(true);
					}
				}).catch(function () {
					setSaving(false);
					setFailed(true);
				});
			};
			var fieldStyle = {
				display: "flex",
				flexDirection: "column",
				gap: 6,
				padding: "12px 0"
			};
			var rowStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8
			};
			var labelStyle = {
				flex: 1,
				fontSize: 13,
				fontWeight: 500,
				color: "var(--dsw-alias-label-primary, #eee)"
			};
			var badgeStyle = {
				fontSize: 11,
				padding: "1px 8px",
				borderRadius: 999,
				color: configured ? "var(--dsw-alias-label-secondary, #bbb)" : "var(--dsw-alias-label-tertiary, #888)",
				background: configured ? "var(--dsw-alias-bg-module-platform, #333)" : "transparent"
			};
			var inputStyle = {
				boxSizing: "border-box",
				width: "100%",
				height: 34,
				padding: "0 12px",
				fontSize: 13,
				color: "var(--dsw-alias-label-primary, #eee)",
				background: "var(--dsw-alias-bg-layer-3, #111)",
				border: "1px solid var(--dsw-alias-border-l2, #444)",
				borderRadius: 8
			};
			var hintStyle = {
				margin: 0,
				fontSize: 12,
				color: "var(--dsw-alias-label-tertiary, #888)"
			};
			var footerStyle = {
				display: "flex",
				alignItems: "center",
				gap: 8,
				justifyContent: "flex-end",
				padding: "10px 0 4px"
			};
			var buttonStyle = {
				font: "inherit",
				fontSize: 13,
				padding: "5px 14px",
				borderRadius: 8,
				cursor: "pointer",
				border: "1px solid var(--dsw-alias-border-l2, #444)",
				background: "transparent",
				color: "var(--dsw-alias-label-primary, #eee)"
			};
			var saveStyle = Object.assign({}, buttonStyle, {
				background: "var(--dsw-alias-label-primary, #eee)",
				color: "var(--dsw-alias-bg-layer-3, #111)"
			});
			var linkStyle = {
				font: "inherit",
				fontSize: 12,
				cursor: "pointer",
				background: "none",
				border: "none",
				color: "var(--dsw-alias-label-secondary, #bbb)",
				padding: 0
			};
			return react.createElement("li", { style: {
				listStyle: "none",
				border: "1px solid var(--dsw-alias-border-l2, #333)",
				borderRadius: 12,
				background: "var(--dsw-alias-bg-layer-3, #1c1c1c)"
			} },
				react.createElement("button", { type: "button", onClick: function () { setOpen(!open); }, "aria-expanded": open, style: {
					appearance: "none",
					width: "100%",
					font: "inherit",
					textAlign: "left",
					cursor: "pointer",
					background: "none",
					border: "none",
					borderRadius: 12,
					padding: "14px 16px",
					display: "flex",
					alignItems: "center",
					gap: 12
				} },
					react.createElement("span", { style: { flex: 1, display: "flex", flexDirection: "column", gap: 4 } },
						react.createElement("span", { style: { fontSize: 15, fontWeight: 600, color: "var(--dsw-alias-label-primary, #eee)" } }, t("title")),
						react.createElement("span", { style: { fontSize: 13, color: "var(--dsw-alias-label-tertiary, #888)" } }, t("description"))
					),
					react.createElement("span", { style: { fontSize: 11, color: "var(--dsw-alias-label-tertiary, #888)" } }, open ? "▾" : "▸")
				),
				open ? react.createElement("div", { style: { borderTop: "1px solid var(--dsw-alias-border-l2, #333)", margin: "0 16px", paddingBottom: 8 } },
					react.createElement("div", { style: fieldStyle },
						react.createElement("div", { style: rowStyle },
							react.createElement("label", { style: labelStyle, htmlFor: "auth-gate-password" }, t("passwordLabel")),
							react.createElement("span", { style: badgeStyle }, configured ? t("configured") : t("unconfigured"))
						),
						react.createElement("input", {
							id: "auth-gate-password",
							type: "password",
							autoComplete: "off",
							value: text,
							disabled: saving,
							placeholder: configured ? t("keepPlaceholder") : "",
							style: inputStyle,
							onChange: function (event) { setText(event.target.value); }
						}),
						react.createElement("p", { style: hintStyle }, t("hint")),
						configured ? react.createElement("button", { type: "button", style: linkStyle, disabled: saving, onClick: remove }, t("remove")) : null
					),
					failed ? react.createElement("p", { role: "status", style: { margin: 0, fontSize: 12, color: "var(--dsw-alias-state-error-primary, #ff6b6b)" } }, t("saveFailed")) : null,
					react.createElement("div", { style: footerStyle },
						react.createElement("button", { type: "button", style: buttonStyle, disabled: !dirty || saving, onClick: function () { setText(""); setFailed(false); } }, t("discard")),
						react.createElement("button", { type: "button", style: saveStyle, disabled: !dirty || saving, onClick: save }, saving ? t("saving") : t("save"))
					)
				) : null
			);
		}

		// ── 插件主体 ─────────────────────────────────────────────────────────

		/** 需要的 client 服务：slots（注册）、locale（文案）、connection（RPC）、remote（事件）。 */
		var inject = ["slots", "locale", "connection", "remote"];

		/** 客户端插件主体。 */
		function apply(ctx) {
			// 1) 智能目录选择 flow（本机原生 / 远程 abdicate 降级）
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

			// 2) 访问认证设置卡片（官方"插件配置"选项卡的 list slot）
			var api = ctx.get("connection").api;
			ctx.effect(function () {
				return ctx.locale.register(SETTINGS_NS, {
					zh: {
						title: "访问认证",
						description: "远程访问密码（默认无密码，远程直接可访问）",
						passwordLabel: "访问密码",
						configured: "已配置",
						unconfigured: "未配置",
						keepPlaceholder: "已设置；留空保持当前密码",
						hint: "设置后，除本机 127.0.0.1 外的访问（公网域名 / 局域网 IP）需输入密码。密码保存于 ~/.dsh/.credentials.yaml，环境变量 DSH_GATE_PASSWORD 优先。",
						remove: "移除密码（恢复远程免密）",
						save: "保存",
						saving: "保存中…",
						discard: "放弃修改",
						saveFailed: "保存失败，请重试。"
					},
					en: {
						title: "Access authentication",
						description: "Remote access password (no password by default; remote clients connect freely)",
						passwordLabel: "Access password",
						configured: "Configured",
						unconfigured: "Not configured",
						keepPlaceholder: "Set; leave blank to keep the current password",
						hint: "When set, every access other than local 127.0.0.1 (public domain / LAN IP) requires this password. Stored in ~/.dsh/.credentials.yaml; the DSH_GATE_PASSWORD environment variable wins.",
						remove: "Remove password (restore passwordless remote access)",
						save: "Save",
						saving: "Saving…",
						discard: "Discard",
						saveFailed: "The deployment did not accept these values; they were left for you to correct."
					}
				});
			}, "auth-gate: settings dictionaries");
			ctx.slots.inject("settings.plugin.item", function* () {
				yield ctx.slots.register({
					name: "settings.plugin.item",
					id: "auth-gate",
					order: 30,
					locale: SETTINGS_NS,
					inject: function () {
						return {
							api: api,
							remote: ctx.get("remote")
						};
					}
				}, AuthGateCard);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
