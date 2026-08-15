window.__ModuleLoader__.load({ id: "dsh-plugin-subagent-library", factory: (require) => {
var module = { exports: {} }; var exports = module.exports;
//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));

//#endregion
let react = require("react");
react = __toESM(react);
let react_jsx_runtime = require("react/jsx-runtime");
react_jsx_runtime = __toESM(react_jsx_runtime);

//#region src/client/LibrarySettings.tsx
function LibrarySettings(props) {
	const { readView: readView$1, writeView: writeView$1, subscribeRefresh } = props;
	const [view, setView] = (0, react.useState)(null);
	const [entries, setEntries] = (0, react.useState)({});
	const [busy, setBusy] = (0, react.useState)(false);
	const [status, setStatus] = (0, react.useState)(null);
	const [newId, setNewId] = (0, react.useState)("");
	const [newEntry, setNewEntry] = (0, react.useState)({
		description: "",
		provider: "",
		model: "",
		backgroundMode: "one-shot"
	});
	const alive = (0, react.useRef)(true);
	(0, react.useEffect)(() => () => {
		alive.current = false;
	}, []);
	const load = () => {
		(async () => {
			try {
				const next = await readView$1();
				if (!alive.current) return;
				setView(next);
				setEntries(structuredClone(next.entries));
			} catch (error) {
				if (alive.current) setStatus({
					kind: "error",
					text: String(error)
				});
			}
		})();
	};
	(0, react.useEffect)(() => {
		load();
		return subscribeRefresh(() => load());
	}, [subscribeRefresh]);
	const applyWrite = async (write) => {
		setBusy(true);
		setStatus(null);
		try {
			const result = await writeView$1(write);
			if (!alive.current) return false;
			if (result.ok) {
				setView(result.view);
				setEntries(structuredClone(result.view.entries));
				setStatus({
					kind: "ok",
					text: "已保存"
				});
				return true;
			}
			if (result.conflict) {
				setStatus({
					kind: "error",
					text: "配置已被其他窗口修改，已重新加载，请重试。"
				});
				load();
			} else setStatus({
				kind: "error",
				text: result.message ?? "保存失败"
			});
			return false;
		} finally {
			if (alive.current) setBusy(false);
		}
	};
	const updateEntry = (id, entry) => {
		if ((entry.description ?? "").trim() === "") {
			setStatus({
				kind: "error",
				text: "描述不能为空。"
			});
			return;
		}
		if (entry.maxDepth !== void 0 && entry.maxDepth < 1) {
			setStatus({
				kind: "error",
				text: "深度上限最小为 1。"
			});
			return;
		}
		const clean = { ...entry };
		if (clean.provider === "") delete clean.provider;
		if (clean.model === "") delete clean.model;
		if (clean.persona === "") delete clean.persona;
		if (clean.description === "") delete clean.description;
		if (clean.maxDepth === void 0) delete clean.maxDepth;
		if (clean.toolFilter !== void 0 && (clean.toolFilter.deny === void 0 || clean.toolFilter.deny.length === 0)) delete clean.toolFilter;
		applyWrite({
			op: "save",
			entries: {
				...entries,
				[id]: clean
			},
			expectedRevision: view?.revision
		});
	};
	const removeEntry = (id) => {
		const next = { ...entries };
		delete next[id];
		applyWrite({
			op: "save",
			entries: next,
			expectedRevision: view?.revision
		});
	};
	const addEntry = () => {
		const id = newId.trim();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !newEntry.description) {
			setStatus({
				kind: "error",
				text: "ID 需为小写字母/数字/连字符，且必须有描述。"
			});
			return;
		}
		if (entries[id] !== void 0) {
			setStatus({
				kind: "error",
				text: `ID "${id}" 已存在。`
			});
			return;
		}
		applyWrite({
			op: "save",
			entries: {
				...entries,
				[id]: { ...newEntry }
			},
			expectedRevision: view?.revision
		}).then((ok) => {
			if (alive.current && ok) {
				setNewId("");
				setNewEntry({
					description: "",
					provider: "",
					model: "",
					backgroundMode: "one-shot"
				});
			}
		});
	};
	const rowStyle = {
		display: "flex",
		alignItems: "center",
		gap: "8px"
	};
	/** Shrinkable multi-column row: min-width 0 lets inputs shrink below their
	*  intrinsic width instead of overflowing the settings card (form controls
	*  otherwise keep their default width as a flex minimum). */
	const colStyle = {
		...rowStyle,
		flex: 1,
		minWidth: 0
	};
	const labelStyle = {
		fontSize: "13px",
		opacity: .85,
		minWidth: "72px"
	};
	const inputStyle = {
		flex: 1,
		minWidth: 0,
		fontSize: "13px",
		fontFamily: "monospace",
		padding: "4px 8px",
		border: "1px solid var(--dsh-color-border, #3a3f4b)",
		borderRadius: "4px",
		background: "transparent",
		color: "inherit"
	};
	const buttonStyle = {
		padding: "3px 12px",
		fontSize: "12px",
		cursor: "pointer",
		opacity: busy ? .55 : 1
	};
	const cardStyle = {
		display: "flex",
		flexDirection: "column",
		gap: "6px",
		padding: "10px 12px",
		border: "1px solid var(--dsh-color-border, #3a3f4b)",
		borderRadius: "6px"
	};
	const hintStyle = {
		fontSize: "11px",
		opacity: .6,
		marginTop: "2px"
	};
	if (view === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: "8px",
			padding: "12px 4px"
		},
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				fontSize: "15px",
				fontWeight: 600
			},
			children: "子代理库"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: {
				fontSize: "13px",
				opacity: .8
			},
			children: "正在加载…（若长时间无响应，请刷新页面或检查插件是否加载）"
		})]
	});
	const ids = Object.keys(entries);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: {
			display: "flex",
			flexDirection: "column",
			gap: "10px",
			padding: "12px 4px",
			maxWidth: "720px"
		},
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: {
					display: "flex",
					flexDirection: "column",
					gap: "2px"
				},
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: {
						display: "flex",
						alignItems: "center",
						gap: "10px"
					},
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "15px",
							fontWeight: 600
						},
						children: "子代理库"
					}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: load,
						style: {
							...buttonStyle,
							opacity: .7
						},
						children: "刷新"
					})]
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
					style: hintStyle,
					children: "管理具名角色子代理。保存后热生效：模型可在任意会话通过 list_subagents / delegate 使用。"
				})]
			}),
			!view.writable && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "12px",
					opacity: .7
				},
				children: "（当前设置只读）"
			}),
			ids.length === 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "13px",
					opacity: .8
				},
				children: "库为空。添加第一个条目开始使用。"
			}),
			ids.map((id) => {
				const entry = entries[id];
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: cardStyle,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								alignItems: "center",
								gap: "10px"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: {
										fontSize: "13px",
										fontWeight: 600,
										fontFamily: "monospace"
									},
									children: id
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
									style: {
										fontSize: "11px",
										opacity: .7
									},
									children: [
										entry.provider || "默认路由",
										"/",
										entry.model || "默认模型",
										entry.backgroundMode === "continuable" ? " · 可续聊" : "",
										entry.maxDepth !== void 0 ? ` · 深度${entry.maxDepth}` : ""
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: busy,
									onClick: () => removeEntry(id),
									style: buttonStyle,
									children: "删除"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: busy,
									onClick: () => updateEntry(id, entry),
									style: buttonStyle,
									children: "保存"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle,
								children: "描述"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: entry.description ?? "",
								onChange: (event) => setEntries({
									...entries,
									[id]: {
										...entry,
										description: event.target.value
									}
								}),
								placeholder: "角色描述（模型可见）",
								style: inputStyle
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexWrap: "wrap",
								gap: "8px"
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "Provider"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: entry.provider ?? "",
									onChange: (event) => setEntries({
										...entries,
										[id]: {
											...entry,
											provider: event.target.value
										}
									}),
									placeholder: "deepseek-official / kimi-coding",
									style: inputStyle
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "模型"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: entry.model ?? "",
									onChange: (event) => setEntries({
										...entries,
										[id]: {
											...entry,
											model: event.target.value
										}
									}),
									placeholder: "k3-256k",
									style: inputStyle
								})]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								display: "flex",
								flexWrap: "wrap",
								gap: "8px"
							},
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: colStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: labelStyle,
										children: "深度上限"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										type: "number",
										min: 1,
										value: entry.maxDepth ?? "",
										onChange: (event) => setEntries({
											...entries,
											[id]: {
												...entry,
												maxDepth: event.target.value === "" ? void 0 : Number(event.target.value)
											}
										}),
										style: {
											...inputStyle,
											maxWidth: "80px"
										}
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: colStyle,
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: labelStyle,
										children: "后台模式"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										value: entry.backgroundMode ?? "one-shot",
										onChange: (event) => setEntries({
											...entries,
											[id]: {
												...entry,
												backgroundMode: event.target.value
											}
										}),
										style: {
											...inputStyle,
											maxWidth: "140px"
										},
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "one-shot",
											children: "one-shot"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
											value: "continuable",
											children: "continuable"
										})]
									})]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
									style: {
										...colStyle,
										flex: 2
									},
									children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										style: labelStyle,
										children: "禁用工具"
									}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										value: (entry.toolFilter?.deny ?? []).join(", "),
										onChange: (event) => {
											const deny = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
											setEntries({
												...entries,
												[id]: {
													...entry,
													toolFilter: deny.length ? { deny } : void 0
												}
											});
										},
										placeholder: "write, edit, todo_write, …",
										style: inputStyle
									})]
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: rowStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle,
								children: "角色提示词"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
								value: entry.persona ?? "",
								onChange: (event) => setEntries({
									...entries,
									[id]: {
										...entry,
										persona: event.target.value
									}
								}),
								placeholder: "子代理的系统提示词（可选）",
								rows: 3,
								style: {
									...inputStyle,
									resize: "vertical",
									fontFamily: "inherit"
								}
							})]
						})
					]
				}, id);
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: cardStyle,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: {
							fontSize: "13px",
							fontWeight: 600
						},
						children: "新增子代理"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: "8px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: colStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle,
								children: "ID"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: newId,
								onChange: (event) => setNewId(event.target.value),
								placeholder: "k3-reviewer",
								style: {
									...inputStyle,
									maxWidth: "160px"
								}
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: {
								...colStyle,
								flex: 2
							},
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle,
								children: "描述"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: newEntry.description ?? "",
								onChange: (event) => setNewEntry({
									...newEntry,
									description: event.target.value
								}),
								placeholder: "角色描述（模型可见）",
								style: inputStyle
							})]
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: {
							display: "flex",
							flexWrap: "wrap",
							gap: "8px"
						},
						children: [
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "Provider"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: newEntry.provider ?? "",
									onChange: (event) => setNewEntry({
										...newEntry,
										provider: event.target.value
									}),
									placeholder: "kimi-coding",
									style: inputStyle
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "模型"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: newEntry.model ?? "",
									onChange: (event) => setNewEntry({
										...newEntry,
										model: event.target.value
									}),
									placeholder: "k3-256k",
									style: inputStyle
								})]
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy,
								onClick: addEntry,
								style: buttonStyle,
								children: "添加"
							})
						]
					})
				]
			}),
			status !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "12px",
					color: status.kind === "ok" ? "var(--dsh-color-success, #30a46c)" : "var(--dsh-color-danger, #e5484d)"
				},
				children: status.text
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "11px",
					opacity: .55,
					paddingTop: "4px"
				},
				children: "配置存储于 $DSH_HOME/settings.yaml 的 subagent-library.entries。"
			})
		]
	});
}

//#endregion
//#region src/client/locales.ts
const zh = {
	"settings.title": "子代理库",
	"settings.hint": "管理具名角色子代理。保存后热生效：模型可在任意会话通过 list_subagents / delegate 使用。",
	"settings.empty": "库为空。添加第一个条目开始使用。",
	"settings.missing": "未找到 subagent-library 配置段（插件未加载？）。",
	"settings.add": "添加",
	"settings.addNew": "新增子代理",
	"settings.delete": "删除",
	"settings.save": "保存",
	"settings.saved": "已保存",
	"settings.conflict": "配置已被其他窗口修改，已重新加载，请重试。",
	"settings.error": "保存失败：",
	"settings.id": "ID",
	"settings.description": "描述",
	"settings.model": "模型",
	"settings.persona": "角色提示词",
	"settings.toolFilter": "禁用工具",
	"settings.maxDepth": "深度上限",
	"settings.background": "后台模式",
	"settings.provider": "Provider",
	"settings.sourceHint": "配置存储于 $DSH_HOME/settings.yaml 的 subagent-library.entries。"
};
const en = {
	"settings.title": "Subagent Library",
	"settings.hint": "Manage named role subagents. Changes apply live: models use them via list_subagents / delegate in any session.",
	"settings.empty": "Library is empty. Add the first entry to get started.",
	"settings.missing": "No subagent-library section found (plugin not loaded?).",
	"settings.add": "Add",
	"settings.addNew": "New subagent",
	"settings.delete": "Delete",
	"settings.save": "Save",
	"settings.saved": "Saved",
	"settings.conflict": "Config changed elsewhere; reloaded — please retry.",
	"settings.error": "Save failed: ",
	"settings.id": "ID",
	"settings.description": "Description",
	"settings.model": "Model",
	"settings.persona": "Persona",
	"settings.toolFilter": "Denied tools",
	"settings.maxDepth": "Max depth",
	"settings.background": "Background",
	"settings.provider": "Provider",
	"settings.sourceHint": "Stored at $DSH_HOME/settings.yaml under subagent-library.entries."
};

//#endregion
//#region src/client/index.tsx
const NS = "subagent-library";
const API_PATH = "/subagent-library/api";
async function readView() {
	const response = await fetch(API_PATH, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) throw new Error("子代理库接口不可用（插件未加载？）");
	const value = body;
	return {
		writable: value.writable,
		revision: value.revision,
		entries: value.entries ?? {}
	};
}
async function writeView(write) {
	try {
		const response = await fetch(API_PATH, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(write),
			cache: "no-store"
		});
		const body = await response.json();
		if (response.status === 409) return {
			ok: false,
			conflict: true
		};
		if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) return {
			ok: false,
			message: body?.message ?? "保存失败"
		};
		const value = body;
		return {
			ok: true,
			view: {
				writable: value.writable,
				revision: value.revision,
				entries: value.entries ?? {}
			}
		};
	} catch (error) {
		return {
			ok: false,
			message: String(error)
		};
	}
}
const inject = [
	"slots",
	"locale",
	"remote"
];
function apply(ctx) {
	ctx.effect(() => ctx.locale.register(NS, {
		zh,
		en
	}), "subagent-library: dictionaries");
	const listeners = /* @__PURE__ */ new Set();
	const subscribeRefresh = (fn) => {
		listeners.add(fn);
		return () => {
			listeners.delete(fn);
		};
	};
	const refresh = () => {
		for (const fn of listeners) try {
			fn();
		} catch {}
	};
	ctx.effect(() => ctx.remote.$on("settings/document-updated", (ns) => {
		if (ns === NS) refresh();
	}), "subagent-library: settings invalidation");
	ctx.slots.inject("settings.section", () => ctx.slots.register({
		name: "settings.section",
		id: NS,
		order: 40,
		label: () => "子代理库",
		inject: () => ({
			readView,
			writeView,
			subscribeRefresh
		})
	}, LibrarySettings));
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map