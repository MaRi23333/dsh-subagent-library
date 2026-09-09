window.__ModuleLoader__.load({ id: "dsh-subagent-library", factory: (require) => {
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
	/** Synchronous busy flag (see applyWrite's re-entry guard). */
	const busyRef = (0, react.useRef)(false);
	(0, react.useEffect)(() => () => {
		alive.current = false;
	}, []);
	/** Revision of the last committed server state (successful write or load).
	*  document-updated pushes at or below it are our own write's echo and are
	*  skipped — applyWrite already merged the touched row, and a full reload
	*  here would wipe unsaved drafts in other rows. External pushes (higher
	*  revisions) still reload. */
	const lastCommitted = (0, react.useRef)(null);
	/** True while a write request is in flight: the push and the HTTP response
	*  travel on independent channels, so a push may arrive before the response
	*  commits our state. Everything in this window is skipped and the newest
	*  skipped revision is re-checked after the response. */
	const pendingSelfWrite = (0, react.useRef)(false);
	const skippedWhilePending = (0, react.useRef)(null);
	const load = () => {
		(async () => {
			try {
				const next = await readView$1();
				if (!alive.current) return;
				lastCommitted.current = next.revision;
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
		return subscribeRefresh((revision) => {
			if (pendingSelfWrite.current) {
				if (revision !== void 0) skippedWhilePending.current = Math.max(skippedWhilePending.current ?? -1, revision);
				return;
			}
			if (revision !== void 0 && lastCommitted.current !== null && revision <= lastCommitted.current) return;
			load();
		});
	}, [subscribeRefresh]);
	const applyWrite = async (write, touchedId) => {
		if (busyRef.current) return false;
		busyRef.current = true;
		setBusy(true);
		setStatus(null);
		pendingSelfWrite.current = true;
		try {
			const result = await writeView$1(write);
			if (!alive.current) return false;
			pendingSelfWrite.current = false;
			const skipped = skippedWhilePending.current;
			skippedWhilePending.current = null;
			if (result.ok) {
				lastCommitted.current = result.view.revision;
				setView(result.view);
				setEntries((current) => {
					const next = { ...current };
					const fresh = result.view.entries[touchedId];
					if (fresh !== void 0) next[touchedId] = structuredClone(fresh);
					else delete next[touchedId];
					return next;
				});
				setStatus({
					kind: "ok",
					text: "已保存"
				});
				if (skipped !== null && skipped > result.view.revision) load();
				return true;
			}
			skippedWhilePending.current = null;
			if (result.conflict) {
				setStatus({
					kind: "error",
					text: "配置已被其他窗口修改，已重新加载，请重试。"
				});
				load();
			} else {
				if (skipped !== null && lastCommitted.current !== null && skipped > lastCommitted.current) load();
				setStatus({
					kind: "error",
					text: result.message ?? "保存失败"
				});
			}
			return false;
		} finally {
			pendingSelfWrite.current = false;
			busyRef.current = false;
			if (alive.current) setBusy(false);
		}
	};
	/** Normalize one entry for persistence: empty optional fields are dropped
	*  (they then fall back to their defaults instead of being stored as '' or
	*  stale values), and toolFilter survives only while it still scopes
	*  something — an allow list alone must NOT be deleted by an editor that
	*  only shows deny. */
	const cleanEntry = (entry) => {
		const clean = { ...entry };
		if (clean.provider === "") delete clean.provider;
		if (clean.model === "") delete clean.model;
		if (clean.subagentProvider === "") delete clean.subagentProvider;
		if (clean.persona === "") delete clean.persona;
		if (clean.description === "") delete clean.description;
		if (clean.maxDepth === void 0) delete clean.maxDepth;
		if (clean.maxTokens === void 0) delete clean.maxTokens;
		const filter = clean.toolFilter;
		if (filter !== void 0 && (filter.allow === void 0 || filter.allow.length === 0) && (filter.deny === void 0 || filter.deny.length === 0)) delete clean.toolFilter;
		return clean;
	};
	const updateEntry = (id, entry) => {
		if ((entry.description ?? "").trim() === "") {
			setStatus({
				kind: "error",
				text: "描述不能为空。"
			});
			return;
		}
		if (entry.maxDepth !== void 0 && (!Number.isInteger(entry.maxDepth) || entry.maxDepth < 1)) {
			setStatus({
				kind: "error",
				text: "深度上限需为 ≥1 的整数。"
			});
			return;
		}
		if (entry.maxTokens !== void 0 && (!Number.isInteger(entry.maxTokens) || entry.maxTokens < 1)) {
			setStatus({
				kind: "error",
				text: "输出上限需为 ≥1 的整数。"
			});
			return;
		}
		applyWrite({
			op: "save",
			entries: {
				...view?.entries ?? {},
				[id]: cleanEntry(entry)
			},
			expectedRevision: view?.revision
		}, id);
	};
	const removeEntry = (id) => {
		if (!window.confirm(`确认删除子代理 "${id}"？该操作立即写入 settings.yaml。`)) return;
		applyWrite({
			op: "delete",
			id,
			expectedRevision: view?.revision
		}, id);
	};
	const addEntry = () => {
		const id = newId.trim();
		if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || (newEntry.description ?? "").trim() === "") {
			setStatus({
				kind: "error",
				text: "ID 需为小写字母/数字/连字符，且必须有描述。"
			});
			return;
		}
		const serverEntries = view?.entries ?? {};
		if (serverEntries[id] !== void 0) {
			setStatus({
				kind: "error",
				text: `ID "${id}" 已存在。`
			});
			return;
		}
		if (newEntry.maxTokens !== void 0 && (!Number.isInteger(newEntry.maxTokens) || newEntry.maxTokens < 1)) {
			setStatus({
				kind: "error",
				text: "输出上限需为 ≥1 的整数。"
			});
			return;
		}
		if (newEntry.maxDepth !== void 0 && (!Number.isInteger(newEntry.maxDepth) || newEntry.maxDepth < 1)) {
			setStatus({
				kind: "error",
				text: "深度上限需为 ≥1 的整数。"
			});
			return;
		}
		applyWrite({
			op: "save",
			entries: {
				...serverEntries,
				[id]: cleanEntry(newEntry)
			},
			expectedRevision: view?.revision
		}, id).then((ok) => {
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
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
					children: "重试"
				})]
			}),
			status !== null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "12px",
					color: status.kind === "ok" ? "var(--dsh-color-success, #30a46c)" : "var(--dsh-color-danger, #e5484d)",
					whiteSpace: "pre-wrap"
				},
				children: status.text
			}),
			status === null && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: {
					fontSize: "13px",
					opacity: .8
				},
				children: "正在加载…（若长时间无响应，请重试或检查插件是否加载）"
			})
		]
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
										entry.maxDepth !== void 0 ? ` · 深度${entry.maxDepth}` : "",
										entry.maxTokens !== void 0 ? ` · ${entry.maxTokens}tok` : ""
									]
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: busy || !view.writable,
									onClick: () => removeEntry(id),
									style: buttonStyle,
									children: "删除"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
									type: "button",
									disabled: busy || !view.writable,
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
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "传输层"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									value: entry.subagentProvider ?? "",
									onChange: (event) => setEntries({
										...entries,
										[id]: {
											...entry,
											subagentProvider: event.target.value
										}
									}),
									placeholder: "spawn（默认）",
									style: inputStyle
								})]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: colStyle,
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: labelStyle,
									children: "输出上限"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
									type: "number",
									min: 1,
									value: entry.maxTokens ?? "",
									onChange: (event) => setEntries({
										...entries,
										[id]: {
											...entry,
											maxTokens: event.target.value === "" ? void 0 : Number(event.target.value)
										}
									}),
									placeholder: "tokens",
									style: {
										...inputStyle,
										maxWidth: "110px"
									}
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
											const allow = entry.toolFilter?.allow;
											setEntries({
												...entries,
												[id]: {
													...entry,
													toolFilter: allow !== void 0 && allow.length > 0 || deny.length > 0 ? {
														...allow !== void 0 && allow.length > 0 ? { allow } : {},
														...deny.length > 0 ? { deny } : {}
													} : void 0
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
									fontWeight: 600
								},
								children: "新增子代理"
							}),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: { flex: 1 } }),
							/* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
								type: "button",
								disabled: busy || !view.writable,
								onClick: addEntry,
								style: buttonStyle,
								children: "添加"
							})
						]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
							style: labelStyle,
							children: "ID"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
							value: newId,
							onChange: (event) => setNewId(event.target.value),
							placeholder: "k3-reviewer",
							style: {
								...inputStyle,
								maxWidth: "200px"
							}
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: rowStyle,
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
								value: newEntry.provider ?? "",
								onChange: (event) => setNewEntry({
									...newEntry,
									provider: event.target.value
								}),
								placeholder: "kimi-coding",
								style: inputStyle
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
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
								children: "传输层"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								value: newEntry.subagentProvider ?? "",
								onChange: (event) => setNewEntry({
									...newEntry,
									subagentProvider: event.target.value
								}),
								placeholder: "spawn（默认）",
								style: inputStyle
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: colStyle,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: labelStyle,
								children: "输出上限"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "number",
								min: 1,
								value: newEntry.maxTokens ?? "",
								onChange: (event) => setNewEntry({
									...newEntry,
									maxTokens: event.target.value === "" ? void 0 : Number(event.target.value)
								}),
								placeholder: "tokens（可选）",
								style: {
									...inputStyle,
									maxWidth: "110px"
								}
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
									value: newEntry.maxDepth ?? "",
									onChange: (event) => setNewEntry({
										...newEntry,
										maxDepth: event.target.value === "" ? void 0 : Number(event.target.value)
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
									value: newEntry.backgroundMode ?? "one-shot",
									onChange: (event) => setNewEntry({
										...newEntry,
										backgroundMode: event.target.value
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
									value: (newEntry.toolFilter?.deny ?? []).join(", "),
									onChange: (event) => {
										const deny = event.target.value.split(",").map((item) => item.trim()).filter(Boolean);
										const allow = newEntry.toolFilter?.allow;
										setNewEntry({
											...newEntry,
											toolFilter: allow !== void 0 && allow.length > 0 || deny.length > 0 ? {
												...allow !== void 0 && allow.length > 0 ? { allow } : {},
												...deny.length > 0 ? { deny } : {}
											} : void 0
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
							value: newEntry.persona ?? "",
							onChange: (event) => setNewEntry({
								...newEntry,
								persona: event.target.value
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
//#region src/client/nav-icon.ts
/**
* Settings-nav icon decoration for this plugin's own row (子代理库).
*
* The official settings shell's navIcon(id) table is closed — official ids
* get drawn icons and everything else falls back to a generic gear. This
* replaces that fallback <svg> inside OUR nav button (matched by our own
* registered label text) with the drawn robot-head icon. A MutationObserver
* re-applies the icon when the panel re-renders; gated on the settings
* dialog being present so idle chat streams never pay the query cost.
*/
const NAV_ICON_INNER = "<path d=\"M8 6.5V3.9\"/><circle cx=\"8\" cy=\"2.6\" r=\"0.85\"/><rect x=\"3.25\" y=\"6.5\" width=\"9.5\" height=\"6.5\" rx=\"1.5\"/><path d=\"M5.75 9.25v1.25\"/><path d=\"M10.25 9.25v1.25\"/><path d=\"M1.75 9.25h1.5\"/><path d=\"M12.75 9.25h1.5\"/>";
const NAV_LABELS = new Set(["子代理库"]);
function decorateSettingsNavIcon(ctx) {
	ctx.effect(() => {
		const decorate = () => {
			if (document.querySelector("[role=\"dialog\"]") === null) return;
			for (const button of Array.from(document.querySelectorAll("button"))) {
				const label = button.querySelector(":scope > span");
				if (label === null || !NAV_LABELS.has(label.textContent ?? "")) continue;
				const existing = button.firstElementChild;
				if (existing instanceof SVGElement) {
					if (existing.dataset.navIcon === "1") continue;
					const template = document.createElement("template");
					template.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" data-nav-icon="1">${NAV_ICON_INNER}</svg>`;
					existing.replaceWith(template.content.firstElementChild);
				}
			}
		};
		const observer = new MutationObserver(() => decorate());
		observer.observe(document.body, {
			childList: true,
			subtree: true
		});
		decorate();
		return () => observer.disconnect();
	}, "subagent-library: nav icon decoration");
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
/** Host error codes that carry no `message`; map them to user-facing text. */
const ERROR_TEXT = {
	"not-ready": "设置服务尚未就绪，请稍后重试。",
	"readonly": "设置当前为只读，无法写入。",
	"content-type-json-required": "请求被拒绝：写入只接受 JSON。",
	"cross-origin-forbidden": "请求被拒绝：跨源写入。",
	"body-too-large": "请求体超过 1 MiB 上限。",
	"bad-json": "请求体不是合法 JSON。",
	"entries-object-required": "缺少 entries 对象。",
	"invalid-id": "条目 ID 非法。",
	"unknown-op": "未知操作。"
};
async function readView() {
	const response = await fetch(API_PATH, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) {
		const error = body?.error;
		const message = body?.message;
		throw new Error(message ?? (error !== void 0 ? ERROR_TEXT[error] : void 0) ?? "子代理库接口不可用（插件未加载？）");
	}
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
		if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) {
			const message = body?.message;
			const error = body?.error;
			return {
				ok: false,
				message: message ?? (error !== void 0 ? ERROR_TEXT[error] : void 0) ?? "保存失败"
			};
		}
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
	const refresh = (revision) => {
		for (const fn of listeners) try {
			fn(revision);
		} catch {}
	};
	ctx.effect(() => ctx.remote.$on("settings/document-updated", (ns, revision) => {
		if (ns === NS) refresh(revision);
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
	decorateSettingsNavIcon(ctx);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
return module.exports; } });
//# sourceMappingURL=client.js.map