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

//#region src/entry-id.ts
/** Entry ids are lowercase DNS-like labels. Also enforced for file names. */
const ENTRY_ID = /^[a-z0-9][a-z0-9-]*$/;
/** NTFS single component cap is 255; `<id>.yaml` plus headroom stays far below. */
const MAX_ID_LENGTH = 64;
const RESERVED_NAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);
function entryIdIssue(id) {
	if (!id) return "required";
	if (!/^[a-z0-9]/.test(id)) return "start";
	if (!ENTRY_ID.test(id)) return "characters";
	if (id.length > MAX_ID_LENGTH) return "length";
	if (RESERVED_NAMES.has(id)) return "reserved";
}
/** Check draft member codes using the same trimming the settings writer applies. */
function memberCodeErrors(values) {
	const codes = values.map((value) => value.trim());
	const seen = /* @__PURE__ */ new Set();
	const duplicates = /* @__PURE__ */ new Set();
	for (const code of codes) {
		if (seen.has(code)) duplicates.add(code);
		seen.add(code);
	}
	return codes.map((code) => {
		switch (entryIdIssue(code)) {
			case "required": return "请填写成员代号。";
			case "start": return "成员代号须以小写字母或数字开头。";
			case "characters": return "成员代号只能使用小写字母、数字和短横线。";
			case "length": return `成员代号最多 ${MAX_ID_LENGTH} 个字符。`;
			case "reserved": return "这个成员代号是系统保留名称，请换一个。";
			default: return duplicates.has(code) ? "此代号已在编队中使用，请换一个。" : void 0;
		}
	});
}

//#endregion
//#region src/client/editor-state.ts
const NEW = "@new";
const own = (rows, id) => Object.hasOwn(rows, id) ? rows[id] : void 0;
function emptyMember() {
	return {
		slot: "",
		role: "",
		assignment: ""
	};
}
function roleForm(id, row) {
	return {
		kind: "roles",
		id,
		enabled: row.enabled !== false,
		description: row.description ?? "",
		provider: row.provider ?? "",
		model: row.model ?? "",
		reasoningEffort: row.reasoningEffort ?? "",
		maxTokens: String(row.maxTokens ?? ""),
		maxDepth: String(row.maxDepth ?? ""),
		subagentProvider: row.subagentProvider ?? "",
		persona: row.persona ?? "",
		filter: row.toolFilter,
		routeNote: row.routeNote,
		inherit: false,
		clearToolFilter: false
	};
}
function groupForm(id, group) {
	return {
		kind: "groups",
		id,
		enabled: group.enabled !== false,
		description: group.description,
		name: group.name ?? "",
		instructions: group.instructions ?? "",
		members: group.members.map(({ slot, role, assignment }) => ({
			slot,
			role,
			assignment: assignment ?? ""
		}))
	};
}
function serverForm(view, tab, id) {
	if (tab === "groups") {
		const group = own(view.groups, id);
		return group && groupForm(id, group);
	}
	const role = own(view.entries, id);
	if (!role) return void 0;
	return roleForm(id, view.profile ? role : {
		...role,
		...own(view.sharedEntries, id)
	});
}
function freshDraft(view, tab, id) {
	const base = serverForm(view, tab, id);
	return {
		form: base ?? (tab === "roles" ? roleForm("", {}) : groupForm("", {
			description: "",
			members: [emptyMember()]
		})),
		base
	};
}
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Keep edited fields and bring untouched ones forward after an explicit comparison. */
function rebase(draft, current) {
	if (!current || !draft.base) return {
		form: draft.form,
		base: current
	};
	const base = draft.base;
	const changes = Object.fromEntries(Object.entries(draft.form).filter(([key, value]) => !equal(value, Reflect.get(base, key))));
	const form = {
		...current,
		...changes
	};
	if (form.kind === "roles" && form.inherit) return {
		base: current,
		form: {
			...form,
			provider: "",
			model: "",
			reasoningEffort: "",
			maxTokens: ""
		}
	};
	return {
		base: current,
		form
	};
}
function validate(form, view, isNew, base) {
	const id = form.id.trim();
	const idIssue = entryIdIssue(id);
	if (idIssue === "reserved") return "这个 ID 是系统保留名称，请换一个。";
	if (idIssue && form.kind === "groups") {
		if (idIssue === "required") return "请填写编队 ID。";
		if (/\s/.test(id)) return "编队 ID 中不能有空格，可以用短横线连接单词。";
		return "请按上面的格式修改编队 ID，例如 review-group。";
	}
	if (idIssue) return "ID 可使用小写字母、数字和短横线，以字母或数字开头，最长 64 个字符。";
	if (isNew && serverForm(view, form.kind, id)) return "此 ID 已存在，请换一个。";
	if (!form.description.trim()) return "请填写描述。";
	if (form.kind === "roles") {
		for (const [value, min, label] of [[
			form.maxDepth,
			0,
			"深度上限"
		], [
			form.maxTokens,
			1,
			"输出上限"
		]]) if (value && (!Number.isSafeInteger(Number(value)) || Number(value) < min)) return `${label}需为 ≥${min} 的整数。`;
		return;
	}
	if (!form.members.length) return "请添加至少一名编队成员。";
	const codeError = memberCodeErrors(form.members.map((m) => m.slot)).find(Boolean);
	if (codeError) return codeError;
	for (const member of form.members) {
		const unchanged = base?.kind === "groups" && base.members.some((m) => m.slot === member.slot.trim() && m.role === member.role);
		if (!member.role || !unchanged && !own(view.entries, member.role)) return "请为每位成员选择名册中的角色。";
	}
}
function routeFields(form) {
	return {
		...form.provider.trim() && { provider: form.provider.trim() },
		...form.model.trim() && { model: form.model.trim() },
		...form.reasoningEffort.trim() && { reasoningEffort: form.reasoningEffort.trim() },
		...form.maxTokens && { maxTokens: Number(form.maxTokens) }
	};
}
function saveWrite(draft, view) {
	const { form, base } = draft;
	const id = form.id.trim();
	const expectedHash = view.hash;
	const common = {
		description: form.description,
		...!form.enabled && { enabled: false }
	};
	if (form.kind === "groups") return {
		op: "save-group",
		id,
		expectedHash,
		group: {
			...common,
			...form.name.trim() && { name: form.name.trim() },
			...form.instructions && { instructions: form.instructions },
			members: form.members.map((m) => ({
				slot: m.slot.trim(),
				role: m.role,
				...m.assignment && { assignment: m.assignment }
			}))
		}
	};
	const fields = routeFields(form);
	const previous = base?.kind === "roles" ? routeFields(base) : {};
	const routeChanged = form.inherit || !equal(fields, previous);
	return {
		op: "save-entry",
		id,
		expectedHash,
		entry: {
			...common,
			...form.persona && { persona: form.persona },
			...!base && form.filter && !form.clearToolFilter && { toolFilter: form.filter },
			...form.subagentProvider.trim() && { subagentProvider: form.subagentProvider.trim() },
			...form.maxDepth && { maxDepth: Number(form.maxDepth) }
		},
		...routeChanged && { route: form.inherit || !Object.keys(fields).length ? { inherit: true } : fields },
		...form.clearToolFilter && { clearToolFilter: true }
	};
}

//#endregion
//#region src/client/settings-theme.ts
/** Host theme tokens keep the roster at home in both desktop color schemes. */
const TOKEN = {
	primary: "var(--dsw-alias-label-primary, currentColor)",
	secondary: "var(--dsw-alias-label-secondary, #737780)",
	muted: "var(--dsw-alias-label-tertiary, #858993)",
	border: "var(--dsw-alias-border-l2, rgba(128,128,128,0.2))",
	borderStrong: "var(--dsw-alias-border-l3, rgba(128,128,128,0.32))",
	divider: "var(--dsw-alias-border-l1, rgba(128,128,128,0.12))",
	surface: "var(--dsw-alias-bg-layer-2, rgba(128,128,128,0.035))",
	inset: "var(--dsw-alias-bg-module-platform, rgba(128,128,128,0.07))",
	hover: "var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,0.08))",
	accent: "var(--dsw-alias-state-business-primary, #4176e6)",
	accentFill: "var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6)",
	accentSoft: "var(--dsw-alias-state-business-tertiary, rgba(65,118,230,0.12))",
	success: "var(--dsw-alias-state-success-primary, #16a34a)",
	successSoft: "var(--dsw-alias-state-success-tertiary, rgba(22,163,74,0.12))",
	warn: "var(--dsw-alias-state-warn-label, #b45309)",
	warnSoft: "var(--dsw-alias-state-warn-tertiary, rgba(217,119,6,0.12))",
	danger: "var(--dsw-alias-state-error-primary, #dc2626)",
	dangerSoft: "var(--dsw-alias-state-error-secondary, rgba(220,38,38,0.12))"
};
const MONO = "ui-monospace, SFMono-Regular, Consolas, \"Liberation Mono\", Menlo, monospace";
const button = {
	display: "inline-flex",
	alignItems: "center",
	justifyContent: "center",
	minHeight: 32,
	padding: "5px 12px",
	fontSize: 12.5,
	lineHeight: 1.5,
	fontFamily: "inherit",
	fontWeight: 500,
	borderRadius: 8,
	border: `1px solid ${TOKEN.borderStrong}`,
	background: "transparent",
	color: TOKEN.secondary,
	cursor: "pointer",
	whiteSpace: "nowrap"
};
const chip = {
	display: "inline-flex",
	alignItems: "baseline",
	gap: 4,
	maxWidth: "100%",
	padding: "2px 7px",
	borderRadius: 5,
	fontSize: 11.5,
	lineHeight: 1.5,
	color: TOKEN.secondary,
	background: TOKEN.inset,
	overflowWrap: "anywhere"
};
const S = {
	root: {
		display: "flex",
		flexDirection: "column",
		gap: 16,
		width: "100%",
		minWidth: 0,
		maxWidth: 880,
		boxSizing: "border-box",
		padding: "16px 4px",
		color: TOKEN.primary,
		containerType: "inline-size",
		containerName: "dsh-library"
	},
	headingRow: {
		display: "flex",
		alignItems: "center",
		gap: 12,
		flexWrap: "wrap"
	},
	heading: {
		fontSize: 20,
		lineHeight: 1.4,
		fontWeight: 650,
		letterSpacing: "-0.025em",
		margin: 0
	},
	banner: {
		fontSize: 12.5,
		lineHeight: 1.65,
		padding: "10px 12px",
		borderRadius: 8,
		display: "flex",
		flexDirection: "column",
		gap: 6,
		overflowWrap: "anywhere"
	},
	bar: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap"
	},
	search: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		flex: "1 1 220px",
		minWidth: 0,
		minHeight: 34,
		padding: "6px 10px",
		border: `1px solid ${TOKEN.borderStrong}`,
		borderRadius: 8
	},
	searchInput: {
		flex: 1,
		minWidth: 0,
		border: "none",
		outline: "none",
		padding: 0,
		background: "transparent",
		color: "inherit",
		fontSize: 13,
		fontFamily: "inherit"
	},
	list: {
		display: "flex",
		flexDirection: "column",
		gap: 10
	},
	row: {
		minWidth: 0,
		border: `1px solid ${TOKEN.border}`,
		borderRadius: 12,
		background: TOKEN.surface,
		overflow: "hidden",
		transition: "border-color 140ms ease, box-shadow 140ms ease"
	},
	rowOpen: {
		borderColor: TOKEN.accent,
		boxShadow: `0 0 0 1px ${TOKEN.accentSoft}`
	},
	rowOff: { background: "transparent" },
	head: {
		display: "flex",
		alignItems: "flex-start",
		gap: 12,
		padding: "12px 16px 0 12px"
	},
	disclosure: {
		display: "flex",
		alignItems: "flex-start",
		flex: 1,
		minWidth: 0,
		gap: 6,
		minHeight: 28,
		padding: "2px 0",
		textAlign: "left",
		font: "inherit",
		border: 0,
		borderRadius: 4,
		color: TOKEN.primary,
		background: "transparent",
		cursor: "pointer"
	},
	titleRow: {
		display: "flex",
		flex: 1,
		minWidth: 0,
		alignItems: "center",
		gap: "5px 8px",
		flexWrap: "wrap"
	},
	chevron: {
		flex: "none",
		width: 18,
		height: 22,
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		color: TOKEN.muted,
		transition: "transform 140ms ease"
	},
	id: {
		fontSize: 14,
		lineHeight: 1.6,
		fontWeight: 650,
		fontFamily: MONO,
		overflowWrap: "anywhere",
		minWidth: 0
	},
	headToggle: {
		display: "flex",
		alignItems: "center",
		flex: "none",
		gap: 7,
		minHeight: 28,
		fontSize: 11.5,
		color: TOKEN.muted,
		cursor: "pointer"
	},
	overview: {
		display: "flex",
		flexDirection: "column",
		gap: 9,
		padding: "2px 16px 13px 36px",
		minWidth: 0
	},
	excerpt: {
		display: "-webkit-box",
		WebkitBoxOrient: "vertical",
		WebkitLineClamp: 2,
		overflow: "hidden",
		margin: 0,
		fontSize: 13,
		lineHeight: 1.65,
		color: TOKEN.secondary,
		overflowWrap: "anywhere"
	},
	route: {
		display: "flex",
		flexWrap: "wrap",
		alignItems: "baseline",
		gap: "2px 8px",
		minWidth: 0
	},
	metaLabel: {
		fontSize: 11.5,
		color: TOKEN.muted,
		flexShrink: 0
	},
	model: {
		fontFamily: MONO,
		fontSize: 12.5,
		fontWeight: 500,
		color: TOKEN.primary,
		overflowWrap: "anywhere",
		minWidth: 0,
		maxWidth: "100%"
	},
	provider: {
		fontFamily: MONO,
		fontSize: 11.5,
		color: TOKEN.muted,
		paddingLeft: 8,
		borderLeft: `1px solid ${TOKEN.borderStrong}`,
		overflowWrap: "anywhere",
		minWidth: 0,
		maxWidth: "100%"
	},
	glyph: chip,
	dirtyChip: {
		...chip,
		fontSize: 10.5,
		color: TOKEN.warn,
		background: TOKEN.warnSoft
	},
	body: {
		display: "flex",
		flexDirection: "column",
		gap: 13,
		padding: "12px 14px",
		borderTop: `1px solid ${TOKEN.divider}`
	},
	fieldLabel: {
		fontSize: 12,
		color: TOKEN.secondary,
		marginBottom: 6,
		display: "block"
	},
	field: {
		display: "flex",
		flexDirection: "column",
		minWidth: 0
	},
	grid: {
		display: "grid",
		gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
		gap: 12,
		alignItems: "start"
	},
	actions: {
		display: "flex",
		alignItems: "center",
		gap: 8,
		flexWrap: "wrap",
		paddingTop: 12,
		borderTop: `1px solid ${TOKEN.divider}`
	},
	spacer: { flex: 1 },
	input: {
		width: "100%",
		minHeight: 35,
		boxSizing: "border-box",
		fontSize: 13,
		fontFamily: MONO,
		lineHeight: 1.5,
		padding: "6px 9px",
		border: `1px solid ${TOKEN.borderStrong}`,
		borderRadius: 7,
		background: "transparent",
		color: "inherit"
	},
	prose: {
		width: "100%",
		minHeight: 64,
		boxSizing: "border-box",
		fontSize: 13,
		fontFamily: "inherit",
		lineHeight: 1.7,
		padding: "8px 10px",
		border: `1px solid ${TOKEN.borderStrong}`,
		borderRadius: 7,
		background: "transparent",
		color: "inherit",
		resize: "vertical",
		whiteSpace: "pre-wrap",
		overflowWrap: "anywhere"
	},
	button,
	primary: {
		...button,
		padding: "5px 13px",
		borderColor: "transparent",
		background: TOKEN.accentFill,
		color: "#fff"
	},
	danger: {
		...button,
		borderColor: TOKEN.dangerSoft,
		color: TOKEN.danger
	},
	ghost: {
		...button,
		borderColor: "transparent",
		color: TOKEN.muted
	},
	hint: {
		fontSize: 11.5,
		lineHeight: 1.65,
		color: TOKEN.muted,
		margin: 0,
		overflowWrap: "anywhere"
	},
	empty: {
		padding: "28px 16px",
		textAlign: "center",
		fontSize: 13,
		lineHeight: 1.7,
		color: TOKEN.muted,
		border: `1px dashed ${TOKEN.border}`,
		borderRadius: 10
	},
	footer: {
		padding: "4px 0",
		color: TOKEN.muted,
		overflowWrap: "anywhere"
	},
	footerSummary: {
		cursor: "pointer",
		fontSize: 11.5,
		paddingBottom: 8
	}
};
const BANNER = {
	ok: {
		...S.banner,
		background: TOKEN.successSoft,
		color: TOKEN.success
	},
	error: {
		...S.banner,
		background: TOKEN.dangerSoft
	},
	warn: {
		...S.banner,
		background: TOKEN.warnSoft
	},
	info: {
		...S.banner,
		background: TOKEN.inset
	}
};
/** Scoped styles travel with the client bundle; no extra host CSS loader. */
const SETTINGS_CSS = `
.dsh-library *, .dsh-library *::before { box-sizing: border-box; }
.dsh-library button:disabled { cursor: default !important; opacity: .5; }
.dsh-library :is(button, input, textarea, select, summary):focus-visible {
  outline: 2px solid ${TOKEN.accent}; outline-offset: 3px;
}
.dsh-library .library-search:focus-within {
  outline: 2px solid ${TOKEN.accent}; outline-offset: 2px;
}
.dsh-library .library-search input:focus-visible { outline: none; }
.dsh-library .library-panel { display: grid; gap: 14px; min-width: 0; }
.dsh-library .library-tabs { display: flex; gap: 18px; border-bottom: 1px solid ${TOKEN.border}; }
.dsh-library .library-tabs button {
  padding: 6px 3px 8px; border: 0; border-bottom: 2px solid transparent;
  background: transparent; color: ${TOKEN.secondary}; font: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
}
.dsh-library .library-tabs button[aria-selected=true] { color: ${TOKEN.accent}; border-color: currentColor; }
.dsh-library .library-editor { min-width: 0; border: 0; margin: 0; }
.dsh-library h3 { margin: 0; font-size: 13px; font-weight: 650; }
.dsh-library .library-editor textarea { min-height: 51px !important; }
.dsh-library .library-editor [data-field=assignment] { min-height: 35px !important; }
.dsh-library .library-editor input:read-only { background: ${TOKEN.inset} !important; }
.dsh-library .library-members-head {
  display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap;
  gap: 5px 10px; padding-top: 8px; border-top: 1px solid ${TOKEN.border};
}
.dsh-library .library-members { list-style: none; padding: 0; margin: 0; display: grid; gap: 8px; }
.dsh-library .library-members li {
  display: grid; gap: 7px; min-width: 0; padding: 8px 10px 10px;
  border: 1px solid ${TOKEN.border}; border-radius: 8px; background: var(--dsw-alias-bg-base, transparent);
}
.dsh-library .library-member-head { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; font-size: 12px; }
.dsh-library .library-member-head button { min-height: 27px !important; padding: 2px 6px !important; }
.dsh-library .library-link {
  border: 0 !important; padding: 0 !important; min-height: 0 !important; display: inline !important;
  color: ${TOKEN.accent} !important; white-space: normal !important; text-align: left; text-decoration: underline; overflow-wrap: anywhere;
}
.dsh-library .library-field-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 2px 8px; padding-top: 2px; }
.dsh-library .library-field-actions > button { min-height: 24px !important; }
.dsh-library .library-field-note { padding-top: 4px; }
.dsh-library .library-field-error { color: ${TOKEN.danger}; font-size: 11.5px; line-height: 1.65; overflow-wrap: anywhere; }
.dsh-library .library-field-error:not(:empty) { margin-top: 4px; }
.dsh-library [data-field=slot][aria-invalid=true] { border-color: ${TOKEN.danger} !important; }
.dsh-library [data-field=role-id] { user-select: text; }
.dsh-library .library-refs ul { padding-inline-start: 19px; margin: 4px 0; }
.dsh-library .library-dialog {
  width: min(540px, calc(100% - 32px)); max-height: calc(100% - 32px); padding: 17px;
  border: 1px solid ${TOKEN.borderStrong}; border-radius: 12px; background: var(--dsw-alias-bg-base, Canvas);
  color: var(--dsw-alias-label-primary, CanvasText); box-shadow: 0 8px 30px #13182633; font: inherit; font-size: 13px;
}
.dsh-library .library-dialog::backdrop { background: #10152260; }
.dsh-library .library-compare { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 10px; margin-top: 10px; }
.dsh-library .library-compare article { background: ${TOKEN.inset}; padding: 8px; border-radius: 8px; white-space: pre-wrap; overflow-wrap: anywhere; }
.dsh-library .library-compare dl { margin: 5px 0 0; }
.dsh-library .library-compare dt, .dsh-library .library-compare dd { display: inline; margin: 0; }
.dsh-library .library-compare dt { font-weight: 600; margin-inline-end: 5px; }
.dsh-library select option { background: ${TOKEN.surface}; color: ${TOKEN.primary}; }
.dsh-library-switch {
  appearance: none; position: relative; display: inline-block; flex: none;
  width: 30px; height: 18px; margin: 0; border: 1px solid ${TOKEN.borderStrong};
  border-radius: 999px; background: ${TOKEN.hover}; cursor: pointer;
  transition: background 140ms ease;
}
.dsh-library-switch::before {
  content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px;
  border-radius: 50%; background: ${TOKEN.muted}; transition: transform 140ms ease;
}
.dsh-library-switch:checked { background: ${TOKEN.accentFill}; border-color: transparent; }
.dsh-library-switch:checked::before { transform: translateX(12px); background: #fff; }
@container dsh-library (max-width: 285px) {
  .dsh-library .library-grid, .dsh-library .library-compare { grid-template-columns: minmax(0, 1fr) !important; }
}
@media (hover: hover) {
  .dsh-library-card:hover { border-color: ${TOKEN.borderStrong}; }
  .dsh-library-disclosure:hover { color: ${TOKEN.accent} !important; }
  .dsh-library button:not(:disabled):hover { filter: brightness(.96); }
}
@media (prefers-reduced-motion: reduce) {
  .dsh-library *, .dsh-library *::before { transition: none !important; }
}
@media (forced-colors: active) {
  .dsh-library-switch { appearance: auto; }
  .dsh-library-switch::before { display: none; }
}
`;

//#endregion
//#region src/client/editor-fields.tsx
function Action({ action, tone = "button", children,...props }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
		...props,
		type: "button",
		"data-action": action,
		style: {
			...S[tone],
			...props.style
		},
		children
	});
}
function Field({ label, name, value, change, multiline, hint, describedBy,...props }) {
	const id = (0, react.useId)();
	const hintId = hint ? `${id}-hint` : void 0;
	const description = [describedBy, hintId].filter(Boolean).join(" ") || void 0;
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		style: S.field,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
				htmlFor: id,
				style: S.fieldLabel,
				children: label
			}),
			multiline ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("textarea", {
				id,
				"aria-describedby": description,
				"data-field": name,
				value,
				rows: name === "assignment" ? 1 : 2,
				placeholder: props.placeholder,
				onChange: (e) => change?.(e.target.value),
				style: S.prose
			}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
				...props,
				id,
				"aria-describedby": description,
				"data-field": name,
				type: props.min === void 0 ? "text" : "number",
				value,
				onChange: (e) => change?.(e.target.value),
				style: S.input
			}),
			hint && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				id: hintId,
				className: "library-field-note",
				style: S.hint,
				children: hint
			})
		]
	});
}
function References({ refs, view, jump, title }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "library-refs",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: title }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("ul", { children: refs.map((ref) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("li", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Action, {
			action: "jump",
			"data-group": ref.groupId,
			"data-slot-id": ref.slot,
			className: "library-link",
			onClick: () => jump(ref),
			children: [
				own(view.groups, ref.groupId)?.name || ref.groupId,
				" / ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: ref.slot })
			]
		}) }, ref.groupId + "/" + ref.slot)) })]
	});
}
function availability(role) {
	if (!role) return "角色缺失";
	if (role.enabled === false) return "角色已停用";
	if (role.toolFilter) return "旧工具限制";
	if (role.launchable === false) {
		if (role.routeNote === "profile-missing") return "当前 Provider 未注册";
		if (role.routeNote === "overlay-broken") return "当前路由无法读取";
		if (role.maxDepth === 0 || role.reason?.startsWith("maxDepth is 0")) return "深度上限为 0";
		if (role.reason?.includes("native named activations")) return "宿主缺少原生具名派遣支持";
		if (role.reason?.startsWith("subagent transport provider")) return "传输层未注册";
		if (role.reason?.startsWith("Transport ")) return "传输层无法执行当前配置";
		return "暂时无法派遣";
	}
	return "";
}
function memberState(view, form, member) {
	if (!form.enabled) return "编队已停用";
	if (!member.role) return "";
	const reason = availability(own(view.entries, member.role));
	if (reason) return reason;
	const saved = own(view.groups, form.id);
	if (saved && saved.enabled !== false && saved.members.some((m) => m.slot === member.slot && m.role === member.role && m.launchable === false)) return "暂时无法派遣";
	return "";
}
const notes = {
	"profile": "使用当前 profile 的独立路由。",
	"inherit": "当前 profile 已设置为跟随会话。",
	"foreign-ignored": "共享 Provider 未在此 profile 注册，当前跟随会话。",
	"profile-missing": "当前 profile 的 Provider 尚未注册，可更换 Provider 或使用会话模型。",
	"overlay-broken": "当前 profile 的路由无法读取，可重新设置或使用会话模型。"
};
function RoleFields({ form, isNew, change, view, refs, jump }) {
	const patch = (values) => change({
		...form,
		...values
	});
	const route = (field, value) => patch({
		[field]: value,
		inherit: false
	});
	const saved = own(view.entries, form.id);
	const routeReadOnly = !!view.routeWriteProblem;
	const hasRoute = [
		form.provider,
		form.model,
		form.reasoningEffort,
		form.maxTokens
	].some((value) => value.trim());
	const clearRoute = (inherit) => patch({
		inherit,
		provider: "",
		model: "",
		reasoningEffort: "",
		maxTokens: ""
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		saved?.launchable === false && saved.enabled !== false && !saved.toolFilter && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: BANNER.warn,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: availability(saved) }), saved.reason && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: saved.reason })]
		}),
		isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
			name: "id",
			label: "角色 ID",
			value: form.id,
			change: (id) => patch({ id }),
			placeholder: "reviewer"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
			name: "description",
			label: "角色描述",
			multiline: true,
			value: form.description,
			change: (description) => patch({ description })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("h3", { children: [view.profile || routeReadOnly ? "模型路由" : "共享模型路由", view.profile && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
			style: S.hint,
			children: [" · ", view.profile]
		})] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
			style: S.hint,
			children: view.routeWriteProblem ?? (view.profile ? form.routeNote ? notes[form.routeNote] : "模型与思考档位只应用于当前 profile。" : "这里编辑角色的共享默认路由。全部留空后保存，共享默认将跟随会话。共享路由变更后，绑定旧默认路由的 profile 需重新设置。")
		})] }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "library-grid",
			style: S.grid,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					name: "provider",
					label: "Provider",
					value: form.provider,
					change: (v) => route("provider", v),
					readOnly: routeReadOnly,
					placeholder: "跟随会话"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					name: "model",
					label: "模型",
					value: form.model,
					change: (v) => route("model", v),
					readOnly: routeReadOnly,
					placeholder: "跟随会话"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					name: "reasoningEffort",
					label: "思考档位",
					value: form.reasoningEffort,
					change: (v) => route("reasoningEffort", v),
					readOnly: routeReadOnly,
					placeholder: "例如 high"
				}),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
					name: "maxTokens",
					label: "输出上限",
					value: form.maxTokens,
					change: (v) => route("maxTokens", v),
					readOnly: routeReadOnly,
					min: 1,
					placeholder: "tokens"
				})
			]
		}),
		!routeReadOnly && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: view.profile ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
			action: "inherit",
			disabled: form.inherit || form.routeNote === "inherit" && !hasRoute,
			onClick: () => clearRoute(true),
			children: form.inherit ? "保存后使用会话模型" : "使用会话模型"
		}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
			action: "clear-shared-route",
			disabled: !hasRoute,
			onClick: () => clearRoute(false),
			children: "清空共享路由"
		}) }),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "library-grid",
			style: S.grid,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				name: "subagentProvider",
				label: "传输层",
				value: form.subagentProvider,
				change: (subagentProvider) => patch({ subagentProvider }),
				placeholder: "spawn（默认）"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				name: "maxDepth",
				label: "深度上限",
				value: form.maxDepth,
				change: (maxDepth) => patch({ maxDepth }),
				min: 0,
				placeholder: "跟随宿主",
				hint: "留空时跟随宿主。填写后使用宿主与角色上限中较低的值，填 0 禁止派遣。"
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
			name: "persona",
			label: "角色人设",
			multiline: true,
			value: form.persona,
			change: (persona) => patch({ persona })
		}),
		form.filter && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: BANNER.warn,
			children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "旧工具限制" }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "这个角色的工具限制无法在当前宿主执行。解除限制后可按宿主的权限派遣。" }),
				form.filter.allow && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["允许：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: form.filter.allow.join(", ") || "空列表" })] }),
				form.filter.deny && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: ["禁用：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: form.filter.deny.join(", ") || "空列表" })] }),
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
					type: "checkbox",
					"data-field": "clearToolFilter",
					checked: form.clearToolFilter,
					onChange: (e) => patch({ clearToolFilter: e.target.checked })
				}), " 保存时解除旧工具限制"] })
			]
		}),
		refs.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: form.enabled ? BANNER.info : BANNER.warn,
			children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(References, {
				refs,
				view,
				jump,
				title: form.enabled ? "使用此角色的编队成员" : "停用角色后，以下成员将无法派遣"
			})
		})
	] });
}
function copySelection(id, doc) {
	const focused = doc.activeElement;
	const input = doc.createElement("textarea");
	input.value = id;
	input.readOnly = true;
	Object.assign(input.style, {
		position: "fixed",
		inset: "0 auto auto 0",
		opacity: "0",
		pointerEvents: "none"
	});
	doc.body.append(input);
	try {
		input.focus({ preventScroll: true });
		input.select();
		return doc.execCommand("copy");
	} catch {
		return false;
	} finally {
		input.remove();
		focused?.focus({ preventScroll: true });
	}
}
function RoleIdCopy({ id }) {
	const [status, setStatus] = (0, react.useState)();
	const manualInput = (0, react.useRef)(null);
	const trigger = (0, react.useRef)();
	const selectId = (0, react.useCallback)((input) => {
		manualInput.current = input;
		if (trigger.current?.matches(":focus")) {
			input?.focus({ preventScroll: true });
			input?.select();
		}
	}, []);
	async function copy(event) {
		const button$1 = event.currentTarget;
		trigger.current = button$1;
		try {
			await navigator.clipboard.writeText(id);
			setStatus("copied");
			return;
		} catch {
			if (!button$1.isConnected) return;
		}
		if (copySelection(id, button$1.ownerDocument)) {
			setStatus("copied");
			return;
		}
		setStatus("manual");
		selectId(manualInput.current);
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "library-field-actions",
		children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
			action: "copy-role-id",
			className: "library-link",
			"aria-label": "复制角色 ID",
			onClick: copy,
			children: "复制 ID"
		}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
			style: S.hint,
			role: "status",
			children: status === "copied" ? "已复制" : status === "manual" ? "请手动复制下方 ID" : ""
		})]
	}), status === "manual" && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
		ref: selectId,
		"data-field": "role-id",
		"aria-label": "角色 ID",
		style: S.input,
		value: id,
		readOnly: true,
		onFocus: (event) => event.currentTarget.select()
	})] });
}
function GroupFields({ form, isNew, change, view, message }) {
	const id = (0, react.useId)();
	const rulesId = `${id}-slot-rules`;
	const list = (0, react.useRef)(null);
	const addButton = (0, react.useRef)(null);
	const slots = form.members.map((member) => member.slot);
	const slotErrors = memberCodeErrors(slots);
	const usedSlots = new Set(slots.map((slot) => slot.trim()));
	const patch = (values) => change({
		...form,
		...values
	});
	const patchMember = (i, values) => patch({ members: form.members.map((member, index) => index === i ? {
		...member,
		...values
	} : member) });
	const focus = (i) => requestAnimationFrame(() => {
		(list.current?.children[i]?.querySelector("[data-field=\"slot\"]") ?? addButton.current?.querySelector("button"))?.focus();
	});
	function move(i, to) {
		const members = [...form.members];
		const [member] = members.splice(i, 1);
		members.splice(to, 0, member);
		patch({ members });
		focus(to);
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			style: BANNER.warn,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
				id: rulesId,
				"data-slot-rules": true,
				children: [
					isNew ? "编队 ID 和成员代号" : "成员代号",
					"请用小写字母、数字或短横线，最多 ",
					MAX_ID_LENGTH,
					" 个字符。中间不能有空格，开头不能用短横线。组内代号不能重复。"
				]
			}), message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
				role: "alert",
				children: message
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "library-grid",
			style: S.grid,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				name: "name",
				label: "编队名称",
				value: form.name,
				change: (name) => patch({ name }),
				placeholder: "留空时使用编队 ID"
			}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
				name: "id",
				label: "编队 ID",
				value: form.id,
				change: (id$1) => patch({ id: id$1 }),
				describedBy: isNew ? rulesId : void 0,
				readOnly: !isNew,
				placeholder: "change-review"
			})]
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
			name: "description",
			label: "编队描述",
			multiline: true,
			value: form.description,
			change: (description) => patch({ description })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
			name: "instructions",
			label: "共享说明",
			multiline: true,
			value: form.instructions,
			change: (instructions) => patch({ instructions })
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
			className: "library-members-head",
			ref: addButton,
			children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", { children: "编队成员" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
				action: "add-slot",
				onClick: () => {
					patch({ members: [...form.members, emptyMember()] });
					focus(form.members.length);
				},
				children: "＋ 添加成员"
			})]
		}),
		!form.members.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
			style: S.empty,
			children: "添加至少一名成员。"
		}),
		/* @__PURE__ */ (0, react_jsx_runtime.jsx)("ol", {
			className: "library-members",
			ref: list,
			children: form.members.map((member, i) => {
				const role = own(view.entries, member.role);
				const state = memberState(view, form, member);
				const slotId = `${id}-slot-${i}`;
				const error = (member.slot || member.role) && slotErrors[i];
				const errorId = `${slotId}-error`;
				const canUseRoleId = role && !member.slot.trim() && !entryIdIssue(member.role);
				const roleIdUsed = canUseRoleId && usedSlots.has(member.role);
				return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("li", {
					"data-slot": i,
					"data-slot-key": member.slot,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "library-member-head",
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["成员 ", i + 1] }),
								state && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									style: S.dirtyChip,
									children: state
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: S.spacer }),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
									action: "up",
									"aria-label": `上移成员 ${i + 1}`,
									title: "上移",
									disabled: i === 0,
									onClick: () => move(i, i - 1),
									children: "↑"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
									action: "down",
									"aria-label": `下移成员 ${i + 1}`,
									title: "下移",
									disabled: i + 1 === form.members.length,
									onClick: () => move(i, i + 1),
									children: "↓"
								}),
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
									action: "remove",
									tone: "danger",
									"aria-label": `移除成员 ${i + 1}`,
									onClick: () => {
										patch({ members: form.members.filter((_, n) => n !== i) });
										focus(Math.min(i, form.members.length - 2));
									},
									children: "移除"
								})
							]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							className: "library-grid",
							style: S.grid,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: S.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: slotId,
										style: S.fieldLabel,
										children: "成员代号"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
										id: slotId,
										style: S.input,
										"data-field": "slot",
										value: member.slot,
										placeholder: "例如 review",
										autoComplete: "off",
										autoCapitalize: "none",
										spellCheck: false,
										"aria-invalid": !!error || void 0,
										"aria-describedby": error ? `${rulesId} ${errorId}` : rulesId,
										onChange: (e) => patchMember(i, { slot: e.target.value })
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
										id: errorId,
										"data-slot-error": true,
										className: "library-field-error",
										"aria-live": "polite",
										children: error
									}),
									canUseRoleId && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										className: "library-field-actions",
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
											action: "use-role-id",
											className: "library-link",
											disabled: roleIdUsed,
											onClick: () => {
												patchMember(i, { slot: member.role });
												focus(i);
											},
											children: "用角色 ID"
										}), roleIdUsed && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
											style: S.hint,
											children: "此代号已使用"
										})]
									})
								]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
								style: S.field,
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("label", {
										htmlFor: `${slotId}-role`,
										style: S.fieldLabel,
										children: "角色"
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("select", {
										id: `${slotId}-role`,
										style: S.input,
										"data-field": "role",
										value: member.role,
										onChange: (e) => patchMember(i, { role: e.target.value }),
										children: [
											/* @__PURE__ */ (0, react_jsx_runtime.jsx)("option", {
												value: "",
												children: "选择名册中的角色"
											}),
											member.role && !role && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: member.role,
												children: [member.role, " · 角色缺失"]
											}),
											Object.entries(view.entries).map(([id$1, row]) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("option", {
												value: id$1,
												children: [id$1, availability(row) && " · " + availability(row)]
											}, id$1))
										]
									}),
									member.role && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleIdCopy, { id: member.role }, member.role)
								]
							})]
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Field, {
							name: "assignment",
							label: "默认分工",
							multiline: true,
							value: member.assignment,
							change: (assignment) => patchMember(i, { assignment }),
							placeholder: "例如：检查这次改动会不会影响已有功能"
						})
					]
				}, i);
			})
		})
	] });
}

//#endregion
//#region src/client/LibrarySettings.tsx
function Modal({ dialog, close }) {
	const ref = (0, react.useRef)(null);
	const id = (0, react.useId)();
	(0, react.useEffect)(() => {
		const node = ref.current;
		node?.showModal();
		return () => {
			node?.close();
		};
	}, []);
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("dialog", {
		className: "library-dialog",
		ref,
		"aria-labelledby": id,
		onCancel: close,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h3", {
				id,
				children: dialog.title
			}),
			dialog.content,
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				style: S.actions,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: S.spacer }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
						action: "cancel",
						autoFocus: true,
						onClick: close,
						children: "取消"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
						action: "confirm",
						tone: dialog.destructive ? "danger" : "primary",
						onClick: () => {
							close();
							dialog.confirm();
						},
						children: dialog.label
					})
				]
			})
		]
	});
}
function CompareForm({ form }) {
	if (!form) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "条目已删除或尚未创建。" });
	const rows = [
		["ID", form.id],
		["状态", form.enabled ? "已启用" : "已停用"],
		["描述", form.description]
	];
	if (form.kind === "groups") {
		rows.push(["名称", form.name], ["共享说明", form.instructions]);
		form.members.forEach((m) => rows.push([m.slot || "成员", [m.role, m.assignment].filter(Boolean).join(" / ")]));
	} else {
		rows.push(["Provider", form.provider], ["模型", form.model], ["思考档位", form.reasoningEffort], ["输出上限", form.maxTokens], ["传输层", form.subagentProvider], ["深度上限", form.maxDepth], ["角色人设", form.persona]);
		if (form.inherit || form.routeNote) rows.push(["路由状态", form.inherit ? "保存后使用会话模型" : {
			profile: "当前 profile 路由",
			inherit: "使用会话模型",
			"foreign-ignored": "共享 Provider 未注册",
			"profile-missing": "当前 Provider 未注册",
			"overlay-broken": "路由无法读取"
		}[form.routeNote]]);
		if (form.filter) rows.push(["旧工具限制", form.clearToolFilter ? "保存时解除" : JSON.stringify(form.filter)]);
	}
	return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dl", { children: rows.map(([name, value], i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("dt", { children: name }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("dd", { children: value || "—" })] }, i)) });
}
function LibrarySettings({ readView: readView$1, writeView: writeView$1, subscribeRefresh }) {
	const scope = (0, react.useId)();
	const root = (0, react.useRef)(null);
	const [view, setView] = (0, react.useState)(null);
	const [tab, setTab] = (0, react.useState)("roles");
	const [filters, setFilters] = (0, react.useState)({
		roles: "",
		groups: ""
	});
	const [expanded, setExpanded] = (0, react.useState)({});
	const [drafts, setDrafts] = (0, react.useState)({});
	const [busy, setBusy] = (0, react.useState)(false);
	const [notice, setNotice] = (0, react.useState)();
	const [dialog, setDialog] = (0, react.useState)();
	const active = (0, react.useRef)(false);
	const writing = (0, react.useRef)(false);
	const pendingRefresh = (0, react.useRef)(false);
	const readNumber = (0, react.useRef)(0);
	const load = (0, react.useCallback)(async (manual = false) => {
		if (writing.current) {
			pendingRefresh.current = true;
			return;
		}
		const request = ++readNumber.current;
		try {
			const latest = await readView$1();
			if (!active.current || request !== readNumber.current) return;
			setView(latest);
			setDrafts((rows) => {
				if (!Object.values(rows).some((row) => row.awaitingCurrent)) return rows;
				return Object.fromEntries(Object.entries(rows).map(([id, row]) => [id, row.awaitingCurrent ? {
					...row,
					awaitingCurrent: false
				} : row]));
			});
			if (manual) setNotice({ text: "已读取当前配置。" });
		} catch (error) {
			if (active.current && request === readNumber.current) setNotice({
				text: String(error),
				error: true
			});
		}
	}, [readView$1]);
	(0, react.useEffect)(() => {
		active.current = true;
		load();
		const unsubscribe = subscribeRefresh(() => {
			load();
		});
		return () => {
			active.current = false;
			readNumber.current++;
			unsubscribe();
		};
	}, [load, subscribeRefresh]);
	const keyFor = (kind, id) => kind + "/" + id;
	const key = (id) => keyFor(tab, id);
	const label = tab === "roles" ? "角色" : "编队";
	const readonly = busy || !view?.writable;
	function put(k, draft) {
		setDrafts((current) => {
			const next = { ...current };
			if (draft) next[k] = draft;
			else delete next[k];
			return next;
		});
	}
	function reveal(id, slot) {
		requestAnimationFrame(() => {
			const card = root.current?.querySelector(`[data-card="${CSS.escape(id)}"]`);
			const target = slot && card?.querySelector(`[data-slot-key="${CSS.escape(slot)}"] [data-field="slot"]`) || card?.querySelector("[data-row-id]");
			target?.focus({ preventScroll: true });
			target?.scrollIntoView({ block: "nearest" });
		});
	}
	function jump(ref) {
		setTab("groups");
		setFilters((old) => ({
			...old,
			groups: ""
		}));
		setExpanded((old) => ({
			...old,
			[keyFor("groups", ref.groupId)]: true
		}));
		setNotice(void 0);
		reveal(ref.groupId, ref.slot);
	}
	function changeTab(next, focus) {
		setTab(next);
		setNotice(void 0);
		if (focus) requestAnimationFrame(() => root.current?.querySelector(`[data-tab="${next}"]`)?.focus());
	}
	async function write(operation, row, success = "已保存。") {
		if (writing.current) return;
		writing.current = true;
		readNumber.current++;
		setBusy(true);
		setNotice(void 0);
		const k = row && key(row.id);
		try {
			const result = await writeView$1(operation);
			if (!active.current) return;
			if (result.ok) {
				setView(result.view);
				if (k && row) {
					put(k, void 0);
					setExpanded((old) => ({
						...old,
						[k]: false
					}));
					if (operation.op === "save-entry" || operation.op === "save-group") reveal(operation.id);
					else requestAnimationFrame(() => root.current?.querySelector("[data-action=\"new\"]")?.focus());
				}
				setNotice({ text: success });
			} else {
				if (result.view) setView(result.view);
				if (k && row) {
					put(k, {
						...row.draft,
						conflict: result.conflict,
						message: result.conflict ? void 0 : result.message ?? "保存失败。",
						references: result.references,
						awaitingCurrent: result.conflict && !result.view
					});
					setExpanded((old) => ({
						...old,
						[k]: true
					}));
					if (result.conflict && !result.view) pendingRefresh.current = true;
					if (result.references?.length && !result.view) pendingRefresh.current = true;
				} else setNotice({
					text: result.message ?? "配置发生变化，请刷新后重试。",
					error: true
				});
			}
		} catch (error) {
			if (active.current) setNotice({
				text: String(error),
				error: true
			});
		} finally {
			writing.current = false;
			if (active.current) {
				setBusy(false);
				if (pendingRefresh.current) {
					pendingRefresh.current = false;
					load();
				}
			}
		}
	}
	if (!view) return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		className: "dsh-library",
		style: S.root,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: SETTINGS_CSS }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
				style: S.heading,
				children: "子代理库"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				role: "status",
				children: notice?.text ?? "正在加载…"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
				action: "refresh",
				onClick: () => void load(true),
				children: "重试"
			}) })
		]
	});
	const currentView = view;
	function add() {
		const k = key(NEW);
		put(k, freshDraft(currentView, tab, NEW));
		setExpanded((old) => ({
			...old,
			[k]: true
		}));
		setNotice(void 0);
		reveal(NEW);
	}
	function compare(id, draft) {
		const current = serverForm(currentView, tab, id === NEW ? draft.form.id.trim() : id);
		const collision = id === NEW && !!current;
		const recreate = !current && id !== NEW;
		const competingMembers = draft.form.kind === "groups" && draft.base?.kind === "groups" && current?.kind === "groups" && !equal(draft.base.members, draft.form.members) && !equal(draft.base.members, current.members) && !equal(current.members, draft.form.members);
		setDialog({
			title: "配置版本有冲突",
			label: collision ? "返回更换 ID" : recreate ? "保留草稿为新条目" : "保留草稿，继续编辑",
			content: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
				/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					className: "library-compare",
					children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "当前配置" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CompareForm, { form: current })] }), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: "你的草稿" }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)(CompareForm, { form: draft.form })] })]
				}),
				competingMembers && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: BANNER.warn,
					children: "双方都修改了编队成员。保留草稿将采用你这份完整的成员名单和分工。"
				}),
				collision ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "这个 ID 已有配置。请为新条目更换 ID 后再创建。" }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: ["保留已编辑的字段，其他字段采用当前配置。", recreate ? "再次保存将重新创建这个条目。" : "再次保存才会写入配置。"] })
			] }),
			confirm: () => {
				if (!collision) {
					put(key(id), rebase(draft, current));
					return;
				}
				requestAnimationFrame(() => root.current?.querySelector("[data-card=\"@new\"] [data-field=\"id\"]")?.focus());
			}
		});
	}
	function remove(id, draft) {
		const refs = tab === "roles" ? own(currentView.roleUsages, id) : void 0;
		if (refs?.length) {
			put(key(id), {
				...draft,
				references: refs
			});
			return;
		}
		setDialog({
			title: "删除" + label,
			label: "确认删除",
			destructive: true,
			content: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", { children: [
				"确定删除 ",
				/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", { children: draft.form.kind === "groups" && draft.form.name || id }),
				"？",
				tab === "groups" && "名册中的角色仍可单独使用。"
			] }),
			confirm: () => void write({
				op: tab === "roles" ? "delete" : "delete-group",
				id,
				expectedHash: currentView.hash
			}, {
				id,
				draft
			}, "已删除" + label + " " + id + "。")
		});
	}
	const needle = filters[tab].trim().toLowerCase();
	const serverIds = Object.keys(tab === "roles" ? view.entries : view.groups);
	const ids = [...new Set([...Object.keys(drafts).filter((k) => k.startsWith(tab + "/") && !serverIds.includes(k.slice(tab.length + 1))).map((k) => k.slice(tab.length + 1)), ...serverIds])].filter((id) => {
		if (!needle || id === NEW || drafts[key(id)] && expanded[key(id)]) return true;
		const form = drafts[key(id)]?.form ?? serverForm(view, tab, id);
		return form && [
			id,
			form.description,
			...form.kind === "roles" ? [
				form.model,
				form.provider,
				form.persona,
				form.reasoningEffort
			] : [form.name]
		].some((s) => s.toLowerCase().includes(needle));
	});
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
		ref: root,
		className: "dsh-library",
		style: S.root,
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("style", { children: SETTINGS_CSS }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("header", {
				style: S.headingRow,
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("h2", {
						style: S.heading,
						children: "子代理库"
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: S.spacer }),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
						action: "refresh",
						disabled: busy,
						onClick: () => void load(true),
						children: "刷新"
					})
				]
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				className: "library-tabs",
				role: "tablist",
				"aria-label": "设置分类",
				children: ["roles", "groups"].map((kind) => /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
					type: "button",
					role: "tab",
					"data-tab": kind,
					id: scope + kind,
					"aria-controls": scope + "-panel",
					"aria-selected": tab === kind,
					tabIndex: tab === kind ? 0 : -1,
					onClick: () => changeTab(kind, false),
					onKeyDown: (e) => {
						if ([
							"ArrowLeft",
							"ArrowRight",
							"Home",
							"End"
						].includes(e.key)) {
							e.preventDefault();
							changeTab(e.key === "Home" ? "roles" : e.key === "End" ? "groups" : tab === "groups" ? "roles" : "groups", true);
						}
					},
					children: kind === "roles" ? "角色名册" : "编队"
				}, kind))
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("section", {
				role: "tabpanel",
				id: scope + "-panel",
				"aria-labelledby": scope + tab,
				className: "library-panel",
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						style: BANNER.info,
						children: tab === "roles" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							view.profile && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("strong", { children: ["当前 profile：", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: view.profile })] }), "。"] }),
							"角色配置由引用它的编队共享。",
							view.profile && "模型路由按 profile 保存。"
						] }) : "编队支持逐个派遣，开启或关闭智能体团队均可使用。"
					}),
					view.diagnostics?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						style: BANNER.warn,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("summary", { children: [
							"配置诊断（",
							view.diagnostics.length,
							"）"
						] }), view.diagnostics.map((item, i) => /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", { children: [
							item.file ?? item.id,
							" ",
							item.message
						] }, i))]
					}) : null,
					tab === "roles" && (view.legacyCount ?? 0) > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: BANNER.info,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", { children: [
							"名册已接管 ",
							view.legacyCount,
							" 个旧条目。确认迁移后可清除旧配置中的角色副本。"
						] }), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
							action: "clear-legacy",
							disabled: readonly,
							onClick: () => setDialog({
								title: "清除旧副本",
								label: "确认清除",
								content: /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", { children: "清除旧配置中已迁移的角色副本？名册文件会保留。" }),
								destructive: true,
								confirm: () => void write({
									op: "clear-legacy",
									expectedHash: view.hash
								}, void 0, "已清除旧副本。")
							}),
							children: "清除旧副本"
						}) })]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.bar,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
							className: "library-search",
							style: S.search,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
								"aria-hidden": "true",
								width: "15",
								height: "15",
								viewBox: "0 0 24 24",
								fill: "none",
								stroke: "currentColor",
								strokeWidth: "2",
								children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
									cx: "10.5",
									cy: "10.5",
									r: "5.5"
								}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "m15 15 5 5" })]
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
								type: "search",
								"aria-label": "筛选" + label,
								value: filters[tab],
								placeholder: tab === "roles" ? "筛选角色 ID、描述、模型" : "筛选编队名称、ID、描述",
								onChange: (e) => setFilters({
									...filters,
									[tab]: e.target.value
								}),
								style: S.searchInput
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Action, {
							action: "new",
							tone: "primary",
							disabled: readonly || !!drafts[key(NEW)],
							onClick: add,
							children: [
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
									"aria-hidden": "true",
									children: "＋ "
								}),
								"新建",
								label
							]
						})]
					}),
					notice && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
						role: "status",
						style: notice.error ? BANNER.error : BANNER.ok,
						children: notice.text
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
						style: S.list,
						children: [!ids.length && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: S.empty,
							children: needle ? "没有匹配的条目。" : "暂无" + label + "。"
						}), ids.map((id) => {
							const k = key(id);
							const draft = drafts[k] ?? freshDraft(view, tab, id);
							const form = draft.form;
							const open = Boolean(expanded[k]);
							const isNew = id === NEW;
							const current = serverForm(view, tab, isNew ? form.id.trim() : id);
							const collision = isNew && !!current;
							const stale = Boolean(draft.conflict || !equal(draft.base, current));
							const dirty = !equal(draft.base, form);
							const refs = own(view.roleUsages, id) ?? [];
							const blocked = form.kind === "groups" ? form.members.filter((m) => memberState(view, form, m)).length : 0;
							const roleState = form.kind === "roles" && availability(own(view.entries, id));
							const contentId = scope + tab + id;
							function change(next) {
								put(k, equal(draft.base, next) && !stale ? void 0 : {
									...draft,
									form: next,
									message: void 0,
									references: void 0,
									conflict: isNew && form.id !== next.id && !draft.awaitingCurrent ? false : draft.conflict
								});
								setNotice(void 0);
							}
							return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("article", {
								className: "dsh-library-card",
								"data-card": id,
								style: {
									...S.row,
									...!form.enabled && S.rowOff,
									...open && S.rowOpen
								},
								children: [
									/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: S.head,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
											type: "button",
											style: S.disclosure,
											className: "dsh-library-disclosure",
											"data-row-id": id,
											"data-action": "toggle",
											"aria-expanded": open,
											"aria-controls": contentId,
											onClick: () => setExpanded((old) => ({
												...old,
												[k]: !open
											})),
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
												"aria-hidden": "true",
												style: {
													...S.chevron,
													transform: open ? "rotate(90deg)" : void 0
												},
												children: "❯"
											}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: S.titleRow,
												children: [
													/* @__PURE__ */ (0, react_jsx_runtime.jsx)("strong", {
														style: form.kind === "roles" ? S.id : void 0,
														children: isNew ? "新建" + label : form.kind === "groups" ? form.name || id : id
													}),
													dirty && !isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: S.dirtyChip,
														children: "未保存"
													}),
													stale && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
														style: S.dirtyChip,
														children: "版本冲突"
													})
												]
											})]
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("label", {
											style: S.headToggle,
											children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("input", {
												className: "dsh-library-switch",
												type: "checkbox",
												role: "switch",
												"data-field": "enabled",
												"aria-label": label + "启用状态",
												checked: form.enabled,
												disabled: readonly,
												onChange: (e) => {
													change({
														...form,
														enabled: e.target.checked
													});
													setExpanded((old) => ({
														...old,
														[k]: true
													}));
												}
											}), form.enabled ? "已启用" : "已停用"]
										})]
									}),
									!open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
										style: S.overview,
										children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
											style: S.excerpt,
											children: form.description || "填写" + label + "的用途。"
										}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
											style: S.route,
											children: form.kind === "groups" ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: S.metaLabel,
												children: [form.members.length, " 名成员"]
											}), blocked > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
												style: S.dirtyChip,
												children: [blocked, " 名暂时无法派遣"]
											})] }) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: S.metaLabel,
													children: "模型"
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
													style: S.model,
													children: form.model || "跟随会话"
												}),
												form.provider && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
													style: S.provider,
													children: form.provider
												}),
												form.reasoningEffort && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: S.glyph,
													children: ["思考 ", form.reasoningEffort]
												}),
												refs.length > 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("span", {
													style: S.glyph,
													children: [refs.length, " 名编队成员在用"]
												}),
												roleState && !isNew && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
													style: S.dirtyChip,
													children: roleState
												})
											] })
										})]
									}),
									/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
										id: contentId,
										hidden: !open,
										children: open && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("fieldset", {
											disabled: readonly,
											className: "library-editor",
											style: S.body,
											children: [
												stale && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													role: "alert",
													style: BANNER.warn,
													children: [collision ? "这个 ID 已有配置，请更换 ID 再创建。" : "配置已在别处更新，你的草稿已保留。", /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", { children: draft.awaitingCurrent ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
														action: "refresh",
														onClick: () => void load(true),
														children: "重新读取当前版本"
													}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
														action: "compare",
														className: "library-link",
														onClick: () => compare(id, draft),
														children: "查看当前版本"
													}) })]
												}),
												draft.references?.length ? /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													role: "alert",
													style: BANNER.warn,
													children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(References, {
														refs: draft.references,
														view,
														jump,
														title: "无法删除，以下编队成员还在使用这个角色"
													}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { children: "请给这些成员更换角色，或将他们移出编队后再删除。" })]
												}) : form.kind === "roles" && draft.message && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
													role: "alert",
													style: BANNER.warn,
													children: draft.message
												}),
												form.kind === "roles" ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)(RoleFields, {
													form,
													isNew,
													change,
													view,
													refs,
													jump
												}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)(GroupFields, {
													form,
													isNew,
													change,
													view,
													message: draft.message
												}),
												/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
													style: S.actions,
													children: [
														!isNew && current && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(Action, {
															action: "delete",
															tone: "danger",
															disabled: stale,
															onClick: () => remove(id, draft),
															children: ["删除", label]
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", { style: S.spacer }),
														(dirty || stale) && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
															action: "revert",
															tone: "ghost",
															onClick: () => {
																put(k, void 0);
																if (isNew) requestAnimationFrame(() => root.current?.querySelector("[data-action=\"new\"]")?.focus());
																else reveal(id);
															},
															children: isNew ? "取消" : "还原草稿"
														}),
														/* @__PURE__ */ (0, react_jsx_runtime.jsx)(Action, {
															action: "save",
															tone: "primary",
															disabled: !dirty || stale,
															onClick: () => {
																const error = validate(form, view, isNew, draft.base);
																if (error) {
																	put(k, {
																		...draft,
																		message: error
																	});
																	return;
																}
																const impact = form.kind === "roles" && !form.enabled && draft.base?.enabled && refs.length ? ` ${refs.length} 名编队成员暂时无法派遣。` : "";
																write(saveWrite(draft, view), {
																	id,
																	draft
																}, `已保存${label} ${form.id.trim()}。${impact}`);
															},
															children: isNew ? "创建" + label : "保存修改"
														})
													]
												})
											]
										})
									})
								]
							}, k);
						})]
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("details", {
						style: S.footer,
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("summary", {
							style: S.footerSummary,
							children: "存储与备份说明"
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: S.hint,
							children: [
								"角色保存在 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: view.dir || "~/.dsh/subagents/" }),
								"，编队位于该目录下的 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "_groups/" }),
								"。 备份时一并保留角色文件、编队和 ",
								/* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", { children: "_profiles/" }),
								" 中的模型路由。"
							]
						})]
					})
				]
			}),
			dialog && /* @__PURE__ */ (0, react_jsx_runtime.jsx)(Modal, {
				dialog,
				close: () => setDialog(void 0)
			})
		]
	});
}

//#endregion
//#region src/client/icon.tsx
/** Robot-head glyph for the library's settings row. */
function LibraryNavIcon({ size = 16 }) {
	return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
		viewBox: "0 0 16 16",
		width: size,
		height: size,
		fill: "none",
		stroke: "currentColor",
		strokeWidth: 1.2,
		strokeLinecap: "round",
		strokeLinejoin: "round",
		"aria-hidden": "true",
		children: [
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M8 6.5V3.9" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("circle", {
				cx: "8",
				cy: "2.6",
				r: "0.85"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
				x: "3.25",
				y: "6.5",
				width: "9.5",
				height: "6.5",
				rx: "1.5"
			}),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M5.75 9.25v1.25" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M10.25 9.25v1.25" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M1.75 9.25h1.5" }),
			/* @__PURE__ */ (0, react_jsx_runtime.jsx)("path", { d: "M12.75 9.25h1.5" })
		]
	});
}

//#endregion
//#region src/client/nav-icon.ts
function registerSettingsNavIcon(ctx) {
	ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
		name: "settings.section.icon",
		id: "subagent-library"
	}, LibraryNavIcon));
}

//#endregion
//#region src/client/locales.ts
const zh = {
	"settings.title": "子代理库",
	"settings.hint": "管理名册中的角色和编队，为编队成员指定代号与默认分工。",
	"settings.empty": "库为空。添加第一个条目开始使用。",
	"settings.missing": "未找到 subagent-library 配置段（插件未加载？）。",
	"settings.add": "添加",
	"settings.addNew": "新建角色",
	"settings.delete": "删除",
	"settings.save": "保存",
	"settings.saved": "已保存",
	"settings.conflict": "配置已在别处更新，你的草稿已保留。查看当前配置后可继续编辑。",
	"settings.error": "保存失败：",
	"settings.id": "ID",
	"settings.description": "描述",
	"settings.model": "模型",
	"settings.persona": "角色提示词",
	"settings.toolFilter": "旧工具限制",
	"settings.maxDepth": "深度上限",
	"settings.provider": "Provider",
	"settings.sourceHint": "角色保存在名册目录，编队位于 _groups/，各 profile 的模型路由位于 _profiles/。"
};
const en = {
	"settings.title": "Subagent Library",
	"settings.hint": "Manage roles and groups. Give each group member a code and a default assignment.",
	"settings.empty": "Library is empty. Add the first entry to get started.",
	"settings.missing": "No subagent-library section found (plugin not loaded?).",
	"settings.add": "Add",
	"settings.addNew": "New role",
	"settings.delete": "Delete",
	"settings.save": "Save",
	"settings.saved": "Saved",
	"settings.conflict": "Settings changed elsewhere. Your draft is preserved. Review the current settings to continue editing.",
	"settings.error": "Save failed: ",
	"settings.id": "ID",
	"settings.description": "Description",
	"settings.model": "Model",
	"settings.persona": "Persona",
	"settings.toolFilter": "Legacy tool restrictions",
	"settings.maxDepth": "Max depth",
	"settings.provider": "Provider",
	"settings.sourceHint": "Roles are stored in the roster directory, groups in _groups/, and profile model routes in _profiles/."
};

//#endregion
//#region src/client/index.tsx
const NS = "subagent-library";
const API_PATH = "/subagent-library/api";
/** Host error codes that carry no `message`; map them to user-facing text. */
const ERROR_TEXT = {
	"not-ready": "设置服务尚未就绪，请稍后重试。",
	"readonly": "设置服务只读，无法完成该操作。",
	"content-type-json-required": "请求被拒绝：写入只接受 JSON。",
	"cross-origin-forbidden": "请求被拒绝：跨源写入。",
	"body-too-large": "请求体超过 1 MiB 上限。",
	"bad-json": "请求体不是合法 JSON。",
	"entries-object-required": "缺少 entries 对象。",
	"invalid-id": "条目 ID 非法。",
	"unknown-op": "未知操作。",
	"roster-unreadable": "名册目录读取失败。",
	"write-failed": "名册文件写入失败。",
	"profile-path": "当前 profile 名称不能保存独立模型路由。",
	"role-in-use": "有编队成员还在使用这个角色。",
	"conflict": "配置已在别处更新，你的草稿已保留。",
	"roster-busy": "名册正在保存其他修改，请稍后再试。"
};
/** Map a wire view onto the UI model. Exported for the wire-contract tests —
*  a dropped field here silently kills UI features (k3 review: legacyCount). */
const parseView = (value) => ({
	writable: value.writable ?? true,
	dir: value.dir ?? "",
	hash: value.hash ?? "",
	entries: value.entries ?? {},
	sharedEntries: value.sharedEntries ?? {},
	groups: value.groups ?? {},
	roleUsages: value.roleUsages ?? {},
	diagnostics: value.diagnostics ?? [],
	legacyCount: value.legacyCount ?? 0,
	...typeof value.profile === "string" && value.profile !== "" ? { profile: value.profile } : {},
	...value.routeWriteProblem && { routeWriteProblem: value.routeWriteProblem }
});
async function readView() {
	const response = await fetch(API_PATH, { cache: "no-store" });
	const body = await response.json();
	if (!response.ok || typeof body !== "object" || body === null || body.ok !== true) {
		const error = body?.error;
		const message = body?.message;
		throw new Error(message ?? (error !== void 0 ? ERROR_TEXT[error] : void 0) ?? "子代理库接口不可用（插件未加载？）");
	}
	return parseView(body);
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
		const wire = typeof body === "object" && body !== null ? body : {};
		if (!response.ok || wire.ok !== true) return {
			ok: false,
			error: wire.error,
			conflict: response.status === 409 && wire.error === "conflict",
			message: wire.message?.replace(/^Error:\s*/, "") ?? (wire.error ? ERROR_TEXT[wire.error] : void 0) ?? "保存失败",
			view: wire.view && parseView(wire.view),
			references: wire.references
		};
		return {
			ok: true,
			view: parseView(wire)
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
	registerSettingsNavIcon(ctx);
}

//#endregion
exports.apply = apply;
exports.inject = inject;
exports.parseView = parseView;
return module.exports; } });
//# sourceMappingURL=client.js.map