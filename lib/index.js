import { createRequire } from "node:module";
import z from "@deepseek-ai/schemastery";
import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import * as nodePath from "node:path";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { homedir } from "node:os";
import { promises } from "node:fs";
import { Context, Service } from "@deepseek-ai/cordis";

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
/** Validate one entry id; returns the error message, or undefined when valid. */
function validateEntryId(id) {
	switch (entryIdIssue(id)) {
		case "required":
		case "start":
		case "characters": return `id "${id}" must match ${String(ENTRY_ID)}`;
		case "length": return `id "${id}" exceeds ${MAX_ID_LENGTH} characters`;
		case "reserved": return `id "${id}" is a reserved Windows device name and cannot be a roster file`;
	}
}

//#endregion
//#region src/roster.ts
const EntrySchema = z.object({
	description: z.string().required(),
	provider: z.string(),
	model: z.string(),
	subagentProvider: z.string(),
	reasoningEffort: z.string(),
	maxTokens: z.natural().max(Number.MAX_SAFE_INTEGER),
	persona: z.string(),
	toolFilter: z.object({
		allow: z.array(z.string()).default(void 0),
		deny: z.array(z.string()).default(void 0)
	}).default(void 0),
	maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER),
	backgroundMode: z.union(["one-shot", "continuable"])
});
const ENTRY_KEYS = new Set([
	"description",
	"provider",
	"model",
	"subagentProvider",
	"reasoningEffort",
	"maxTokens",
	"persona",
	"toolFilter",
	"maxDepth",
	"backgroundMode"
]);
/** Key under which a host/test may inject an `FsPort` on the plugin Context. */
const kFsPort = Symbol.for("dsh-subagent-library.fs-port");
const nodeFsPort = {
	readdir: (dir) => promises.readdir(dir),
	readFile: (path) => promises.readFile(path),
	writeFile: (path, data, flag) => promises.writeFile(path, data, {
		encoding: "utf8",
		flag
	}),
	rename: (from, to) => promises.rename(from, to),
	unlink: (path) => promises.unlink(path),
	mkdir: async (dir, options) => {
		await promises.mkdir(dir, options);
	}
};
const isEnoent$1 = (error) => error.code === "ENOENT";
const defaultDelay$1 = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/** Expand `~`, anchor relative paths at `~/.dsh`, keep absolutes as-is. */
function resolveEntriesDir(entriesDir, home = homedir()) {
	const raw = entriesDir?.trim();
	if (raw === void 0 || raw === "") return nodePath.join(home, ".dsh", "subagents");
	const expanded = raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\") ? nodePath.join(home, raw.slice(2)) : raw;
	return nodePath.isAbsolute(expanded) ? expanded : nodePath.join(home, ".dsh", expanded);
}
const stripBom = (text) => text.charCodeAt(0) === 65279 ? text.slice(1) : text;
/**
* Parse and validate one entry document (file contents or a save payload).
* Unknown keys are LOUDLY rejected: a typo'd `backgroundmode` must not be
* silently dropped into a default. Returns the normalized entry and the
* enabled flag (default true).
*/
function parseEntryDocument(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("条目内容必须是对象（字段：description / provider / model / …）");
	const record$1 = raw;
	const unknownKeys = Object.keys(record$1).filter((key) => key !== "enabled" && !ENTRY_KEYS.has(key));
	if (unknownKeys.length > 0) throw new Error(`未知字段：${unknownKeys.join(", ")}（可用：${[...ENTRY_KEYS, "enabled"].join(", ")}）`);
	const { enabled = true,...rest } = record$1;
	if (typeof enabled !== "boolean") throw new Error("enabled 必须是布尔值");
	if (typeof record$1["reasoningEffort"] === "string" && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(record$1["reasoningEffort"])) throw new Error(`reasoningEffort 须为 effort id（如 max / high / medium / low），收到 "${record$1["reasoningEffort"]}"`);
	const entry = EntrySchema(rest);
	if (typeof entry !== "object" || entry === null) throw new Error("条目校验失败");
	return {
		entry,
		enabled
	};
}
/** Canonical JSON of one entry (recursively key-sorted) — hash input. */
function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== void 0).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
	return value;
}
function hashEntries(entries) {
	const payload = Object.keys(entries).sort().map((id) => [
		id,
		entries[id].enabled,
		canonical(entries[id].entry)
	]);
	return createHash("sha256").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}
/** Serialize an entry to YAML, preserving explicit legacy fields. */
function serializeEntry(entry, enabled = true) {
	const record$1 = entry;
	const doc = {};
	for (const key of [
		"description",
		"provider",
		"model",
		"subagentProvider",
		"reasoningEffort",
		"maxTokens",
		"persona",
		"toolFilter",
		"maxDepth",
		"backgroundMode"
	]) {
		const value = record$1[key];
		if (value === void 0) continue;
		doc[key] = value;
	}
	if (!enabled) doc["enabled"] = false;
	return stringify(doc, { lineWidth: 0 });
}
/** The CANONICAL file name for an id — always `.yaml` (SUB-ROSTER-YML-001:
*  save converges every entry onto this spelling). */
const entryFileName = (id) => `${id}.yaml`;
/** Every on-disk spelling that can serve one id. `loadRoster` READS both, so
*  writes and deletes must address both too — a `.yml`-only entry that
*  survives a delete would resurrect after every restart (SUB-ROSTER-YML-001). */
const entryFileNames = (id) => [`${id}.yaml`, `${id}.yml`];
/** A transient Windows file lock can delay unlink; ENOENT is already clean. */
async function unlinkWithRetry(file, fsp = nodeFsPort, delay = defaultDelay$1) {
	for (let attempt = 0;; attempt += 1) try {
		await fsp.unlink(file);
		return;
	} catch (error) {
		if (isEnoent$1(error)) return;
		if (attempt >= 2) throw error;
		await delay(50 * 3 ** attempt);
	}
}
/** Remove the noncanonical spelling after saving an entry. */
function removeYmlSibling(dir, id, fsp = nodeFsPort, delay = defaultDelay$1) {
	return unlinkWithRetry(nodePath.join(dir, `${id}.yml`), fsp, delay);
}
/** Atomic single-file write: temp name in the roster dir, then rename with
*  bounded retries (Windows AV/indexer transiently lock fresh files). */
async function writeEntryFile(options) {
	const fsp = options.fs ?? nodeFsPort;
	const wait = options.delay ?? defaultDelay$1;
	await writeYamlFile(options.dir, options.id, serializeEntry(options.entry, options.enabled ?? true), fsp, wait);
	await removeYmlSibling(options.dir, options.id, fsp, wait);
}
async function writeYamlFile(dir, id, contents, fsp, wait = defaultDelay$1) {
	const invalid = validateEntryId(id);
	if (invalid) throw new Error(invalid);
	await fsp.mkdir(dir, { recursive: true });
	const target = nodePath.join(dir, entryFileName(id));
	const temp = nodePath.join(dir, `.${id}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	await fsp.writeFile(temp, contents);
	for (let attempt = 0;; attempt += 1) try {
		await fsp.rename(temp, target);
		break;
	} catch (error) {
		if (attempt >= 2) {
			await fsp.unlink(temp).catch(() => {});
			throw error;
		}
		await wait(50 * 3 ** attempt);
	}
}
/** Remove every on-disk spelling that can serve one id (`.yaml` AND `.yml`);
*  a missing file is already the desired state (SUB-ROSTER-YML-001). */
async function deleteEntryFile(dir, id, fsp = nodeFsPort) {
	for (const name$1 of entryFileNames(id)) try {
		await fsp.unlink(nodePath.join(dir, name$1));
	} catch (error) {
		if (!isEnoent$1(error)) throw error;
	}
}
/**
* Read the whole roster fresh: directory files first (sorted), then legacy
* entries that no file shadows. Diagnostics carry every skip reason.
*/
async function loadRoster(options) {
	const fsp = options.fs ?? nodeFsPort;
	const diagnostics = [];
	const entries = Object.create(null);
	const revision = createHash("sha256");
	let names;
	let listing;
	try {
		names = (await fsp.readdir(options.dir)).slice().sort();
		listing = "ok";
	} catch (error) {
		if (isEnoent$1(error)) listing = "missing";
		else {
			listing = "unreadable";
			diagnostics.push({
				severity: "error",
				message: `名册目录不可读 ${options.dir}：${String(error)}`
			});
		}
		names = [];
	}
	/** Every roster id the listing named, before read/parse. A failed file is
	*  still present — overlay cleanup must not treat it as deleted. */
	const presentIds = /* @__PURE__ */ new Set();
	const owner = /* @__PURE__ */ new Map();
	/** A bad file blocks edits even when a sibling or legacy copy can still be displayed. */
	const failedFileIds = /* @__PURE__ */ new Set();
	for (const name$1 of names) {
		const lower = name$1.toLowerCase();
		if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) continue;
		const id = lower.endsWith(".yaml") ? lower.slice(0, -5) : lower.slice(0, -4);
		if (id.startsWith("_")) continue;
		revision.update(JSON.stringify(name$1));
		presentIds.add(id);
		if (lower !== name$1) {
			failedFileIds.add(id);
			diagnostics.push({
				severity: "warning",
				file: name$1,
				id,
				message: `文件名必须全小写，已跳过 "${name$1}"`
			});
			continue;
		}
		const idError = validateEntryId(id);
		if (idError !== void 0) {
			diagnostics.push({
				severity: "error",
				file: name$1,
				id,
				message: idError
			});
			continue;
		}
		const existing = owner.get(id);
		let text;
		try {
			text = (await fsp.readFile(nodePath.join(options.dir, name$1))).toString("utf8");
			revision.update(JSON.stringify(text));
		} catch (error) {
			diagnostics.push({
				severity: "error",
				file: name$1,
				id,
				message: `读取失败，条目已跳过：${String(error)}`
			});
			failedFileIds.add(id);
			continue;
		}
		if (existing !== void 0) {
			diagnostics.push({
				severity: "error",
				file: name$1,
				id,
				message: `与 "${existing}" 解析出相同 id（.yaml/.yml 只能保留一个），已跳过`
			});
			continue;
		}
		owner.set(id, name$1);
		try {
			const { entry, enabled } = parseEntryDocument(parse(stripBom(text)));
			entries[id] = {
				entry,
				enabled,
				source: "file",
				file: name$1
			};
		} catch (error) {
			diagnostics.push({
				severity: "error",
				file: name$1,
				id,
				message: `解析或校验失败，条目已跳过：${String(error)}`
			});
			failedFileIds.add(id);
		}
	}
	for (const [id, entry] of Object.entries(options.legacy ?? {})) {
		if (validateEntryId(id)) continue;
		const file = entries[id];
		if (file !== void 0) {
			diagnostics.push({
				severity: "info",
				id,
				message: `settings 中的旧条目已被名册文件 "${file.file}" 覆盖（旧条目可从 settings.yaml 删除）`
			});
			continue;
		}
		if (failedFileIds.has(id)) diagnostics.push({
			severity: "error",
			id,
			message: "名册文件损坏，settings 旧配置仅作展示兜底。修复或删除坏文件后才能派遣。"
		});
		entries[id] = {
			entry,
			enabled: true,
			source: "legacy"
		};
	}
	revision.update(JSON.stringify(diagnostics));
	return {
		dir: options.dir,
		entries,
		diagnostics,
		hash: hashEntries(entries),
		fileRevision: revision.digest("hex"),
		listing,
		presentIds,
		unreadableIds: failedFileIds
	};
}
/**
* One-time-per-directory, per-entry idempotent migration: every legacy entry
* that has no roster file yet (and a valid id) is written to `<id>.yaml`.
* Legacy settings entries are intentionally KEPT (rollback copy for users
* downgrading the plugin); re-running never duplicates or overwrites.
*/
async function migrateLegacyEntries(options) {
	const fsp = options.fs ?? nodeFsPort;
	const diagnostics = [];
	const imported = [];
	const skipped = [];
	let names;
	try {
		names = new Set((await fsp.readdir(options.dir)).map((name$1) => name$1.toLowerCase()));
	} catch (error) {
		if (!isEnoent$1(error)) throw error;
		names = /* @__PURE__ */ new Set();
	}
	for (const [id, entry] of Object.entries(options.legacy)) {
		const idError = validateEntryId(id);
		if (idError !== void 0) {
			skipped.push({
				id,
				reason: idError
			});
			continue;
		}
		if (names.has(`${id}.yaml`) || names.has(`${id}.yml`)) {
			skipped.push({
				id,
				reason: "roster file already exists"
			});
			continue;
		}
		try {
			await writeEntryFile({
				dir: options.dir,
				id,
				entry,
				fs: fsp,
				delay: options.delay
			});
			names.add(`${id}.yaml`);
			imported.push(id);
		} catch (error) {
			diagnostics.push({
				severity: "error",
				id,
				message: `迁移写入失败：${String(error)}`
			});
		}
	}
	return {
		imported,
		skipped,
		diagnostics
	};
}

//#endregion
//#region src/groups.ts
function record(value, fields) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("需要对象");
	const unknown = Object.keys(value).filter((key) => !fields.includes(key));
	if (unknown.length) throw new Error(`未知字段：${unknown.join(", ")}`);
	return value;
}
function idField(value, key) {
	if (typeof value !== "string" || validateEntryId(value)) throw new Error(`${key}无效，请使用小写字母、数字或短横线，以字母或数字开头，最长 64 个字符，并避开系统保留名称。`);
	return value;
}
function parseGroup(value, fromSettingsView = false) {
	const raw = record(value, [
		"name",
		"description",
		"enabled",
		"instructions",
		"members"
	]);
	if (typeof raw.description !== "string" || !raw.description.trim()) throw new Error("description 需要非空文字");
	if (raw.enabled !== void 0 && typeof raw.enabled !== "boolean") throw new Error("enabled 需要布尔值");
	for (const key of ["name", "instructions"]) if (raw[key] !== void 0 && typeof raw[key] !== "string") throw new Error(`${key} 需要文字`);
	if (!Array.isArray(raw.members) || !raw.members.length) throw new Error("请至少添加一名编队成员");
	const slots = /* @__PURE__ */ new Set();
	const memberFields = [
		"slot",
		"role",
		"assignment"
	];
	if (fromSettingsView) memberFields.push("launchable", "reason");
	const members = raw.members.map((value$1) => {
		const item = record(value$1, memberFields);
		const slot = idField(item.slot, "成员代号");
		if (slots.has(slot)) throw new Error(`成员代号 "${slot}" 在这个编队里已被使用，请换一个`);
		slots.add(slot);
		if (item.assignment !== void 0 && typeof item.assignment !== "string") throw new Error("assignment 需要文字");
		return {
			slot,
			role: idField(item.role, "角色 ID"),
			...item.assignment !== void 0 && { assignment: item.assignment }
		};
	});
	return {
		...typeof raw.name === "string" && { name: raw.name },
		description: raw.description,
		...raw.enabled !== void 0 && { enabled: raw.enabled },
		...typeof raw.instructions === "string" && { instructions: raw.instructions },
		members
	};
}
async function loadGroups(dir, fs) {
	const groupDir = join(dir, "_groups");
	const groups = Object.create(null);
	const groupDiagnostics = [];
	const revision = createHash("sha256");
	let names = [];
	try {
		names = (await fs.readdir(groupDir)).sort();
	} catch (error) {
		if (error.code !== "ENOENT") groupDiagnostics.push({
			severity: "error",
			file: "_groups",
			message: `编队目录不可读：${String(error)}`
		});
	}
	const seen = /* @__PURE__ */ new Set();
	for (const name$1 of names) {
		if (!/\.ya?ml$/i.test(name$1) || name$1.startsWith("_")) continue;
		const id = name$1.replace(/\.ya?ml$/i, "").toLowerCase();
		const file = `_groups/${name$1}`;
		revision.update(JSON.stringify(name$1));
		try {
			if (name$1 !== name$1.toLowerCase()) throw new Error("文件名必须全小写");
			const invalid = validateEntryId(id);
			if (invalid) throw new Error(invalid);
			const data = (await fs.readFile(join(groupDir, name$1))).toString("utf8");
			revision.update(JSON.stringify(data));
			if (seen.has(id)) throw new Error("同名编队文件重复");
			seen.add(id);
			groups[id] = parseGroup(parse(data));
		} catch (error) {
			groupDiagnostics.push({
				severity: "error",
				id,
				file,
				message: `编队 ${file} 无法使用：${String(error)}`
			});
		}
	}
	for (const problem of groupDiagnostics) if (problem.id) delete groups[problem.id];
	revision.update(JSON.stringify(groupDiagnostics));
	return {
		groups,
		groupDiagnostics,
		groupRevision: revision.digest("hex")
	};
}
function roleUsages(groups) {
	const result = Object.create(null);
	for (const [groupId, group] of Object.entries(groups)) for (const { slot, role } of group.members) (result[role] ??= []).push({
		groupId,
		slot
	});
	return result;
}
async function writeGroup(dir, id, group, fs) {
	const groupDir = join(dir, "_groups");
	await writeYamlFile(groupDir, id, stringify(group, { lineWidth: 0 }), fs);
	await removeYmlSibling(groupDir, id, fs);
}
const deleteGroup = (dir, id, fs) => deleteEntryFile(join(dir, "_groups"), id, fs);
/** All participating hosts use the same exclusive file. A timeout never steals a live lock. */
async function lockRoster(dir, fs, waitMs = 3e3) {
	const file = join(dir, ".roster-write.lock");
	await fs.mkdir(dir, { recursive: true });
	const deadline = Date.now() + waitMs;
	for (;;) try {
		await fs.writeFile(file, JSON.stringify({
			pid: process.pid,
			started: (/* @__PURE__ */ new Date()).toISOString()
		}), "wx");
		return () => unlinkWithRetry(file, fs);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		if (Date.now() >= deadline) throw Object.assign(/* @__PURE__ */ new Error(`名册写锁正被占用：${file}。请重试；若宿主异常退出，确认无写入者后可移除该锁文件。`), { code: "ROSTER_BUSY" });
		await new Promise((resolve) => setTimeout(resolve, 35));
	}
}

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-scope@0.1._6f3351786c779449c277f079a737f571/node_modules/@deepseek-ai/dsh-scope/lib/index.js
/**
* Shared insertion-ordered storage and effect ownership for scope-aware registries.
*
* @module @deepseek-ai/dsh-scope
*/
/**
* Insertion-ordered named entries with caller-owned duplicate diagnostics.
*
* Values are borrowed. Iterators are live within one nonempty table
* generation; draining the table detaches them from later insertions. Each
* successful insertion returns an idempotent undo for that exact entry.
*/
var NamedEntries = class {
	duplicateError;
	data = /* @__PURE__ */ new Map();
	constructor(duplicateError) {
		this.duplicateError = duplicateError;
	}
	/**
	* Insert one unique name.
	* @param name - name unique within this table.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo that removes only this insertion.
	*/
	insert(name$1, value) {
		const data = this.data;
		if (data.has(name$1)) throw this.duplicateError(name$1);
		data.set(name$1, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(name$1);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Read one named value.
	* @param name - name to resolve.
	* @returns the retained value, or `undefined` when absent.
	*/
	get(name$1) {
		return this.data.get(name$1);
	}
	/**
	* Test one name for membership.
	* @param name - name to test.
	* @returns whether the table contains that name.
	*/
	has(name$1) {
		return this.data.has(name$1);
	}
	/**
	* Iterate live names in insertion order.
	* @returns the native live key iterator.
	*/
	keys() {
		return this.data.keys();
	}
	/**
	* Iterate live entries in insertion order.
	* @returns the native live entry iterator.
	*/
	entries() {
		return this.data.entries();
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Insertion-ordered anonymous entries with independent registration identity.
*
* Equal values remain separate registrations. Values are borrowed, and
* iterators are live within one nonempty table generation; draining the table
* detaches them from later appends.
*/
var AnonymousEntries = class {
	data = /* @__PURE__ */ new Map();
	/**
	* Append one independently owned value.
	* @param value - borrowed value to retain.
	* @returns an idempotent undo for this exact append.
	*/
	append(value) {
		const data = this.data;
		const key = Symbol();
		data.set(key, value);
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			data.delete(key);
			if (data.size === 0 && this.data === data) this.data = /* @__PURE__ */ new Map();
		};
	}
	/**
	* Iterate live values in insertion order.
	* @returns the native live value iterator.
	*/
	values() {
		return this.data.values();
	}
	/**
	* Test whether this table has no entries.
	* @returns whether the table is empty.
	*/
	isEmpty() {
		return this.data.size === 0;
	}
};
/**
* Own the global and exact-scope layers for one registry.
*
* Reads never create scoped layers. Registrations derive both visibility and
* effect ownership from the supplied Cordis context, collect undo before
* notification, and reclaim only a completely empty aggregate layer.
*/
var ScopedLayers = class {
	createLayer;
	onChange;
	/** The eagerly constructed context-global layer. */
	global;
	scoped = /* @__PURE__ */ new Map();
	constructor(createLayer, onChange) {
		this.createLayer = createLayer;
		this.onChange = onChange;
		this.global = createLayer(void 0);
	}
	/**
	* Read an existing exact-scope overlay. Deliberately chain-blind: callers
	* addressing one scope's OWN contributions (its restrictions, its guards)
	* must not silently pick up an ancestor's — use {@link chainLayers} where
	* inheritance is the point.
	* @param scope - exact scope key; `undefined` denotes no overlay.
	* @returns the existing scoped layer, or `undefined` without creating one.
	*/
	peek(scope) {
		if (scope === void 0) return void 0;
		return this.scoped.get(scope);
	}
	/**
	* Existing overlays along the scope's parent chain ({@link scopeChainOf}),
	* farthest ancestor first and the exact scope last, so a caller layering
	* them in order gives the nearest scope the final word.
	* @param scope - viewing scope, or `undefined` for no overlays.
	* @returns the existing layers, nearest last; absent overlays are skipped.
	*/
	chainLayers(scope) {
		const layers = [];
		for (const key of scopeChainOf(scope).reverse()) {
			const layer = this.scoped.get(key);
			if (layer !== void 0) layers.push(layer);
		}
		return layers;
	}
	/**
	* Materialize global named entries followed by scope-chain shadows,
	* farthest ancestor first, so the nearest scope's entry wins a name.
	* @param scope - viewing scope, or `undefined` for the global view.
	* @param pick - select the named table from a layer.
	* @returns an insertion-ordered effective map.
	*/
	merge(scope, pick) {
		const merged = new Map(pick(this.global).entries());
		for (const layer of this.chainLayers(scope)) for (const [name$1, value] of pick(layer).entries()) merged.set(name$1, value);
		return merged;
	}
	/**
	* Attach one synchronous layer mutation to its registration context.
	* @param ctx - context that determines both scope visibility and effect ownership.
	* @param action - atomic mutation returning its synchronous undo.
	* @param options - Cordis effect label and optional change notification.
	* @returns the exact disposer returned by `ctx.effect()`.
	*/
	effect(ctx, action, options) {
		const scope = scopeOf(ctx);
		const notify = options.notify ?? true;
		return ctx.effect(function* () {
			let layer;
			let created = false;
			if (scope === void 0) layer = this.global;
			else {
				const existing = this.scoped.get(scope);
				if (existing === void 0) {
					layer = this.createLayer(scope);
					this.scoped.set(scope, layer);
					created = true;
				} else layer = existing;
			}
			let undo;
			try {
				undo = action(layer);
			} catch (error) {
				if (scope !== void 0 && created && layer.isEmpty()) this.scoped.delete(scope);
				throw error;
			}
			yield () => {
				undo();
				if (scope !== void 0 && layer.isEmpty()) this.scoped.delete(scope);
				if (notify) this.onChange();
			};
			if (notify) this.onChange();
		}.bind(this), options.label);
	}
};
/**
* Scoped-context primitive: mint a Cordis context that tags registrations with
* an opaque identity and build routing-only event carriers for that identity.
*
* @module @deepseek-ai/dsh-scope
*/
/** Context tag written by {@link createScope}. */
const kScope = Symbol("dsh.scope");
/** The key associated with each carrier. Presence distinguishes an unkeyed carrier from a non-carrier. */
const carrierKeys = /* @__PURE__ */ new WeakMap();
/**
* The enclosing scope of each key. One relation powers both directions of
* scope nesting: registration views inherit DOWN the chain (a child scope
* sees its ancestors' layers — {@link ScopedLayers}), and event admission
* extends UP it (a listener tagged with an ancestor receives events dispatched
* to a descendant key — {@link scopeTarget}).
*/
const scopeParents = /* @__PURE__ */ new WeakMap();
/**
* The chain from a key to its root ancestor.
* @param key - the starting key, or `undefined` for the empty chain.
* @returns keys nearest-first: `[key, parent, grandparent, …]`.
*/
function scopeChainOf(key) {
	const chain = [];
	for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) chain.push(cursor);
	return chain;
}
/**
* Read the nearest scope tag inherited by a context.
* @param ctx - context to inspect.
* @returns its scope key, or `undefined` for an unscoped context.
*/
function scopeOf(ctx) {
	return ctx[kScope];
}
/**
* Build an opaque receiver that preserves the base filter, admits untagged
* listeners globally, and admits tagged listeners for a matching key or any
* of its ancestors ({@link bindScopeParent}): a listener owned by an enclosing
* scope receives every descendant scope's events, which is what lets one
* standing composition observe each of the agents composed under it. A tag
* BELOW the dispatch key stays excluded — events flow up the chain, never
* down.
* @param base - subject or service whose existing Cordis filter is preserved.
* @param key - routed scope identity, or `undefined` for an unscoped subject.
* @returns a carrier whose subject remains available only through event arguments.
*/
function scopeTarget(base, key) {
	const baseFilter = base[Context.filter];
	const carrier = { [Context.filter](ctx) {
		if (baseFilter !== void 0 && !baseFilter.call(base, ctx)) return false;
		const tag = scopeOf(ctx);
		if (tag === void 0) return true;
		for (let cursor = key; cursor !== void 0; cursor = scopeParents.get(cursor)) if (cursor === tag) return true;
		return false;
	} };
	carrierKeys.set(carrier, key);
	return carrier;
}

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-timeout@0._8c173ab999b05cf1db05d479dd44e888/node_modules/@deepseek-ai/dsh-timeout/lib/index.js
/** Largest delay Node schedules without clamping it to one millisecond. */
const MAX_TIMER_DELAY_MS = 2147483647;

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-llm@0.1.0-_4ed4e5c71eb965b0bd6912871e829940/node_modules/@deepseek-ai/dsh-llm/lib/index.js
/**
* Brand a string as a {@link CallId}.
* @param id - the provider-issued (or synthesized) call id.
* @returns the same string, branded; no validation is performed.
*/
function CallId(id) {
	return id;
}
/**
* Deep-freeze a value in place with an iterative traversal, guarding cycles,
* so later mutation throws without imposing a JavaScript call-stack depth cap.
* {@link AbortSignal} objects are deliberately skipped because they are the
* request's live cancellation channel and freezing them breaks abort.
* @param value - the value to freeze in place.
* @returns the same value, frozen.
*/
function deepFreeze(value) {
	const seen = /* @__PURE__ */ new WeakSet();
	const pending = [{
		kind: "visit",
		node: value
	}];
	while (pending.length > 0) {
		const task = pending.pop();
		/* v8 ignore next -- the loop condition guarantees one pending task. */
		if (task === void 0) continue;
		if (task.kind === "property") {
			pending.push({
				kind: "visit",
				node: task.source[task.key]
			});
			continue;
		}
		const node = task.node;
		if (node === null || typeof node !== "object") continue;
		if (node instanceof AbortSignal) continue;
		if (seen.has(node)) continue;
		seen.add(node);
		Object.freeze(node);
		const keys = Object.keys(node);
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) continue;
			pending.push({
				kind: "property",
				source: node,
				key
			});
		}
	}
	return value;
}
/**
* Harness error base with a stable machine-routable code and chained cause.
* Package errors extend it so tool results and replay can retain failure class.
* @module @deepseek-ai/dsh-llm/error
*/
/**
* Base class for all harness errors. Carries a `code` (stable, programmatic —
* e.g. `NO_ADAPTER`, `INVALID_ARGS`, `INVARIANT`) distinct from the
* human-readable `message`, and supports `cause` chaining via the standard
* `ErrorOptions`. `name` defaults to the subclass constructor name.
*/
var HarnessError = class extends Error {
	/** Stable machine-routable failure class (e.g. `RATE_LIMIT`); route on this, never by parsing `message`. */
	code;
	constructor(message, code, options) {
		super(message, options);
		this.code = code;
		this.name = new.target.name;
	}
};
/**
* Canonical provider-neutral code for a response that completed normally but
* carried no content blocks at all. Providers occasionally emit a degenerate
* completion (a terminal stop with zero output); adapters classify it as this
* failure instead of yielding an empty assistant message, because an empty
* message silently ends the turn with nothing for the user or the loop to act
* on. The attempt produced nothing durable, so retry policy treats it as safe
* to repeat.
*/
const EMPTY_RESPONSE_CODE = "EMPTY_RESPONSE";
/** Structured codes and plain phrases that explicitly name a context bound being exceeded. */
const STRUCTURED_CONTEXT_OVERFLOW = new RegExp(String.raw`(?:^|[^a-z0-9])context[\s_-](?:length|window)[\s_-]` + String.raw`(?:exceed(?:ed|s)?|overflow(?:ed)?|limit[\s_-]exceeded)(?:$|[^a-z0-9])`, "i");
/** Request-size wording that ties "too large" directly to model context capacity. */
const TOO_LARGE_FOR_CONTEXT = new RegExp(String.raw`\b(?:request|prompt|input|messages?)\s+(?:is\s+|are\s+)?` + String.raw`too\s+(?:large|long)\s+for\s+(?:(?:this|the)\s+)?` + String.raw`(?:model(?:'s)?\s+)?context(?:\s+window)?\b`, "i");
/** "Exceeds" wording is safe only when its object is explicitly the model context. */
const EXCEEDS_MODEL_CONTEXT = new RegExp(String.raw`\b(?:input|prompt|request|messages?)\b.{0,40}` + String.raw`\b(?:exceed(?:s|ed)?|overflows?|is\s+larger\s+than)\b.{0,40}` + String.raw`\b(?:the\s+)?(?:model(?:'s)?\s+)?context(?:\s+(?:length|window))?\b`, "i");
/**
* Provider-owned request-retry policy configuration and resolution.
*
* Adapters expose one resolved policy per registered provider route; the
* optional dsh-llm-retry plugin executes it on the agent's failed-step extension point.
*
* @module @deepseek-ai/dsh-llm/retry-policy
*/
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_INITIAL_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 1e4;
const DEFAULT_JITTER_RATIO = .1;
const DEFAULT_RETRYABLE_CODES = Object.freeze([
	EMPTY_RESPONSE_CODE,
	"RATE_LIMIT",
	"SERVER",
	"TIMEOUT",
	"TRANSPORT"
]);
const backoffSchema = z.object({
	initialDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_INITIAL_DELAY_MS),
	maxDelayMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_MAX_DELAY_MS),
	jitterRatio: z.number().min(0).max(1).default(DEFAULT_JITTER_RATIO)
});
const normalPolicySchema = z.object({
	mode: z.const("normal").required(),
	maxRetries: z.number().step(1).min(0).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_RETRIES),
	retryableCodes: z.array(z.string()).default([...DEFAULT_RETRYABLE_CODES]),
	backoff: backoffSchema
});
const alwaysPolicySchema = z.object({
	mode: z.const("always").required(),
	backoff: backoffSchema
});
/** Cordis schema embedded by each concrete provider configuration. */
const RetryPolicySchema = z.union([normalPolicySchema, alwaysPolicySchema]);
/**
* Centralize the non-secret product identity every provider request sends as `User-Agent`, keeping
* adapters from drifting. See
* `.agents/notes/implemented/architecture/2026-06-21-mandatory-app-attribution-headers.md`.
*
* App-attribution vocabulary for provider requests.
* @module @deepseek-ai/dsh-llm/attribution
*/
const { version } = createRequire(import.meta.url)("../package.json");
/**
* Exhaustiveness helper for closed core unions. Use {@link assertNever} at the default branch so a
* new variant fails compilation at every required handler. Do not use it for declaration-merged
* unions such as session events or content blocks: handle known variants and explicitly fall
* through because plugins may add valid unknown cases.
* @module @deepseek-ai/dsh-llm/never
*/
/**
* Mark an unreachable closed-union branch. A newly unhandled typed variant fails at the call site;
* a value that escaped its type throws with diagnostics at runtime.
* @param value - the impossible value; typed `never` so an unhandled variant fails compilation at the call site.
* @param context - optional label (e.g. the switch site) prefixed into the throw message.
* @returns never — it always throws, with the offending value JSON-rendered in the message.
*/
function assertNever(value, context) {
	const rendered = JSON.stringify(value) ?? String(value);
	throw new Error(`unreachable variant${context ? ` in ${context}` : ""}: ${rendered}`);
}

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-session@0._959f4648d9537c86268b5de534a89875/node_modules/@deepseek-ai/dsh-session/lib/index.js
/** Lossless-JSON validation and detached snapshots for durable session data. @module @deepseek-ai/dsh-session/json */
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor$1(prototype, name$1) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name$1 && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name$1}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype$1(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor$1(value, "Object");
}
/** Whether an array uses one realm's intrinsic `Array.prototype`, not a subclass or forged prototype. */
function hasPlainArrayPrototype$1(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor$1(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype$1(objectPrototype);
}
/** Whether an object is a plain or null-prototype record from any JavaScript realm. */
function hasPlainObjectPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype$1(prototype);
}
/** Return every JSON-visible object key, or reject own data JSON would discard. */
function enumerableStringKeys(value) {
	const keys = Reflect.ownKeys(value);
	if (keys.some((key) => typeof key !== "string" || !Object.prototype.propertyIsEnumerable.call(value, key))) return void 0;
	return keys;
}
/** Validate lossless JSON iteratively, optionally materializing a detached snapshot. */
function walkJsonValue(value, detach) {
	const ancestors = /* @__PURE__ */ new Set();
	let root;
	const assign = (destination, item) => {
		if (destination === void 0) return;
		if (destination.kind === "root") root = item;
		else if (destination.kind === "array") destination.target[destination.index] = item;
		else Object.defineProperty(destination.target, destination.key, {
			value: item,
			enumerable: true,
			configurable: true,
			writable: true
		});
	};
	const tasks = [{
		kind: "visit",
		value,
		...detach ? { destination: { kind: "root" } } : {}
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			ancestors.delete(task.source);
			continue;
		}
		if (task.kind === "array-item") {
			if (!Object.prototype.hasOwnProperty.call(task.source, task.index)) return void 0;
			tasks.push({
				kind: "visit",
				value: task.source[task.index],
				...task.target === void 0 ? {} : { destination: {
					kind: "array",
					target: task.target,
					index: task.index
				} }
			});
			continue;
		}
		if (task.kind === "object-property") {
			tasks.push({
				kind: "visit",
				value: task.source[task.key],
				...task.target === void 0 ? {} : { destination: {
					kind: "object",
					target: task.target,
					key: task.key
				} }
			});
			continue;
		}
		const current = task.value;
		if (current === null) {
			assign(task.destination, null);
			continue;
		}
		if (typeof current === "boolean" || typeof current === "string") {
			assign(task.destination, current);
			continue;
		}
		if (typeof current === "number") {
			if (!Number.isFinite(current) || Object.is(current, -0)) return void 0;
			assign(task.destination, current);
			continue;
		}
		if (typeof current !== "object") return void 0;
		if (ancestors.has(current)) return void 0;
		if (Array.isArray(current)) {
			if (!hasPlainArrayPrototype$1(current)) return void 0;
			const length = current.length;
			if (Reflect.ownKeys(current).length !== length + 1) return void 0;
			const target$1 = detach ? [] : void 0;
			if (target$1 !== void 0) assign(task.destination, target$1);
			ancestors.add(current);
			tasks.push({
				kind: "leave",
				source: current
			});
			for (let index = length - 1; index >= 0; index--) tasks.push({
				kind: "array-item",
				source: current,
				index,
				...target$1 === void 0 ? {} : { target: target$1 }
			});
			continue;
		}
		if (!hasPlainObjectPrototype(current)) return void 0;
		const keys = enumerableStringKeys(current);
		if (keys === void 0) return void 0;
		const target = detach ? {} : void 0;
		if (target !== void 0) assign(task.destination, target);
		ancestors.add(current);
		tasks.push({
			kind: "leave",
			source: current
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) return void 0;
			tasks.push({
				kind: "object-property",
				source: current,
				key,
				...target === void 0 ? {} : { target }
			});
		}
	}
	return detach ? root : true;
}
/**
* Validate and detach lossless JSON in one read per property, so a stateful
* getter cannot change between validation and copying. Traversal is iterative,
* so valid nesting is bounded by available memory rather than the JavaScript
* call stack. Accepts ordinary arrays, plain or null-prototype objects, and JSON
* scalars; rejects sparse, cyclic, exotic, negative-zero, and non-finite values.
* Getter throws propagate.
*
* @param value - the candidate value to validate and detach.
* @returns the detached snapshot, or `undefined` when the value is not
*   losslessly JSON-serializable.
*/
function snapshotJsonValue(value) {
	return walkJsonValue(value, true);
}
/**
* Test the same lossless JSON boundary as {@link snapshotJsonValue} without
* detaching it. Only own enumerable string properties participate; `toJSON`
* is ignored and getters run, so persistence boundaries use the snapshotter.
* @param value - the candidate event data to test.
* @returns whether `value` survives JSON round-trip losslessly.
*/
function isJsonValue(value) {
	return walkJsonValue(value, false) === true;
}
/**
* Ownership of one unpublished Session before registry publication.
* @module @deepseek-ai/dsh-session/preparation
*/
/**
* One exact unpublished Session and the provider state that keeps it usable.
* Disposal is synchronous and idempotent. Providers decide whether release
* returns the Session to a cache or discards it; publication may consume that
* state before disposal, making the callback a no-op.
*/
var SessionPreparation = class SessionPreparation$1 {
	options;
	released = false;
	/** The exact Session to use for setup and publication. */
	session;
	constructor(session, options) {
		this.options = options;
		this.session = session;
	}
	/**
	* Wrap an unpublished Session in one preparation lifetime.
	* @param session - exact unpublished Session.
	* @param options - optional provider release behavior.
	* @returns a preparation disposed after publication or rollback.
	*/
	static create(session, options) {
		return new SessionPreparation$1(session, options ?? {});
	}
	/** Release provider state once when this preparation leaves its caller. */
	[Symbol.dispose]() {
		if (this.released) return;
		this.released = true;
		this.options.release?.();
	}
};

//#endregion
//#region node_modules/.pnpm/@deepseek-ai+dsh-tools@0.1._d489cb013f2a8725198f1fce9da6f626/node_modules/@deepseek-ai/dsh-tools/lib/index.js
/**
* Enforced JSON Schema subset shared by tool outputs, generated Code Mode
* types, subagents, and workflows. The subset accepts any JSON root, an
* annotation-only schema for unconstrained JSON, one scalar `type`, object
* `properties`/`required`/boolean `additionalProperties`, array `items`,
* type-correct scalar `enum`/`const`, and exact-one `oneOf`.
*
* Unsupported or misplaced keywords reject rather than being accepted without
* enforcement. Consumers that require an object root apply
* {@link assertObjectJsonSchema} before accepting input.
* @module dsh-tools/json-schema
*/
/**
* Thrown when a raw schema falls outside the enforced subset. `violations`
* lists every offending path instead of stopping at the first author error.
*/
var JsonSchemaError = class extends HarnessError {
	/** Individual schema violations in walk order. */
	violations;
	constructor(violations) {
		super(`unsupported JSON schema: ${violations.join("; ")}`, "UNSUPPORTED_SCHEMA");
		this.name = "JsonSchemaError";
		this.violations = violations;
	}
};
const CONSTRAINT_KEYWORDS = new Set([
	"type",
	"oneOf",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
]);
const ANNOTATION_KEYWORDS = new Set([
	"description",
	"title",
	"default",
	"examples"
]);
const SCHEMA_TYPES = [
	"object",
	"array",
	"string",
	"number",
	"integer",
	"boolean",
	"null"
];
/** Whether a realm-owned intrinsic prototype is backed by its native constructor. */
function hasIntrinsicConstructor(prototype, name$1) {
	const constructor = Object.getOwnPropertyDescriptor(prototype, "constructor")?.value;
	if (typeof constructor !== "function") return false;
	try {
		return constructor.name === name$1 && constructor.prototype === prototype && Function.prototype.toString.call(constructor) === `function ${name$1}() { [native code] }`;
	} catch {
		return false;
	}
}
/** Whether a candidate is one realm's intrinsic `Object.prototype`. */
function isIntrinsicObjectPrototype(value) {
	return Object.getPrototypeOf(value) === null && hasIntrinsicConstructor(value, "Object");
}
/**
* Test for a realm-agnostic plain JSON record without accepting arrays or
* exotic objects.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the value has a plain-object prototype chain.
*/
function isPlainJsonRecord(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return prototype === null || typeof prototype === "object" && isIntrinsicObjectPrototype(prototype);
	} catch {
		return false;
	}
}
/** Whether an array uses one realm's intrinsic `Array.prototype`. */
function hasPlainArrayPrototype(value) {
	const prototype = Object.getPrototypeOf(value);
	if (!Array.isArray(prototype) || !hasIntrinsicConstructor(prototype, "Array")) return false;
	const objectPrototype = Object.getPrototypeOf(prototype);
	return typeof objectPrototype === "object" && objectPrototype !== null && isIntrinsicObjectPrototype(objectPrototype);
}
/** Return whether a record contains only own enumerable string keys. */
function hasOnlyEnumerableStringKeys(value) {
	try {
		return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.prototype.propertyIsEnumerable.call(value, key));
	} catch {
		return false;
	}
}
/**
* Test for an ordinary schema record whose keys survive JSON projection.
* @param value - candidate record from any JavaScript realm.
* @returns Whether the record has an intrinsic prototype and only own enumerable string keys.
*/
function isJsonSchemaRecord(value) {
	return isPlainJsonRecord(value) && hasOnlyEnumerableStringKeys(value);
}
/**
* Test for a dense ordinary array with no JSON-invisible decorations.
* @param value - candidate array from any JavaScript realm.
* @returns Whether the array is intrinsic, dense, and undecorated.
*/
function isPlainJsonArray(value) {
	if (!Array.isArray(value)) return false;
	try {
		if (!hasPlainArrayPrototype(value) || Reflect.ownKeys(value).length !== value.length + 1) return false;
		for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) return false;
		return true;
	} catch {
		return false;
	}
}
/** Lossless finite JSON number, excluding negative zero. */
function isJsonNumber(value) {
	return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0);
}
/** Whether a scalar is valid for one declared schema type. */
function scalarMatches(type, value) {
	switch (type) {
		case "string": return typeof value === "string";
		case "number": return isJsonNumber(value);
		case "integer": return isJsonNumber(value) && Number.isInteger(value);
		case "boolean": return typeof value === "boolean";
		case "null": return value === null;
		default: return assertNever(type, "JsonSchemaType");
	}
}
/** Keywords that are invalid beside `oneOf`. */
const ONE_OF_SIBLING_KEYWORDS = [
	"properties",
	"required",
	"additionalProperties",
	"items",
	"enum",
	"const"
];
/** Validate object-only fields after its property schemas have been visited. */
function checkObjectSchemaTail(node, path, properties, violations) {
	const hasRequired = Object.hasOwn(node, "required");
	const required = hasRequired ? node.required : void 0;
	if (hasRequired) if (!isPlainJsonArray(required) || required.some((entry) => typeof entry !== "string")) violations.push(`${path}.required must be an array of strings`);
	else {
		const declared = isJsonSchemaRecord(properties) ? properties : {};
		for (const key of required) if (!Object.hasOwn(declared, key)) violations.push(`${path}.required names "${key}" which is not in properties`);
	}
	if (Object.hasOwn(node, "additionalProperties") && typeof node.additionalProperties !== "boolean") violations.push(`${path}.additionalProperties must be a boolean`);
}
/** Collect every violation for one raw schema tree without using the JavaScript call stack. */
function checkSchemaNode(root, rootPath, violations, seen) {
	const tasks = [{
		kind: "enter",
		node: root,
		path: rootPath
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.node);
			continue;
		}
		if (task.kind === "one-of-tail") {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(task.node, key)) violations.push(`${task.path}.${key} is not supported beside oneOf`);
			continue;
		}
		if (task.kind === "object-tail") {
			checkObjectSchemaTail(task.node, task.path, task.properties, violations);
			continue;
		}
		const { node, path } = task;
		if (!isJsonSchemaRecord(node)) {
			violations.push(`${path} must be a schema object`);
			continue;
		}
		if (seen.has(node)) {
			violations.push(`${path} is circular`);
			continue;
		}
		seen.add(node);
		tasks.push({
			kind: "leave",
			node
		});
		for (const key of Object.keys(node)) {
			if (CONSTRAINT_KEYWORDS.has(key)) continue;
			if (ANNOTATION_KEYWORDS.has(key)) {
				try {
					if (!isJsonValue(node[key])) violations.push(`${path}.${key} annotation must be lossless JSON data`);
				} catch {
					violations.push(`${path}.${key} annotation must be lossless JSON data`);
				}
				continue;
			}
			violations.push(`${path}.${key} is not a supported keyword (subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)`);
		}
		if (Object.hasOwn(node, "description") && typeof node.description !== "string") violations.push(`${path}.description must be a string`);
		if (Object.hasOwn(node, "title") && typeof node.title !== "string") violations.push(`${path}.title must be a string`);
		const hasType = Object.hasOwn(node, "type");
		const hasOneOf = Object.hasOwn(node, "oneOf");
		if (hasType && hasOneOf) {
			violations.push(`${path} cannot declare both type and oneOf`);
			continue;
		}
		if (!hasType && !hasOneOf) {
			for (const key of ONE_OF_SIBLING_KEYWORDS) if (Object.hasOwn(node, key)) violations.push(`${path}.${key} requires type or oneOf`);
			continue;
		}
		if (hasOneOf) {
			const oneOf = node.oneOf;
			tasks.push({
				kind: "one-of-tail",
				node,
				path
			});
			if (!isPlainJsonArray(oneOf) || oneOf.length < 2) violations.push(`${path}.oneOf must be an array of at least two schemas`);
			else for (let index = oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "enter",
				node: oneOf[index],
				path: `${path}.oneOf[${index}]`
			});
			continue;
		}
		const type = node.type;
		if (typeof type !== "string" || !SCHEMA_TYPES.includes(type)) {
			violations.push(Array.isArray(type) ? `${path}.type must be a single type string (type arrays are not supported)` : `${path}.type must be one of ${SCHEMA_TYPES.join("/")}`);
			continue;
		}
		const schemaType = type;
		for (const [key, types] of Object.entries({
			properties: ["object"],
			required: ["object"],
			additionalProperties: ["object"],
			items: ["array"],
			enum: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			],
			const: [
				"string",
				"number",
				"integer",
				"boolean",
				"null"
			]
		})) if (Object.hasOwn(node, key) && !types.includes(schemaType)) violations.push(`${path}.${key} is not supported on type "${schemaType}"`);
		switch (schemaType) {
			case "object": {
				const properties = Object.hasOwn(node, "properties") ? node.properties : void 0;
				tasks.push({
					kind: "object-tail",
					node,
					path,
					properties
				});
				if (Object.hasOwn(node, "properties")) if (!isJsonSchemaRecord(properties)) violations.push(`${path}.properties must be an object of schemas`);
				else {
					const entries = Object.entries(properties);
					for (let index = entries.length - 1; index >= 0; index--) {
						const entry = entries[index];
						/* v8 ignore next -- the loop is bounded by the captured entry count. */
						if (entry === void 0) continue;
						tasks.push({
							kind: "enter",
							node: entry[1],
							path: `${path}.properties.${entry[0]}`
						});
					}
				}
				break;
			}
			case "array":
				if (Object.hasOwn(node, "items")) tasks.push({
					kind: "enter",
					node: node.items,
					path: `${path}.items`
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null": {
				const hasEnum = Object.hasOwn(node, "enum");
				const allowed = hasEnum ? node.enum : void 0;
				const enumValid = isPlainJsonArray(allowed) && allowed.length > 0 && allowed.every((entry) => scalarMatches(schemaType, entry));
				if (hasEnum && !enumValid) violations.push(`${path}.enum must be a non-empty array of ${schemaType} values`);
				const hasConst = Object.hasOwn(node, "const");
				const declaredConst = hasConst ? node.const : void 0;
				const constValid = scalarMatches(schemaType, declaredConst);
				if (hasConst) {
					if (!constValid) violations.push(`${path}.const must be a ${schemaType} value`);
					else if (enumValid && !allowed.includes(declaredConst)) violations.push(`${path}.const must be one of ${path}.enum when both are declared`);
				}
				break;
			}
			default: assertNever(schemaType, "JsonSchemaType");
		}
	}
}
/**
* Assert that an arbitrary raw schema uses only the enforced subset.
* Annotation-only schemas are accepted as the standard unconstrained-JSON
* form; callers that require an object root use {@link assertObjectJsonSchema}.
* @param schema - untrusted raw JSON Schema.
* @returns Assertion that the schema belongs to the supported subset.
*/
function assertSupportedJsonSchema(schema) {
	const violations = [];
	checkSchemaNode(schema, "schema", violations, /* @__PURE__ */ new Set());
	if (violations.length > 0) throw new JsonSchemaError(violations);
}
/** Safely test the lossless JSON boundary when a getter may throw. */
function safelyIsJsonValue(value) {
	try {
		return isJsonValue(value);
	} catch {
		return false;
	}
}
/** Root-aware diagnostic path for the parameter validator's empty sentinel. */
function diagnosticPath(path) {
	return path === "" ? "arguments" : path;
}
/** Append one object property without a leading dot at an implicit root. */
function propertyPath(path, key) {
	return path === "" ? key : `${path}.${key}`;
}
/** The generic exception-containment diagnostic owned by one valid schema node. */
function losslessValueViolation(path) {
	return [`"${diagnosticPath(path)}" must be a lossless JSON value`];
}
/** Append diagnostics without spreading a potentially wide child result as call arguments. */
function appendViolations(target, source) {
	for (const violation of source) target.push(violation);
}
/** Initialize one validation frame with empty aggregation state. */
function valueFrame(node, value, path) {
	return {
		node,
		value,
		path,
		catches: false,
		phase: "start",
		children: [],
		childIndex: 0,
		violations: [],
		tailViolations: [],
		matches: 0
	};
}
/** Validate one scalar node after its primitive type check. */
function checkScalarValue(node, value, path) {
	const allowed = Object.hasOwn(node, "enum") ? node.enum : void 0;
	if (allowed !== void 0 && !allowed.includes(value)) return [`"${diagnosticPath(path)}" must be one of ${JSON.stringify(allowed)}`];
	if (Object.hasOwn(node, "const") && value !== node.const) return [`"${diagnosticPath(path)}" must be ${JSON.stringify(node.const)}`];
	return [];
}
/** Validate one trusted schema/value pair with explicit frames rather than recursive calls. */
function checkValue(schema, value, path) {
	const frames = [valueFrame(schema, value, path)];
	let rootResult;
	const receive = (result) => {
		const parent = frames.at(-1);
		if (parent === void 0) {
			rootResult = result;
			return;
		}
		if (parent.kind === "oneOf") {
			if (result.length === 0) parent.matches++;
		} else appendViolations(parent.violations, result);
	};
	const finish = (result) => {
		frames.pop();
		receive(result);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		try {
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing schema-value child frame");
					frame.childIndex++;
					frames.push(valueFrame(child.node, child.value, child.path));
					continue;
				}
				if (frame.kind === "oneOf") {
					finish(frame.matches === 1 ? [] : [`"${diagnosticPath(frame.path)}" must match exactly one oneOf branch (matched ${frame.matches})`]);
					continue;
				}
				appendViolations(frame.violations, frame.tailViolations);
				if (frame.violations.length > 0) finish(frame.violations);
				else if (frame.kind === "object") finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a lossless JSON object`]);
				else finish(safelyIsJsonValue(frame.value) ? [] : [`"${diagnosticPath(frame.path)}" must be a dense lossless JSON array`]);
				continue;
			}
			const nodeType = Object.hasOwn(frame.node, "type") ? frame.node.type : void 0;
			frame.catches = !(nodeType !== void 0 && !SCHEMA_TYPES.includes(nodeType));
			const oneOf = Object.hasOwn(frame.node, "oneOf") ? frame.node.oneOf : void 0;
			if (oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = Array.from(oneOf, (branch) => ({
					node: branch,
					value: frame.value,
					path: frame.path
				}));
				frame.childIndex = 0;
				frame.matches = 0;
				frame.phase = "children";
				continue;
			}
			if (nodeType === void 0) {
				finish(safelyIsJsonValue(frame.value) ? [] : losslessValueViolation(frame.path));
				continue;
			}
			switch (nodeType) {
				case "object": {
					if (!isPlainJsonRecord(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an object`]);
						break;
					}
					const properties = Object.hasOwn(frame.node, "properties") ? frame.node.properties ?? {} : {};
					const violations = [];
					const required = Object.hasOwn(frame.node, "required") ? frame.node.required ?? [] : [];
					for (const key of required) if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) violations.push(`missing required property "${propertyPath(frame.path, key)}"`);
					const children = [];
					for (const [key, child] of Object.entries(properties)) {
						if (!Object.hasOwn(frame.value, key) || frame.value[key] === void 0) continue;
						children.push({
							node: child,
							value: frame.value[key],
							path: propertyPath(frame.path, key)
						});
					}
					const tailViolations = [];
					if (Object.hasOwn(frame.node, "additionalProperties") && frame.node.additionalProperties === false) {
						for (const key of Object.keys(frame.value)) if (!Object.hasOwn(properties, key)) tailViolations.push(`"${propertyPath(frame.path, key)}" is not a declared property (additionalProperties: false)`);
					}
					frame.kind = "object";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = violations;
					frame.tailViolations = tailViolations;
					frame.phase = "children";
					break;
				}
				case "array": {
					if (!Array.isArray(frame.value)) {
						finish([`"${diagnosticPath(frame.path)}" must be an array`]);
						break;
					}
					const items = Object.hasOwn(frame.node, "items") ? frame.node.items : void 0;
					const children = items === void 0 ? [] : frame.value.flatMap((entry, index) => [{
						node: items,
						value: entry,
						path: `${frame.path}[${index}]`
					}]);
					frame.kind = "array";
					frame.children = children;
					frame.childIndex = 0;
					frame.violations = [];
					frame.phase = "children";
					break;
				}
				case "string":
					finish(typeof frame.value === "string" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a string`]);
					break;
				case "number":
					finish(typeof frame.value !== "number" ? [`"${diagnosticPath(frame.path)}" must be a number`] : !isJsonNumber(frame.value) ? [`"${diagnosticPath(frame.path)}" must be a finite JSON number`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "integer":
					finish(!isJsonNumber(frame.value) || !Number.isInteger(frame.value) ? [`"${diagnosticPath(frame.path)}" must be an integer`] : checkScalarValue(frame.node, frame.value, frame.path));
					break;
				case "boolean":
					finish(typeof frame.value === "boolean" ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be a boolean`]);
					break;
				case "null":
					finish(frame.value === null ? checkScalarValue(frame.node, frame.value, frame.path) : [`"${diagnosticPath(frame.path)}" must be null`]);
					break;
				default: finish(assertNever(nodeType, "JsonSchemaType"));
			}
		} catch (error) {
			let failed = frames.pop();
			while (failed !== void 0 && !failed.catches) failed = frames.pop();
			if (failed === void 0) throw error;
			receive(losslessValueViolation(failed.path));
		}
	}
	/* v8 ignore next -- every root frame finishes or throws. */
	return rootResult ?? losslessValueViolation(path);
}
/**
* Validate a candidate value against an asserted raw schema. The function is
* total for arbitrary values and returns path-qualified violations.
* @param schema - a schema accepted by {@link assertSupportedJsonSchema}.
* @param value - the candidate JSON value.
* @param path - root label used in diagnostics.
* @returns All violations in walk order; empty means valid.
*/
function validateJsonSchemaValue(schema, value, path = "value") {
	return checkValue(schema, value, path);
}
/** Unified JSON-value schema DSL, inference, compilation, and typed tool helper. @module dsh-tools/schema */
const ANNOTATION_KEYS = [
	"description",
	"title",
	"default",
	"examples"
];
/** Throw one author-schema violation through the shared schema error type. */
function authorError(message) {
	throw new JsonSchemaError([message]);
}
/** Copy own annotation fields for validation by the raw-schema boundary. */
function copyAnnotations(source, target) {
	if (Object.hasOwn(source, "description")) target.description = source.description;
	if (Object.hasOwn(source, "title")) target.title = source.title;
	if (Object.hasOwn(source, "default")) target.default = source.default;
	if (Object.hasOwn(source, "examples")) target.examples = source.examples;
}
/** Reject author-only keys outside one node's declared vocabulary. */
function assertAuthorKeys(source, path, allowed) {
	for (const key of Object.keys(source)) if (!allowed.includes(key)) authorError(`${path}.${key} is not supported by the value schema DSL`);
}
/** Install a compiled node without giving `__proto__` assignment semantics. */
function assignCompiledNode(destination, node) {
	switch (destination.kind) {
		case "root":
			destination.holder.value = node;
			break;
		case "property":
			Object.defineProperty(destination.target, destination.key, {
				value: node,
				enumerable: true,
				configurable: true,
				writable: true
			});
			break;
		case "item":
			destination.target.items = node;
			break;
		case "one-of":
			destination.target[destination.index] = node;
			break;
	}
}
/** Install a compiled property map at its root or containing object node. */
function assignCompiledPropertyMap(destination, compiled) {
	if (destination.kind === "root") destination.holder.value = compiled;
	else destination.target.properties = compiled.properties;
}
/** Execute an author-schema compilation task graph without recursive descent. */
function runSchemaCompiler(initial) {
	const seen = /* @__PURE__ */ new Set();
	const tasks = [initial];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "leave") {
			seen.delete(task.input);
			continue;
		}
		if (task.kind === "property-map-tail") {
			if (task.required.length > 0) {
				task.compiled.required = task.required;
				if (task.destination.kind === "object") task.destination.target.required = task.required;
			}
			continue;
		}
		if (task.kind === "property") {
			if (!isJsonSchemaRecord(task.property)) authorError(`${task.path} must be a value schema object`);
			if (Object.hasOwn(task.property, "required") && task.property.required !== true) authorError(`${task.path}.required must be true when present`);
			if (Object.hasOwn(task.property, "required") && task.property.required === true) task.required.push(task.key);
			tasks.push({
				kind: "value",
				input: task.property,
				path: task.path,
				allowRequired: true,
				destination: {
					kind: "property",
					target: task.properties,
					key: task.key
				}
			});
			continue;
		}
		if (task.kind === "property-map") {
			if (!isJsonSchemaRecord(task.input)) authorError(`${task.path} must be an object of value schemas`);
			if (seen.has(task.input)) authorError(`${task.path} is circular`);
			seen.add(task.input);
			const compiled = { properties: {} };
			const required = [];
			assignCompiledPropertyMap(task.destination, compiled);
			tasks.push({
				kind: "leave",
				input: task.input
			});
			tasks.push({
				kind: "property-map-tail",
				compiled,
				required,
				destination: task.destination
			});
			const entries = Object.entries(task.input);
			for (let index = entries.length - 1; index >= 0; index--) {
				const entry = entries[index];
				/* v8 ignore next -- the loop is bounded by the captured entry count. */
				if (entry === void 0) continue;
				tasks.push({
					kind: "property",
					property: entry[1],
					path: `${task.path}.${entry[0]}`,
					key: entry[0],
					properties: compiled.properties,
					required
				});
			}
			continue;
		}
		const { input, path } = task;
		if (!isJsonSchemaRecord(input)) authorError(`${path} must be a value schema object`);
		if (seen.has(input)) authorError(`${path} is circular`);
		seen.add(input);
		const authorKeys = [...ANNOTATION_KEYS, ...task.allowRequired ? ["required"] : []];
		const node = {};
		assignCompiledNode(task.destination, node);
		tasks.push({
			kind: "leave",
			input
		});
		if (Object.hasOwn(input, "oneOf")) {
			assertAuthorKeys(input, path, [
				...authorKeys,
				"oneOf",
				"type"
			]);
			if (Object.hasOwn(input, "type")) authorError(`${path} cannot declare both type and oneOf`);
			if (!isPlainJsonArray(input.oneOf)) authorError(`${path}.oneOf must be an array of at least two value schemas`);
			const branches = [];
			node.oneOf = branches;
			copyAnnotations(input, node);
			for (let index = input.oneOf.length - 1; index >= 0; index--) tasks.push({
				kind: "value",
				input: input.oneOf[index],
				path: `${path}.oneOf[${index}]`,
				allowRequired: false,
				destination: {
					kind: "one-of",
					target: branches,
					index
				}
			});
			continue;
		}
		const inputType = Object.hasOwn(input, "type") ? input.type : void 0;
		switch (inputType) {
			case "json":
				assertAuthorKeys(input, path, [...authorKeys, "type"]);
				copyAnnotations(input, node);
				break;
			case "object":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"properties",
					"additionalProperties"
				]);
				if (!Object.hasOwn(input, "additionalProperties") || typeof input.additionalProperties !== "boolean") authorError(`${path}.additionalProperties must be explicitly true or false`);
				node.type = "object";
				copyAnnotations(input, node);
				node.additionalProperties = input.additionalProperties;
				if (Object.hasOwn(input, "properties")) tasks.push({
					kind: "property-map",
					input: input.properties,
					path: `${path}.properties`,
					destination: {
						kind: "object",
						target: node
					}
				});
				break;
			case "array":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"items"
				]);
				node.type = "array";
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "items")) tasks.push({
					kind: "value",
					input: input.items,
					path: `${path}.items`,
					allowRequired: false,
					destination: {
						kind: "item",
						target: node
					}
				});
				break;
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				assertAuthorKeys(input, path, [
					...authorKeys,
					"type",
					"enum",
					"const"
				]);
				node.type = inputType;
				copyAnnotations(input, node);
				if (Object.hasOwn(input, "enum")) {
					if (!isPlainJsonArray(input.enum)) authorError(`${path}.enum must be a non-empty array of scalar values`);
					node.enum = Array.from(input.enum, (entry) => entry);
				}
				if (Object.hasOwn(input, "const")) node.const = input.const;
				break;
			default: authorError(`${path}.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`);
		}
	}
}
/** Compile one implicit property map, collecting per-property requiredness. */
function compilePropertyMap(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "property-map",
		input,
		path,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/** Compile one author node without applying any consumer root restriction. */
function compileValueSchema(input, path) {
	const holder = {};
	runSchemaCompiler({
		kind: "value",
		input,
		path,
		allowRequired: false,
		destination: {
			kind: "root",
			holder
		}
	});
	/* v8 ignore next -- the root task assigns before scheduling any descendants. */
	return holder.value ?? authorError(`${path} did not compile`);
}
/**
* Compile one author-facing value schema to the enforced raw JSON Schema
* subset. The author-only `json` node becomes an annotation-only schema.
* @param spec - schema for any JSON-value root.
* @returns The asserted raw schema projection.
*/
function valueSchemaSpecToJsonSchema(spec) {
	const schema = compileValueSchema(spec, "schema");
	assertSupportedJsonSchema(schema);
	return schema;
}
/**
* Compile the implicit open parameter object into raw JSON Schema.
* @param spec - per-property parameter definitions.
* @returns An object-rooted raw schema with no implicit-root openness override.
*/
function parameterSchemaSpecToJsonSchema(spec) {
	const compiled = compilePropertyMap(spec, "parameters");
	const schema = {
		type: "object",
		properties: compiled.properties,
		...compiled.required === void 0 ? {} : { required: compiled.required }
	};
	assertSupportedJsonSchema(schema);
	return schema;
}
/** Invalid model-generated arguments for a typed tool. */
var ToolArgsError = class extends HarnessError {
	/** Individual violations in schema-walk order. */
	violations;
	constructor(violations) {
		super(`invalid arguments: ${violations.join("; ")}`, "INVALID_ARGS");
		this.name = "ToolArgsError";
		this.violations = violations;
	}
};
/**
* Define a first-party tool with inferred arguments and strict execution
* validation. Replay-only presenters validate softly and fall back to generic
* rendering for obsolete logged arguments.
* @param options - typed definition and optional finalizer and presenters.
* @returns A registry-ready definition.
*/
function defineTool(options) {
	const userExecute = options.execute;
	const userFinalizeContent = options.finalizeContent;
	const userRender = options.output.render;
	const userPresentationMeta = options.output.presentationMeta;
	const userPresentCall = options.presentCall;
	const userPresentResult = options.presentResult;
	const userIsConcurrencySafe = options.isConcurrencySafe;
	if (options.timeoutMs !== void 0 && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) throw new Error(`defineTool(${options.name}): timeoutMs must be a positive finite number`);
	const parameters = parameterSchemaSpecToJsonSchema(options.parameters);
	const outputSchema = valueSchemaSpecToJsonSchema(options.output.schema);
	const validate = (args) => validateJsonSchemaValue(parameters, args, "");
	const tool = {
		name: options.name,
		description: options.description,
		parameters,
		output: {
			schema: outputSchema,
			render(args, value) {
				return userRender(args, value);
			},
			...userPresentationMeta !== void 0 ? { presentationMeta(args, value) {
				return userPresentationMeta(args, value);
			} } : {}
		},
		...options.timeoutMs !== void 0 ? { timeoutMs: options.timeoutMs } : {},
		async execute(args, exec) {
			const violations = validate(args);
			if (violations.length > 0) throw new ToolArgsError(violations);
			return userExecute(args, exec);
		}
	};
	if (userFinalizeContent) tool.finalizeContent = (exec, result) => userFinalizeContent(exec, result);
	if (userPresentCall) tool.presentCall = (args) => {
		if (validate(args).length > 0) return void 0;
		return userPresentCall(args);
	};
	if (userPresentResult) tool.presentResult = (args, result) => {
		if (validate(args).length > 0) return void 0;
		return userPresentResult(args, result);
	};
	if (userIsConcurrencySafe) tool.isConcurrencySafe = (args) => {
		if (validate(args).length > 0) return false;
		return userIsConcurrencySafe(args);
	};
	return tool;
}
/**
* Code Mode `run_code` transport. Programs call the registry's agent-visible
* tools through nested executions scheduled under the native concurrency
* contract; each sub-dispatch is logged for reconstruction, while only the
* outer curated result enters model history.
* @module @deepseek-ai/dsh-tools/src/code-mode
*/
/** The model-facing name of the Code Mode tool. */
const RUN_CODE_NAME = "run_code";
/**
* The TypeScript flavor: the fallback for a schema read with no runtime
* mounted ({@link resolveFlavor} owns which readers reach that). A real
* assembly always resolves a runtime first, so the model never sees this
* fallback outside its own language.
*/
const TYPESCRIPT_FLAVOR = {
	description: "Execute a TypeScript program against the available tools. Takes two required arguments: `code`, the BODY of an async function (erasable syntax only; top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Only what you print or return comes back — curate it.",
	codeDescription: "The program: the body of an async TypeScript function."
};
/** Per-language `run_code` schema flavors (see {@link RunCodeFlavor}); one entry per {@link CodeSdkLanguage}. */
const RUN_CODE_FLAVORS = {
	typescript: TYPESCRIPT_FLAVOR,
	python: {
		description: "Execute a Python program against the available tools. Takes two required arguments: `code`, the BODY of an async function (top-level `await` and `return` work), and `description`, a short summary of what the program does. Call tools as `await tools.name(args)` per the declarations in the system prompt. Answer with `print(...)` and/or `return <value>` — only that comes back, so curate it.",
		codeDescription: "The program: the body of an async Python function."
	}
};
/**
* The `description` parameter's model-facing description: language-independent
* (the UI label contract is the same for every runtime), shared between the
* static spec and the language-aware `parameters` getter so the two emissions
* can never drift.
*/
const RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION = "Clear, concise description of what this program does in active voice, 5-10 words (shown in the UI). Examples: \"Count TODO markers across packages\"; \"Read failing test and its fixture\"; \"Rename config key in every cordis.yml\".";
/**
* Resolve the {@link RunCodeFlavor} for the loaded runtime's language, read at
* schema-emission time so the model-visible `run_code` schema always matches
* the SDK section's language. `peekRuntime` returns `undefined` only when no
* runtime is mounted, which reaches this function through definition readers
* and `schemas()` — the doc-catalog harvest is the only shipped one, and none
* of them feeds a model, because `wireSchemas` calls `requireCodeRuntime`
* before projecting — so that path degrades to {@link TYPESCRIPT_FLAVOR}. A
* mounted runtime whose language has no flavor entry fails loud, exactly as
* `requireCodeRuntime` rejects it at assembly. Keeping this table in step with
* `SDK_RENDERERS` is the compiler's job ({@link CodeSdkLanguage}); what this
* guard owns is the runtime-supplied language neither table knows, which never
* yields a wrong-language schema for a real runtime.
*/
function resolveFlavor(peekRuntime) {
	const runtime = peekRuntime();
	if (runtime === void 0) return TYPESCRIPT_FLAVOR;
	const flavor = RUN_CODE_FLAVORS[runtime.language];
	if (!Object.hasOwn(RUN_CODE_FLAVORS, runtime.language) || flavor === void 0) {
		const known = Object.keys(RUN_CODE_FLAVORS).map((name$1) => JSON.stringify(name$1)).join(", ");
		throw new Error(`dsh-tools: no run_code schema flavor registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
	}
	return flavor;
}
/**
* Thrown by `run_code` when the program run itself failed — a program
* exception, a budget expiry, an abort, or substrate death. Extends
* {@link HarnessError} (`code: 'CODE_RUN_FAILED'`); the registry's execution
* pipeline converts it into a structured `isError` result whose text carries
* the failure kind plus the captured logs, so the model can self-correct.
*/
var CodeRunFailedError = class extends HarnessError {
	constructor(message) {
		super(message, "CODE_RUN_FAILED");
		this.name = "CodeRunFailedError";
	}
};
/**
* Snapshot one binding call's argument as lossless JSON, then snapshot that
* detached value again so dispatch and logging stay independent without
* reintroducing structured-clone's platform-specific nesting limit.
*/
function jsonNormalizeArgs(value) {
	let snapshot;
	try {
		snapshot = snapshotJsonValue(value);
	} catch (error) {
		throw new Error(`tool arguments must be lossless JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (snapshot === void 0) throw new Error("tool arguments must be lossless JSON (call the tool with an arguments object, e.g. `{}`)");
	const logged = snapshotJsonValue(snapshot);
	/* v8 ignore next -- snapshot is already a detached lossless JSON value. */
	if (logged === void 0) throw new Error("tool arguments could not be detached for durable logging");
	return {
		dispatched: snapshot,
		logged
	};
}
/** Two-space JSON presentation, matching the existing shallow `run_code` text contract. */
const JSON_INDENT = "  ";
/**
* ECMAScript caps `JSON.stringify`'s `space` string at ten characters. The
* renderer also caps TOTAL indentation there, compacting deeper subtrees, so
* formatted output remains linear in the canonical JSON size.
*/
const MAX_JSON_INDENT_CHARS = 10;
/** Render one non-string JSON root without recursive traversal or unbounded indentation growth. */
function renderJsonValue(value) {
	const chunks = [];
	const tasks = [{
		kind: "value",
		value,
		depth: 0,
		compact: false
	}];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (task.kind === "text") {
			chunks.push(task.text);
			continue;
		}
		const current = task.value;
		if (current === null || typeof current === "boolean" || typeof current === "number") {
			chunks.push(String(current));
			continue;
		}
		if (typeof current === "string") {
			chunks.push(JSON.stringify(current));
			continue;
		}
		const compact = task.compact || (task.depth + 1) * 2 > MAX_JSON_INDENT_CHARS;
		const childDepth = task.depth + 1;
		if (Array.isArray(current)) {
			chunks.push("[");
			if (current.length === 0) {
				chunks.push("]");
				continue;
			}
			tasks.push({
				kind: "text",
				text: compact ? "]" : `\n${JSON_INDENT.repeat(task.depth)}]`
			});
			for (let index = current.length - 1; index >= 0; index--) {
				const item = current[index];
				/* v8 ignore next -- canonical JsonValue arrays are dense. */
				if (item === void 0) throw new Error("cannot render a sparse JSON array");
				tasks.push({
					kind: "value",
					value: item,
					depth: childDepth,
					compact
				});
				tasks.push({
					kind: "text",
					text: compact ? index === 0 ? "" : "," : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}`
				});
			}
			continue;
		}
		const keys = Object.keys(current);
		chunks.push("{");
		if (keys.length === 0) {
			chunks.push("}");
			continue;
		}
		tasks.push({
			kind: "text",
			text: compact ? "}" : `\n${JSON_INDENT.repeat(task.depth)}}`
		});
		for (let index = keys.length - 1; index >= 0; index--) {
			const key = keys[index];
			/* v8 ignore next -- the loop is bounded by the captured key count. */
			if (key === void 0) throw new Error("cannot render a missing JSON object key");
			const item = current[key];
			/* v8 ignore next -- canonical JsonValue records contain no undefined properties. */
			if (item === void 0) throw new Error("cannot render an undefined JSON object property");
			tasks.push({
				kind: "value",
				value: item,
				depth: childDepth,
				compact
			});
			tasks.push({
				kind: "text",
				text: compact ? `${index === 0 ? "" : ","}${JSON.stringify(key)}:` : `${index === 0 ? "\n" : ",\n"}${JSON_INDENT.repeat(childDepth)}${JSON.stringify(key)}: `
			});
		}
	}
	return chunks.join("");
}
/** Render one present program completion value for the model-facing result text. */
function renderValue(value) {
	return typeof value === "string" ? value : renderJsonValue(value);
}
/**
* Build the `run_code` {@link ToolDefinition}: required `code` and
* `description` parameters, executed through the dispatch bridge described
* above. The
* registry reserves it as presentation infrastructure under non-native modes,
* outside the filterable global/scoped capability layers.
* @param registry - the owning registry (sub-calls go through its `execute`,
*   bindings cover its registered tools).
* @param options - the registry-private capabilities described above.
* @returns the registry-ready definition.
*/
function createRunCodeTool(registry, options) {
	const { requireRuntime, peekRuntime, maxParallel, shapeDispatchLog } = options;
	const definition = defineTool({
		name: RUN_CODE_NAME,
		description: TYPESCRIPT_FLAVOR.description,
		parameters: {
			code: {
				type: "string",
				required: true,
				description: TYPESCRIPT_FLAVOR.codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					logs: {
						type: "array",
						required: true,
						items: { type: "string" }
					},
					result: { type: "json" }
				}
			},
			render: (_args, value) => {
				const rendered = value.result === void 0 ? "" : renderValue(value.result);
				const parts = [value.logs.join("\n"), rendered].filter((part) => part.length > 0);
				return [{
					type: "text",
					text: parts.length > 0 ? parts.join("\n") : "(run_code completed with no output)"
				}];
			}
		},
		async execute(args, exec) {
			if (args.description.trim().length === 0) throw new Error("invalid description: expected a non-empty string");
			const runtime = requireRuntime();
			const runController = new AbortController();
			const onOuterAbort = () => {
				runController.abort(exec.signal.reason);
			};
			exec.signal.addEventListener("abort", onOuterAbort, { once: true });
			let dispatches = 0;
			const pendingQueue = [];
			const inFlight = /* @__PURE__ */ new Set();
			/** Tracked settle-event side work (log-content listener + append), drained at run settlement. */
			const logWork = /* @__PURE__ */ new Set();
			const commitQueue = [];
			let exclusiveActive = false;
			let driving = false;
			let driverRun = Promise.resolve();
			let wake;
			const wakeup = () => {
				const release = wake;
				wake = void 0;
				release?.();
			};
			/**
			* The single ordered lane. Each pass commits the head-of-line settled
			* dispatch (ordered post-execute), then starts the next queued entry if
			* its slot is free (ordered pre-execute), and otherwise sleeps until a
			* body settles or a new submission arrives. One run reaching the
			* empty-queues/empty-pool state is quiescence.
			*/
			const drive = () => {
				if (driving) return driverRun;
				driving = true;
				driverRun = (async () => {
					try {
						for (;;) {
							const signal = new Promise((resolve) => {
								wake = resolve;
							});
							const commitHead = commitQueue[0];
							if (commitHead !== void 0 && commitHead.settled) {
								commitQueue.shift();
								await commitHead.commit();
								if (commitHead.mode === "exclusive") exclusiveActive = false;
								continue;
							}
							const head = pendingQueue[0];
							if (head !== void 0) {
								if (runController.signal.aborted) {
									pendingQueue.shift();
									head.abandon();
									continue;
								}
								const mode = head.classify();
								if (!exclusiveActive && (mode === "exclusive" ? inFlight.size === 0 : inFlight.size < maxParallel)) {
									if (mode === "exclusive") exclusiveActive = true;
									head.mode = mode;
									pendingQueue.shift();
									commitQueue.push(head);
									await head.start();
									const flight = head.flight.finally(() => {
										inFlight.delete(flight);
										wakeup();
									});
									inFlight.add(flight);
									continue;
								}
							}
							if (pendingQueue.length === 0 && commitQueue.length === 0 && inFlight.size === 0) return;
							await signal;
						}
					} finally {
						driving = false;
						wake = void 0;
					}
				})();
				return driverRun;
			};
			/** Every dispatch settled AND committed; nothing can start (the run is aborted at call time). */
			const drainDispatches = async () => {
				await drive();
				while (logWork.size > 0) await Promise.allSettled([...logWork]);
			};
			const runOver = () => runController.signal.aborted;
			const binding = (name$1) => async (rawArgs) => {
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name$1} not dispatched`);
				const normalized = jsonNormalizeArgs(rawArgs);
				const n = ++dispatches;
				const subCallId = CallId(`${String(exec.callId)}:code:${n}`);
				const input = {
					callId: subCallId,
					rootCallId: exec.rootCallId,
					name: name$1,
					arguments: normalized.dispatched,
					...exec.agent ? { agent: exec.agent } : {},
					parent: exec.token,
					signal: runController.signal
				};
				const scheduler = registry[TOOL_RUNTIME_SCHEDULER];
				const outcome = await new Promise((resolve, reject) => {
					let parked;
					const settle = (result) => {
						resolve(result.isError ? {
							isError: true,
							message: result.error.message
						} : {
							isError: false,
							value: result.value
						});
						const agent = exec.agent;
						if (agent === void 0) return;
						const task = (async () => {
							const logged = await shapeDispatchLog({
								exec,
								agent,
								subCallId,
								name: name$1,
								isError: result.isError,
								content: result.content
							});
							agent.session.append("tool/code-dispatch", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name: name$1,
								arguments: normalized.logged,
								isError: result.isError,
								content: logged
							});
						})().finally(() => {
							logWork.delete(task);
						});
						logWork.add(task);
					};
					pendingQueue.push({
						flight: Promise.resolve(),
						settled: false,
						classify: () => registry.executionMode(input).kind,
						abandon: () => {
							reject(/* @__PURE__ */ new Error(`run_code run is over (${String(runController.signal.reason)}); ${name$1} tool call abandoned`));
						},
						async start() {
							exec.agent?.session.append("tool/code-dispatch-start", {
								rootCallId: exec.rootCallId,
								parentCallId: exec.callId,
								subCallId,
								name: name$1,
								arguments: normalized.logged
							});
							const prepared = await scheduler.prepare(input);
							if (prepared.kind === "dispatch") {
								this.flight = scheduler.dispatch(prepared.exec).then((dispatchOutcome) => {
									parked = {
										kind: dispatchOutcome.kind,
										exec: prepared.exec,
										result: dispatchOutcome.result
									};
									this.settled = true;
								});
								return;
							}
							parked = {
								kind: prepared.kind,
								exec: prepared.exec,
								result: prepared.result
							};
							this.settled = true;
						},
						async commit() {
							/* v8 ignore next -- commit() runs only after `settled` flipped, which set parked. */
							if (parked === void 0) return;
							const result = parked.kind === "post-result" ? await scheduler.finalize(parked.exec, parked.result) : scheduler.finish(parked.exec, parked.result);
							for (const context of result.additionalContexts ?? []) exec.deferContext(context);
							if (result.concludesTurn) exec.concludeTurn();
							settle(result);
							while (logWork.size > maxParallel) await Promise.race(logWork);
						}
					});
					wakeup();
					drive();
				});
				if (runOver()) throw new Error(`run_code run is over (${String(runController.signal.reason)}); ${name$1} result discarded`);
				if (outcome.isError) throw new Error(outcome.message);
				return outcome.value;
			};
			const functions = Object.create(null);
			for (const schema of registry.schemas(exec.agent)) {
				if (schema.name === "run_code") continue;
				Object.defineProperty(functions, schema.name, {
					enumerable: true,
					value: binding(schema.name)
				});
			}
			try {
				let result;
				try {
					result = await runtime.run({
						program: args.code,
						bindings: [{
							global: "tools",
							functions,
							errorClass: {
								name: "ToolCallError",
								memberNameProperty: "toolName"
							}
						}],
						signal: runController.signal
					});
				} finally {
					runController.abort("run_code settled");
					await drainDispatches();
				}
				if (result.error) {
					const logsText = result.logs.length > 0 ? `\nCaptured output:\n${result.logs.join("\n")}` : "";
					throw new CodeRunFailedError(`code run failed (${result.error.kind}): ${result.error.message}${logsText}`);
				}
				return {
					logs: result.logs,
					...result.value !== void 0 ? { result: result.value } : {}
				};
			} finally {
				exec.signal.removeEventListener("abort", onOuterAbort);
			}
		},
		presentCall: (args) => ({
			card: "generic",
			title: args.description,
			kind: "execute",
			rawInput: args.code
		})
	});
	Object.defineProperty(definition, "description", {
		enumerable: true,
		get: () => resolveFlavor(peekRuntime).description
	});
	Object.defineProperty(definition, "parameters", {
		enumerable: true,
		get: () => parameterSchemaSpecToJsonSchema({
			code: {
				type: "string",
				required: true,
				description: resolveFlavor(peekRuntime).codeDescription
			},
			description: {
				type: "string",
				required: true,
				description: RUN_CODE_DESCRIPTION_PARAM_DESCRIPTION
			}
		})
	});
	return definition;
}
/**
* Code Mode codegen: the pure projection from registered tool schemas to the TypeScript SDK
* text the model programs against (the `tools:sdk` prompt section). Sibling of
* `json-schema.ts` — `schemas()` (native function calling) and this module (the generated
* `declare const tools` API) are two projections of the same store.
* @module @deepseek-ai/dsh-tools/src/ts-types
*/
/** Property names that are valid bare TS identifiers; anything else is quoted. */
const IDENTIFIER$1 = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Render an object key: bare when it is a valid identifier, quoted otherwise (every name stays reachable, no aliasing). */
function renderKey(name$1) {
	return IDENTIFIER$1.test(name$1) ? name$1 : JSON.stringify(name$1);
}
/** One `indent`-deep line prefix (two spaces per level). */
function pad$1(indent) {
	return "  ".repeat(indent);
}
/** A one-line JSDoc block for a schema `description`, or no lines when there is none. */
function docLines$1(description, indent) {
	if (typeof description !== "string" || description.length === 0) return [];
	const collapsed = description.replace(/\s+/g, " ").trim();
	return [`${pad$1(indent)}/** ${collapsed.replaceAll("*/", String.raw`*\/`)} */`];
}
/** Render one scalar already validated by the unified schema boundary. */
function renderScalar(value) {
	return JSON.stringify(value);
}
/** Render a validated scalar `const`/`enum`, falling back to the broad type. */
function renderConstrainedScalar$1(node, type) {
	const broad = type === "integer" ? "number" : type;
	if (Object.hasOwn(node, "const")) return renderScalar(node.const);
	if (Object.hasOwn(node, "enum")) return node.enum.map(renderScalar).join(" | ");
	return broad;
}
/** Build one document from captured parts while retaining the legacy array-parenthesization test. */
function typeDocumentFrom(parts) {
	return {
		parts,
		containsUnionOrIntersection: parts.some((part) => typeof part === "string" ? part.includes("|") || part.includes("&") : part.containsUnionOrIntersection)
	};
}
/** Build a small document without an intermediate array at each call site. */
function typeDocument(...parts) {
	return typeDocumentFrom(parts);
}
/** Flatten a nested document with an explicit work stack. */
function flattenTypeDocument(document) {
	const chunks = [];
	const tasks = [document];
	for (let task = tasks.pop(); task !== void 0; task = tasks.pop()) {
		if (typeof task === "string") {
			chunks.push(task);
			continue;
		}
		for (let index = task.parts.length - 1; index >= 0; index--) {
			const part = task.parts[index];
			/* v8 ignore next -- the loop is bounded by the captured part count. */
			if (part !== void 0) tasks.push(part);
		}
	}
	return chunks.join("");
}
/** Initialize one schema-render frame with empty aggregation state. */
function schemaRenderFrame(node, indent) {
	return {
		node,
		indent,
		phase: "start",
		children: [],
		childIndex: 0,
		childDocuments: [],
		entries: []
	};
}
/** Render an already asserted schema to a composable document. */
function renderSupportedSchema(schema, indent) {
	const frames = [schemaRenderFrame(schema, indent)];
	let rootDocument;
	const finish = (document) => {
		frames.pop();
		const parent = frames.at(-1);
		if (parent === void 0) rootDocument = document;
		else parent.childDocuments.push(document);
	};
	while (frames.length > 0) {
		const frame = frames.at(-1);
		/* v8 ignore next -- the loop condition guarantees a current frame. */
		if (frame === void 0) break;
		if (frame.phase === "children") {
			if (frame.childIndex < frame.children.length) {
				const child = frame.children[frame.childIndex];
				/* v8 ignore next -- childIndex is bounded by children.length. */
				if (child === void 0) throw new Error("missing schema render child");
				frame.childIndex++;
				frames.push(schemaRenderFrame(child.node, child.indent));
				continue;
			}
			if (frame.kind === "oneOf") {
				const parts$1 = [];
				for (let index = 0; index < frame.childDocuments.length; index++) {
					if (index > 0) parts$1.push(" | ");
					const child = frame.childDocuments[index];
					/* v8 ignore next -- child documents correspond one-to-one with children. */
					if (child !== void 0) parts$1.push(child);
				}
				finish(typeDocumentFrom(parts$1));
				continue;
			}
			if (frame.kind === "array") {
				const child = frame.childDocuments[0];
				/* v8 ignore next -- array frames always schedule exactly one child. */
				if (child === void 0) throw new Error("missing array item type");
				finish(child.containsUnionOrIntersection ? typeDocument("(", child, ")[]") : typeDocument(child, "[]"));
				continue;
			}
			const required = new Set(frame.node.required);
			const parts = ["{"];
			for (let index = 0; index < frame.entries.length; index++) {
				const entry = frame.entries[index];
				const child = frame.childDocuments[index];
				/* v8 ignore next -- object entries and child documents have the same length. */
				if (entry === void 0 || child === void 0) throw new Error("missing object property type");
				const [name$1, prop] = entry;
				for (const line of docLines$1(prop.description, frame.indent + 1)) parts.push("\n", line);
				parts.push("\n", `${pad$1(frame.indent + 1)}${renderKey(name$1)}${required.has(name$1) ? "" : "?"}: `, child, ";");
			}
			parts.push("\n", `${pad$1(frame.indent)}}`);
			const declared = typeDocumentFrom(parts);
			finish(frame.node.additionalProperties === false ? declared : typeDocument(declared, " & Record<string, JsonValue>"));
			continue;
		}
		const node = frame.node;
		if (node.oneOf !== void 0) {
			frame.kind = "oneOf";
			frame.children = Array.from(node.oneOf, (child) => ({
				node: child,
				indent: frame.indent
			}));
			frame.childIndex = 0;
			frame.childDocuments = [];
			frame.phase = "children";
			continue;
		}
		if (node.type === void 0) {
			finish(typeDocument("JsonValue"));
			continue;
		}
		switch (node.type) {
			case "string":
			case "number":
			case "integer":
			case "boolean":
			case "null":
				finish(typeDocument(renderConstrainedScalar$1(node, node.type)));
				break;
			case "array":
				if (node.items === void 0) finish(typeDocument("JsonValue[]"));
				else {
					frame.kind = "array";
					frame.children = [{
						node: node.items,
						indent: frame.indent
					}];
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			case "object": {
				const open = node.additionalProperties !== false;
				const entries = Object.entries(node.properties ?? {});
				if (entries.length === 0) finish(typeDocument(open ? "Record<string, JsonValue>" : "Record<string, never>"));
				else {
					frame.kind = "object";
					frame.entries = entries;
					frame.children = entries.map(([, child]) => ({
						node: child,
						indent: frame.indent + 1
					}));
					frame.childIndex = 0;
					frame.childDocuments = [];
					frame.phase = "children";
				}
				break;
			}
			default: finish(typeDocument("unknown"));
		}
	}
	/* v8 ignore next -- every root frame produces one document. */
	return rootDocument ?? typeDocument("unknown");
}
/**
* Map one enforced JSON-Schema node to a TypeScript type literal. Supports
* every unified schema construct and returns `unknown` for malformed or
* unsupported inputs without throwing.
* @param schema - the JSON-Schema node (any shape; hostile inputs degrade).
* @param indent - the indentation level for nested object members.
* @returns the TS type text (multi-line for objects with properties).
*/
function jsonSchemaToTs(schema, indent = 0) {
	try {
		assertSupportedJsonSchema(schema);
		return flattenTypeDocument(renderSupportedSchema(schema, indent));
	} catch {
		return "unknown";
	}
}
/** The fixed model-facing usage contract rendered above the declarations (see the Code Mode Agent Note's "What the model sees"). */
const SDK_INSTRUCTIONS$1 = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async TypeScript function (erasable syntax only — no \`enum\` or namespaces; type annotations are advisory, the code runs type-stripped) — and \`description\`, a short summary of what the program does. Inside the program:

- Call tools as \`await tools.name(args)\` — quoted access for exotic names: \`tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value. Tool arguments must be lossless JSON.
- A FAILED tool call rejects with \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose \`message\` is human-readable — \`try/catch\` it to handle and continue.
- Independent read-only calls MAY overlap under \`Promise.all\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit results with \`return\` and/or \`console.log(...)\`. ONLY what you print or return comes back to you — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section: the fixed usage instructions
* plus one `declare const tools` interface covering every given tool.
* Deterministic — tools are emitted in lexicographic name order, so an
* unchanged tool set produces byte-identical text across assemblies. The sort
* is not a total order on byte-equal names, so two schemas sharing a name
* would render in argument order; the caller's visible-capability map is keyed
* by name, so the input never carries a duplicate.
* @param schemas - the tool schemas to declare (the caller excludes
*   `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdk(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const argsMembers = [];
	const outputMembers = [];
	for (const schema of sorted) {
		argsMembers.push(...docLines$1(schema.description, 1));
		argsMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.parameters, 1)};`);
		outputMembers.push(`${pad$1(1)}${renderKey(schema.name)}: ${jsonSchemaToTs(schema.output, 1)};`);
	}
	return `${SDK_INSTRUCTIONS$1}\n\n\`\`\`ts\ntype JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }\n\n${[
		`interface ToolArgsMap {${argsMembers.length > 0 ? `\n${argsMembers.join("\n")}\n` : ""}}`,
		`interface ToolOutputMap {${outputMembers.length > 0 ? `\n${outputMembers.join("\n")}\n` : ""}}`,
		"type ToolName = keyof ToolOutputMap",
		[
			"declare class ToolCallError extends Error {",
			"  readonly name: \"ToolCallError\";",
			"  readonly toolName: ToolName;",
			"}"
		].join("\n"),
		[
			"declare const tools: {",
			"  [K in ToolName]: (args: ToolArgsMap[K]) => Promise<ToolOutputMap[K]>;",
			"}"
		].join("\n")
	].join("\n\n")}\n\`\`\``;
}
/**
* Code Mode codegen — Python flavor. The pure projection from registered tool schemas to the
* Python SDK text the model programs against under `runtime.language === 'python'`. Sibling of
* {@link ./ts-types.ts | ts-types.ts}; the two files are two projections of the same registry
* store, keyed by the loaded {@link @deepseek-ai/dsh-code-runtime#CodeRuntime.language | code
* runtime's language}.
*
* Under `mode: 'code'` the native tool schemas are omitted from the request, so this generated
* SDK is the model's ONLY source for each tool's argument names, required fields, types,
* descriptions, and canonical output shapes; under `mode: 'both'` the native schemas ship
* alongside it and it is one of two. Object-shaped arguments and outputs therefore render as one
* named `TypedDict` per tool (and per nested object), not an opaque `dict[str, Any]`, so the
* shape survives into the program under the mode that has nothing else to carry it.
* @module @deepseek-ai/dsh-tools/src/py-types
*/
/**
* The reference grammar's `xid_start xid_continue*` — the set
* `str.isidentifier()` accepts on a CPython whose Unicode tables match the
* engine's. See {@link isBareIdentifier} for what a version skew does.
*/
const IDENTIFIER = /^[\p{XID_Start}_]\p{XID_Continue}*$/u;
/**
* Whether a name can be emitted as a bare Python identifier rather than
* routed to the subscript/`dict[str, Any]` path.
*
* Python identifiers are not ASCII: `路径` is as legal a field name as `path`,
* and rejecting it would degrade the whole enclosing object, dropping every
* field's name, requiredness, and type — information whose only source under
* `mode: 'code'` is this generated text.
*
* NFKC stability is a second and separate condition, because CPython
* normalizes identifiers at compile time while JSON keys are compared as
* written: `ﬁeld` would be declared and reachable as `field`, so the SDK would
* advertise a key under a spelling the harness never accepts, and two keys
* that normalize together would collapse into one declaration. Those names
* take the subscript path, which carries their exact bytes.
*
* `IDENTIFIER` matches `str.isidentifier()` (measured on Node 22.23.1 vs
* CPython 3.9.6 tables): the equivalence holds inside the two versions' shared
* tables, and the skew characters below are exactly where that pair diverges.
* The predicate as a whole is deliberately stricter than `isidentifier()`,
* which does not test NFKC stability: `'ﬁeld'.isidentifier()` is True and
* this returns false.
*
* Both conditions are evaluated against the ENGINE's Unicode tables, and the
* two sides are versioned independently — `\p{XID_Start}`/`\p{XID_Continue}`
* follow the running engine (Node 22.23.1 reports Unicode 17.0) while CPython
* follows its own (3.9.6 reports 13.0.0). The skew is not symmetric. A CPython
* older than the engine is the dangerous direction: a character added to either
* property since its tables (U+10570 Vithkuqi and U+1E290 Toto, 14.0; U+1E4D0
* Nag Mundari, 15.0; U+1C89 Cyrillic TJE, 16.0 — ages per `DerivedAge.txt`; all
* four are NFKC-stable and accepted here, and all four are `Cn` on that 3.9.6,
* which rejects them) is emitted bare and its tokenizer refuses the character,
* taking the whole SDK block down — the same parseability invariant
* {@link UNPRINTABLE}, {@link LONE_SURROGATE} and {@link MAX_LIST_NESTING}
* exist for. Both properties carry it: a character added only to `XID_Continue`
* passes the trailing `\p{XID_Continue}*` in a tail position and fails the same
* way — U+200C ZWNJ and U+200D ZWJ are that case, gaining `XID_Continue` in UCD
* 15.1 and absent from it in 13.0.0, 14.0.0 and 15.0.0, so `a\u{200C}b` is
* emitted bare here while `isidentifier()` is False on 3.9.6 and on 3.12.13
* (15.0.0). A CPython newer than the engine only routes a legal name to the
* subscript/`dict[str, Any]` path: less readable, still correct. The NFKC
* condition reduces to the same skew, since normalization stability guarantees
* an assigned character's normalization never changes afterwards.
*
* This predicate is not the only reader of engine tables. {@link camelCase}
* reads them at three further points — its split set, its head test, and its
* `toUpperCase()` case mapping — and this predicate's verdict gates none of
* them: a class name derived there reaches emitted text whenever any object
* shape in the tool's schema declares a `TypedDict`, including for a tool this
* predicate rejected. A tool named `zz-\u{1E4D0}x` with such parameters never
* reaches the skew here (the `-` rejects it outright) yet emits `class
* Zz\u{1E4D0}xArgs`, which that same 3.9.6 refuses — Nag Mundari arrived two
* releases after its tables. The case mapping is a separate table rather than
* an XID membership test, and it fails on names both conditions above accept:
* `\u{019B}` is XID_Start and NFKC-stable, so this predicate accepts it and
* `async def \u{019B}` compiles on 3.9.6, but Node uppercases it to
* `\u{A7DC}` — unassigned in that CPython, whose own `.upper()` is the identity
* here — and the declared `class \u{A7DC}Args` fails with `invalid
* non-printable character U+A7DC`. Closing the exposure therefore covers all
* four read points, not this predicate alone; it needs the target interpreter's
* version, which the backend reporting `language: 'python'` owns; the
* language-dispatch Agent Note records the deferral.
*
* The `ts-types` sibling keeps its own ASCII rule rather than sharing this
* one: ECMAScript identifiers are a different set (`$`) and are never
* normalized, so one predicate cannot be correct for both. ZWJ/ZWNJ are not
* part of that difference — both sets carry them on the engine's tables; what
* separates the two there is the CPython table version above.
* @param name - the raw schema field or tool name.
* @returns whether the name can be emitted bare.
*/
function isBareIdentifier(name$1) {
	return IDENTIFIER.test(name$1) && name$1.normalize("NFKC") === name$1;
}
/**
* Python hard keywords: reserved everywhere, so a tool or field named
* ``class`` or ``lambda`` is legal on the wire but not as an attribute
* (``tools.class`` would be a SyntaxError in the model program) and not as a
* class-syntax `TypedDict` field. Such a tool renders under subscript access
* and such an object degrades to ``dict[str, Any]`` — the model still reaches
* every tool and field without collisions.
* Soft keywords (``match``, ``case``, ``type``, ``_`` — the language
* reference's whole set) are deliberately ABSENT: each is special in exactly
* one syntactic position — a statement head (``match``, ``type``), a ``match``
* statement's clause head (``case``), or a pattern (``_``) — so ``match: str``
* as a field and ``async def match(...)`` as a method are both legal, and
* including them would needlessly degrade common search/regex tool fields to
* ``dict[str, Any]``. Underscore-leading names are handled separately, not
* here: a non-dunder ``__token`` name-mangles, a dunder present on
* ``object``/``type`` resolves before the proxy hook, and implicit
* special-method lookup bypasses the hook.
*/
const RESERVED = new Set([
	"False",
	"None",
	"True",
	"and",
	"as",
	"assert",
	"async",
	"await",
	"break",
	"class",
	"continue",
	"def",
	"del",
	"elif",
	"else",
	"except",
	"finally",
	"for",
	"from",
	"global",
	"if",
	"import",
	"in",
	"is",
	"lambda",
	"nonlocal",
	"not",
	"or",
	"pass",
	"raise",
	"return",
	"try",
	"while",
	"with",
	"yield",
	"__debug__"
]);
/** `typing` symbols this module may emit, in the deterministic import order. */
const TYPING_ORDER = [
	"Any",
	"Literal",
	"NotRequired",
	"Protocol",
	"TypedDict"
];
/** `indent`-deep line prefix (four spaces per level to match PEP 8 output). */
function pad(indent) {
	return "    ".repeat(indent);
}
/**
* The `Cc` code points that survive the whitespace collapse in {@link describe}
* and have no printable form: the C0 controls, DEL, and the C1 controls. Only
* U+0009 to U+000D are absent, because ECMAScript `\s` already collapsed them —
* `\s` is TAB/VT/FF/SP/NBSP/ZWNBSP/Zs plus LF/CR/LS/PS, so no C1 code point is
* in it and the whole U+0080 to U+009F block reaches this rule intact. Those
* are not hypothetical input: they are what Windows-1252 bytes 0x80 to 0x9F
* (smart quotes, em dash) become when decoded as Latin-1.
* CPython rejects source containing a NUL outright
* (`SyntaxError: source code string cannot contain null bytes`), whether it
* sits in a docstring or in a comment, so one such byte anywhere in a schema
* description would make the whole generated SDK unparseable — under
* `mode: 'code'`, the model's only declaration of the tools. The rest are
* legal but invisible; escaping them with the same rule keeps the emitted text
* readable and the treatment uniform.
*
* The boundary is the category, not per-code-point addressability: `\xNN`
* addresses U+0000 to U+00FF, so one escape form covers `Cc` exactly. The
* invisible `Cf` formatting characters pass through by design — of them only
* U+00AD soft hyphen would fit `\xNN` at all, and escaping that one while
* U+200B ZWSP, U+200E/U+200F bidi marks, and U+2060 word joiner passed through
* would leave a rule that is neither category- nor addressability-shaped. The
* whole family is legal in both consumers, since only LF and CR terminate a
* Python string literal or a `#` comment. That set is the tokenizer's, not
* `str.splitlines()`': NEL (U+0085), LS (U+2028), and PS (U+2029) split a
* string at run time but do not end a physical line in source — measured on
* CPython 3.9.6 and 3.12.13, each accepted in both positions with the value
* round-tripping — so they are safe raw wherever they reach emitted text
* unescaped, which for all three is `JSON.stringify`, at two call sites:
* {@link pyScalar}'s literal path, and the subscript tool-name comment's own
* call, which a name carrying any of them always reaches, none being
* `XID_Continue`. The `description` path escapes NEL under the class above and
* folds LS and PS in {@link describe}'s `\s+` collapse, both being `\s`.
*/
const UNPRINTABLE = /[\u0000-\u0008\u000e-\u001f\u007f-\u009f]/g;
/**
* Unpaired surrogate code points, escaped by {@link describe} as `\uNNNN` —
* its own form, since `\xNN` stops at U+00FF. The `u` flag is what makes this
* the LONE ones: in Unicode mode a well-formed pair is a single astral code
* point outside D800 to DFFF, so an emoji in a description survives untouched.
*
* This is the NUL case from {@link UNPRINTABLE}, not the invisible-character
* case. Python source must be UTF-8-encodable and a lone surrogate is not, so
* `compile()` raises `UnicodeEncodeError: surrogates not allowed` for one
* anywhere in the text — measured on 3.9 for a string literal and for a `#`
* comment alike. A raw or MCP tool description reaches this: `JSON.parse` on a
* wire `"\ud800"` escape yields exactly such a code point.
*/
const LONE_SURROGATE = /[\ud800-\udfff]/gu;
/**
* The collapsed one-line `description` of a schema node (byte-stable across
* formatting churn), or `undefined` when the node carries none. Every caller
* passes an object — a validated property node, the `ToolSdkSchema` itself, or
* the `{ description }` wrapper {@link docLines} synthesizes — so only the
* description field needs guarding. A description that collapses
* to nothing (empty, or whitespace only) is `undefined` too: it documents the
* node no better than an absent one, and emitting it would leave an empty
* `"""` docstring or a bare `#   ` line in the SDK. Only ECMAScript whitespace
* folds, so a description of whitespace plus one surviving control character is
* NOT absent: it collapses to that character's visible escape.
*
* Control characters left over after the whitespace collapse are rendered as
* their `\xNN` escapes (see {@link UNPRINTABLE}) and unpaired surrogates as
* their `\uNNNN` escapes (see {@link LONE_SURROGATE}); the escape's own backslash is
* emitted literally by both consumers, since {@link docLines} doubles it into a
* Python source escape and a `#` comment carries it verbatim.
*/
function describe(schema) {
	const description = schema.description;
	if (typeof description !== "string") return void 0;
	const collapsed = description.replace(/\s+/g, " ").replace(UNPRINTABLE, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`).replace(LONE_SURROGATE, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).trim();
	return collapsed.length === 0 ? void 0 : collapsed;
}
/**
* One-line docstring for a tool `description`, or no lines when there is none.
* Backslashes are doubled first, every quote is escaped, and a trailing
* backslash cannot survive: a description ending in `"` or an odd backslash
* would otherwise merge with (or escape) the closing triple quote and make
* the generated block — Code Mode's only SDK — syntactically invalid Python.
*/
function docLines(description, indent) {
	const collapsed = describe({ description });
	if (collapsed === void 0) return [];
	const escaped = collapsed.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"");
	return [`${pad(indent)}"""${escaped}"""`];
}
/**
* CamelCase a name into a Python type identifier: non-identifier characters
* split words, `_` splits too (it is `XID_Continue`, so the split set names it
* explicitly), and a head that cannot start an identifier takes a `Tool`
* prefix. Unicode survives, so a `路径` field yields `路径`-based class names
* instead of collapsing to the bare prefix. A character that is not
* `XID_Continue` splits even when it is a letter, so a name whose NFKC folding
* would leave the identifier set is not carried through — the split set is the
* grammar's, not an ASCII approximation of it.
*
* The result is NFKC-normalized: these names are generated, never matched
* against a JSON key, so normalizing is free here and keeps what CPython
* compiles identical to what is emitted — unlike {@link isBareIdentifier},
* which must reject unstable names outright. Normalizing AFTER the prefix
* decision is what makes that hold at the seam the prefix creates: `Tool` +
* a combining-mark head composes there (`U+0301` gives `Tooĺ`, U+013A), so
* normalizing only the un-prefixed part would emit a name CPython compiles to
* a different symbol. The second call is idempotent on the un-prefixed arm.
*
* The split set, the head test, and `toUpperCase()` all read the engine's
* Unicode tables, so this function carries the same version skew
* {@link isBareIdentifier} documents, by paths independent of it: a class name
* derived here reaches emitted text whenever any object shape in the tool's
* schema declares a `TypedDict`, and the predicate's verdict on the tool name
* does not gate that. The case mapping is the one that can fail on a name the
* predicate accepted; the worked example is there.
* @param raw - the schema field or tool name to derive from.
* @returns a class-name segment safe to emit.
*/
function camelCase(raw) {
	const joined = raw.split(/[^\p{XID_Continue}]+|_+/u).filter((part) => part.length > 0).map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join("").normalize("NFKC");
	return (/^\p{XID_Start}/u.test(joined) ? joined : `Tool${joined}`).normalize("NFKC");
}
/** Class-name base cap keeping each emitted name — and total text — linear in schema depth. */
const MAX_CLASS_NAME_BASE = 120;
/**
* Deepest `list[…]` nesting emitted into one annotation before the item type
* degrades to `Any`. CPython's tokenizer rejects a logical line holding more
* than 200 simultaneously-open brackets (`MAXLEVEL`, `SyntaxError: too many
* nested parentheses`), so an array chain deeper than that would render an SDK
* block that is not valid Python at all — the same failure the docstring
* escaping in {@link docLines} exists to prevent. 180 leaves headroom for the
* few brackets an annotation can add around the chain, all of which count
* toward the same limit. Per emission site, counting brackets open at the
* chain's innermost point:
*
* - Return annotation, `async def f(self, args: X) -> chain:` — 180 `list[`
*   plus an innermost `Literal[`. The parameter list's `(` closed at the `)`
*   before the `->`, so it is NOT open here: 181.
* - TypedDict field, `field: NotRequired[chain]` — a class-body line with no
*   other open bracket, and its children start at `listDepth: 1` to reserve
*   the `NotRequired[`, so 179 `list[` plus `Literal[`: 181. Required fields
*   share that start for uniformity, spending one level of representable depth
*   on a bracket they never emit.
* - Argument annotation, `async def f(self, args: chain) -> Y:` — the `(` IS
*   still open around it: 180 `list[` plus `Literal[` plus the paren, 182, the
*   worst case. Reachable only through a raw `register()` whose `parameters`
*   is an array reached from the root through `oneOf` arms alone — the root
*   array itself, or one nested under any depth of unions, since an arm
*   inherits the enclosing depth unchanged (`A | B` opens no bracket). An
*   object ancestor takes it out of this case: its fields restart the chain at
*   the 181 site. `defineTool` compiles an object root, so the annotation is a
*   bare TypedDict class name or a one-bracket `dict[str, Any]` when that
*   object degrades — never a chain.
*
* A CPython grammar limit, not a deployment choice, so it is fixed rather than
* configurable. The sibling `ts-types` renderer needs no counterpart: nothing
* in the TypeScript grammar bounds nesting, and its SDK block is never type-
* checked. Only bracket nesting counts — a `oneOf` renders as a flat `A | B`
* chain and nested objects render as separate `class` statements, so neither
* accumulates open brackets at any depth. The invariant this cap serves is
* grammatical validity; see the `oneOf` arm in {@link renderType} for the one
* interpreter limit deliberately left uncapped.
*/
const MAX_LIST_NESTING = 180;
/**
* Cap a class-name base at {@link MAX_CLASS_NAME_BASE} (see the callers for
* why capping keeps the render linear). `slice` counts UTF-16 code units, so
* an astral character straddling the boundary would be cut in half and leave a
* lone surrogate — not an identifier character, and not even well-formed text;
* drop it rather than emit it.
*/
function capClassNameBase(base) {
	if (base.length <= MAX_CLASS_NAME_BASE) return base;
	const capped = base.slice(0, MAX_CLASS_NAME_BASE);
	return /[\uD800-\uDBFF]$/.test(capped) ? capped.slice(0, -1) : capped;
}
/**
* Reserve a unique class name from a base, suffixing `2`, `3`, … on collision.
* The base is capped at {@link MAX_CLASS_NAME_BASE} first: child class names
* derive from their parent's allocated name (`ParentChild`), so an unbounded
* schema of single-field objects would otherwise grow each name by one field
* per level and the sum of all names to Θ(depth²). Capping the base keeps each
* name — and the total emitted text — linear in depth. Collisions resume from
* the per-base counter in `state.nextClassCounter` rather than rescanning from
* `2`, so a deep chain sharing one capped base stays O(1) per allocation
* (amortized) instead of Θ(depth²) in time.
*/
function allocateClassName(base, state) {
	const capped = capClassNameBase(base);
	let name$1 = capped;
	if (state.usedClassNames.has(name$1)) {
		let n = state.nextClassCounter.get(capped) ?? 2;
		while (state.usedClassNames.has(`${capped}${n}`)) n++;
		name$1 = `${capped}${n}`;
		state.nextClassCounter.set(capped, n + 1);
	}
	state.usedClassNames.add(name$1);
	return name$1;
}
/**
* Append a child-name segment to a parent class-name base, capping the result
* at {@link MAX_CLASS_NAME_BASE}. Capping AT PROPAGATION (not only inside
* {@link allocateClassName}) keeps each level O(1): a deep `oneOf`- or
* object-chain would otherwise carry an ever-growing ConsString down the tree
* and re-materialize it (via `.length`/`.slice`) at every level — Θ(depth²).
* The bounded base plus the collision counter still yields unique names.
*
* The join is NFKC-normalized because both sides are separately normalized yet
* their concatenation need not be: a base ending in a Hangul L jamo or LV
* syllable composes with a following V or T jamo head (`가` + `ᆨ` gives `각`),
* so the emitted class name would differ from the symbol CPython compiles, and
* two byte-distinct names could fold onto one — `usedClassNames` dedupes by the
* raw bytes, so the collision counter would not see it. Normalizing costs
* O(cap + segment) per level, the same order as the `slice` it feeds. The other
* two join points need no counterpart: `Args`/`Output` start with `A`/`O` and
* {@link allocateClassName}'s suffix is digits, none of which compose backwards.
*/
function childClassName(base, segment) {
	return capClassNameBase(`${base}${segment}`.normalize("NFKC"));
}
/**
* Render one validated scalar as Python literal text (`True`/`False`,
* JSON-quoted strings, bare numbers). `null` cannot reach here: the `null`
* type renders directly as `None`, and the unified validator rejects a null
* `const`/`enum` entry on every other scalar type.
*
* A beyond-safe-range integral number takes `BigInt` digits rather than
* `String`: Python integers are arbitrary-precision, so the emitted digits ARE
* the value the model programs against, and `String` can give a different
* integer than the double holds (`2 ** 60` prints the rounded `...847000`, not
* the exact `...846976`) or no integer literal at all (`1e21` prints `1e+21`).
* `String`'s rounding is not a bug in it: `Number::toString` emits the shortest
* decimal string that re-reads to the same double, then pads to the exponent
* with zeros (1 significant digit for `1e20`, 16 for `2 ** 60`) — and when the
* shortest string is shorter than the double's exact value, those padded digits
* name an integer no double holds. Passing one back would have to cross the
* argument boundary as a JSON number — a double again — so the SDK would
* document a value no program can pass. `BigInt` needs no case split: where
* `String` is already exact (`2 ** 53`, `1e20`) the two agree byte for byte,
* and where it is not, `BigInt` is the exact one. The TS flavor needs no
* counterpart at all: its literal is re-read by a JS parser back into the same
* double.
*
* `JSON.stringify` is also what keeps this path's output parseable, and it is
* the only thing that does. It covers both classes of hazard: the two kinds of
* code point CPython refuses anywhere in source — NUL among the C0 controls,
* and the whole D800–DFFF unpaired-surrogate block, escaped under ES2019
* well-formed stringification, which the engines range guarantees — and the
* ones that break this line in particular, a bare `"` closing the literal
* early, a trailing odd backslash eating the closing quote, and a bare LF/CR
* ending it before its terminator. The `description` path carries
* {@link UNPRINTABLE} and {@link LONE_SURROGATE} because nothing quotes it,
* and folds newlines in {@link describe}.
*
* That leans on a coincidence worth naming: every escape `JSON.stringify` can
* emit (`\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, `\uXXXX`) is also a Python
* escape denoting the same character, so the emitted `Literal[...]` both
* parses and decodes back to the value the schema declared. DEL, the C1
* controls (NEL among them), and LS/PS (U+2028/U+2029) do reach it raw —
* legal but invisible, byte-for-byte as in the TS flavor; escaping them is a
* both-flavors change. Those last three are legal here for the reason
* {@link UNPRINTABLE} records: they are `str.splitlines()` boundaries, not
* tokenizer line terminators. The subscript tool-name comment quotes its name
* through its own call to the same `JSON.stringify`, never through this
* function, and inherits both halves — escapes and pass-throughs alike.
*/
function pyScalar(value) {
	if (value === true) return "True";
	if (value === false) return "False";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" && Number.isInteger(value) && !Number.isSafeInteger(value)) return BigInt(value).toString();
	return String(value);
}
/**
* Render a validated scalar `const`/`enum` as `Literal[...]`, falling back to
* the broad type. Deliberately deviates from PEP 586, which restricts `Literal`
* parameters to int/bool/str/bytes/enum/None: a non-integral number
* `const`/`enum` emits a float literal (`Literal[1.5]`) a strict checker would
* reject. An integral one does not deviate — {@link pyScalar} emits int digits,
* including for the beyond-safe-range values it widens through `BigInt`, and
* PEP 586 admits int parameters. Harmless either way — the stub is advisory
* prompt text, only required to parse — and keeping the exact value
* communicates the constraint to the model.
*/
function renderConstrainedScalar(node, broad, state) {
	if (node.const !== void 0) {
		state.typing.add("Literal");
		return `Literal[${pyScalar(node.const)}]`;
	}
	if (node.enum !== void 0) {
		state.typing.add("Literal");
		return `Literal[${node.enum.map(pyScalar).join(", ")}]`;
	}
	return broad;
}
/**
* Map one JSON-Schema node to a Python type expression, threading `state` to
* collect the `TypedDict` declarations and `typing` symbols a full render
* needs. `className` is the name to give an object node with properties (and
* the prefix for its nested objects). Handles every unified schema construct —
* `oneOf` (→ `X | Y`), `const`/`enum` (→ `Literal[...]`), `integer` (→ `int`),
* `null` (→ `None`) — and degrades an unsupported or malformed schema to `Any`
* without throwing, the same trusted-after-validation stance as the sibling
* {@link ./ts-types.ts | ts-types} renderer. {@link jsonSchemaToPy} is the
* context-free entry point; this is the collecting core.
*/
function renderType(schema, className, state) {
	const newFrame = (schema$1, className$1, listDepth) => ({
		schema: schema$1,
		className: className$1,
		phase: "start",
		listDepth,
		children: [],
		childIndex: 0,
		childTypes: [],
		entries: []
	});
	try {
		assertSupportedJsonSchema(schema);
		const frames = [newFrame(schema, className, 0)];
		let result;
		const finish = (type) => {
			frames.pop();
			const parent = frames.at(-1);
			if (parent === void 0) result = type;
			else parent.childTypes.push(type);
		};
		while (frames.length > 0) {
			const frame = frames.at(-1);
			/* v8 ignore next -- the loop condition guarantees a current frame. */
			if (frame === void 0) break;
			if (frame.phase === "children") {
				if (frame.childIndex < frame.children.length) {
					const child = frame.children[frame.childIndex];
					/* v8 ignore next -- childIndex is bounded by children.length. */
					if (child === void 0) throw new Error("missing python render child");
					frame.childIndex++;
					frames.push(newFrame(child.schema, child.className, child.listDepth));
					continue;
				}
				if (frame.kind === "oneOf") {
					let union = "";
					for (const [index, childType] of frame.childTypes.entries()) union = index === 0 ? childType : `${union} | ${childType}`;
					finish(union);
					continue;
				}
				if (frame.kind === "array") {
					/* v8 ignore next -- the ?? arm needs a childless array frame, which start never builds. */
					finish(`list[${frame.childTypes[0] ?? "Any"}]`);
					continue;
				}
				const node$1 = frame.node;
				const name$1 = frame.allocated;
				/* v8 ignore next -- typeddict frames always set node and allocated at start. */
				if (node$1 === void 0 || name$1 === void 0) throw new Error("missing typeddict frame state");
				const required = new Set(node$1.required);
				const lines = [`class ${name$1}(TypedDict):`];
				for (let index = 0; index < frame.entries.length; index++) {
					const entry = frame.entries[index];
					const fieldType = frame.childTypes[index];
					/* v8 ignore next -- entries and childTypes correspond one-to-one. */
					if (entry === void 0 || fieldType === void 0) throw new Error("missing typeddict field type");
					const [field, fieldSchema] = entry;
					const description = describe(fieldSchema);
					if (description !== void 0) lines.push(`${pad(1)}# ${description}`);
					if (required.has(field)) lines.push(`${pad(1)}${field}: ${fieldType}`);
					else {
						state.typing.add("NotRequired");
						lines.push(`${pad(1)}${field}: NotRequired[${fieldType}]`);
					}
				}
				if (node$1.additionalProperties !== false) lines.push(`${pad(1)}# Additional keys beyond those declared are allowed.`);
				if (lines.length === 1) lines.push(`${pad(1)}pass`);
				state.classes.push(lines.join("\n"));
				finish(name$1);
				continue;
			}
			frame.phase = "children";
			const node = frame.schema;
			if (node.oneOf !== void 0) {
				frame.kind = "oneOf";
				frame.children = node.oneOf.map((branch, index) => ({
					schema: branch,
					className: childClassName(frame.className, `${index + 1}`),
					listDepth: frame.listDepth
				}));
				continue;
			}
			if (node.type === void 0) {
				state.typing.add("Any");
				finish("Any");
				continue;
			}
			switch (node.type) {
				case "string":
					finish(renderConstrainedScalar(node, "str", state));
					break;
				case "number":
					finish(renderConstrainedScalar(node, "float", state));
					break;
				case "integer":
					finish(renderConstrainedScalar(node, "int", state));
					break;
				case "boolean":
					finish(renderConstrainedScalar(node, "bool", state));
					break;
				case "null":
					finish("None");
					break;
				case "array":
					if (node.items === void 0) {
						state.typing.add("Any");
						finish("list[Any]");
						break;
					}
					if (frame.listDepth >= MAX_LIST_NESTING) {
						state.typing.add("Any");
						finish("Any");
						break;
					}
					frame.kind = "array";
					frame.children = [{
						schema: node.items,
						className: frame.className,
						listDepth: frame.listDepth + 1
					}];
					break;
				case "object": {
					const entries = Object.entries(node.properties ?? {});
					if (className === "" || !entries.every(([name$1]) => isBareIdentifier(name$1) && !RESERVED.has(name$1) && !(name$1.startsWith("__") && !name$1.endsWith("__")))) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					if (entries.length === 0 && node.additionalProperties !== false) {
						state.typing.add("Any");
						finish("dict[str, Any]");
						break;
					}
					frame.kind = "typeddict";
					frame.node = node;
					frame.allocated = allocateClassName(frame.className, state);
					state.typing.add("TypedDict");
					frame.entries = entries;
					/* v8 ignore next -- allocated is always set before children are built. */
					frame.children = entries.map(([field, child]) => ({
						schema: child,
						className: childClassName(frame.allocated ?? "", camelCase(field)),
						listDepth: 1
					}));
					break;
				}
				default:
					state.typing.add("Any");
					finish("Any");
			}
		}
		/* v8 ignore next -- every root frame produces one expression. */
		return result ?? "Any";
	} catch {
		state.typing.add("Any");
		return "Any";
	}
}
/** The fixed model-facing usage contract rendered above the declarations. */
const SDK_INSTRUCTIONS = `## Writing code for run_code

\`run_code\` takes two required arguments: \`code\` — the body of an async Python function (top-level \`await\` and \`return\` both work) — and \`description\`, a short summary of what the program does. At run time exactly two of the names declared below are bound: \`tools\` and \`ToolCallError\`. Everything else is a STATIC STUB describing argument and return types — in particular the \`TypedDict\` classes do NOT exist at run time, so build arguments as plain \`dict\`/\`list\` JSON values: \`await tools.name({"field": 1})\`, never \`FooArgs(field=1)\`, which raises \`NameError\`. Inside the program:

- Call tools as \`await tools.name(args)\` — subscript access for exotic, reserved, or underscore-leading names: \`await tools["my-tool"](args)\`. Every call resolves to the tool's typed canonical JSON value (each method's return type below). Tool arguments must be lossless JSON.
- A FAILED tool call raises \`ToolCallError\`, whose \`toolName\` identifies the failed tool and whose message is human-readable — wrap in \`try/except\` to handle and continue.
- Independent read-only calls MAY overlap under \`asyncio.gather\` (safe calls run concurrently; mutating calls run alone, in submission order). Sequence dependent work with \`await\`.
- Emit the run's answer with \`print(...)\` and/or a top-level \`return <value>\`; the returned value must be lossless JSON. ONLY what you print and the returned value come back — intermediate tool results never enter the conversation, so extract just what you need.

The available tools:`;
/**
* Render the full `tools:sdk` prompt section under `runtime.language ===
* 'python'`: the Python-flavored usage instructions plus one named `TypedDict`
* per tool argument or output object (and per nested object) and one awaitable
* method per visible tool on a `Tools` protocol — typed args in, the tool's
* canonical output value out — with a `tools: Tools` singleton the model calls
* into. The `typing` import line lists exactly the symbols the render used.
* Deterministic — tools are emitted in lexicographic name order, and class
* declarations precede the protocol in that same order (nested classes before
* the parent that references them), so an unchanged tool set produces
* byte-identical text across assemblies. The sort is not a total order on
* byte-equal names, so two schemas sharing a name would render in argument
* order; the caller's visible-capability map is keyed by name, so the input
* never carries a duplicate.
* @param schemas - the tool schemas plus canonical output schemas to declare
*   (the caller excludes `run_code` itself).
* @returns the complete section text.
*/
function renderToolsSdkPy(schemas) {
	const sorted = [...schemas].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	const state = {
		classes: [],
		usedClassNames: /* @__PURE__ */ new Set(),
		nextClassCounter: /* @__PURE__ */ new Map(),
		typing: new Set(["Protocol"])
	};
	const members = [];
	let statements = 0;
	for (const schema of sorted) {
		const argType = renderType(schema.parameters, `${camelCase(schema.name)}Args`, state);
		const outputType = renderType(schema.output, `${camelCase(schema.name)}Output`, state);
		if (isBareIdentifier(schema.name) && !RESERVED.has(schema.name) && !schema.name.startsWith("_")) {
			const doc = docLines(schema.description, 2);
			members.push(doc.length > 0 ? `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}:` : `${pad(1)}async def ${schema.name}(self, args: ${argType}) -> ${outputType}: ...`);
			members.push(...doc);
			statements += 1;
		} else {
			members.push(`${pad(1)}# tools[${JSON.stringify(schema.name)}](args: ${argType}) -> ${outputType}`);
			const description = describe(schema);
			if (description !== void 0) members.push(`${pad(1)}#   ${description}`);
		}
	}
	const body = (statements > 0 ? members : [`${pad(1)}pass`, ...members]).join("\n");
	const imports = TYPING_ORDER.filter((symbol) => state.typing.has(symbol));
	const classBlock = state.classes.length > 0 ? `${state.classes.join("\n\n")}\n\n` : "";
	return `${SDK_INSTRUCTIONS}\n\n\`\`\`python\n${`from typing import ${imports.join(", ")}\n\nclass ToolCallError(Exception):
    toolName: str\n\n${classBlock}class Tools(Protocol):\n${body}\n\ntools: Tools`}\n\`\`\``;
}
/**
* Tool registry, model presentation modes, and pre/guard/around/post/result
* execution pipeline.
* @module @deepseek-ai/dsh-tools
*/
/**
* Language → SDK-section renderer. The registry looks up the loaded
* `ctx.codeRuntime.language` in this table when assembling the `tools:sdk`
* section under a non-native mode; a runtime whose language is not a key
* fails the assembly loudly (same idiom as `toolOrder` violations). Adding a
* new backend language is three parallel edits — a {@link CodeSdkLanguage}
* member, an entry here, and a `RUN_CODE_FLAVORS` entry in `code-mode.ts` for
* its `run_code` schema strings — plus the renderer function this table points
* at. The `satisfies` clause pins this table's key set to that union, which
* the flavor table is checked against too, so any of the three left out is a
* typecheck failure. What no check reaches is the prose that names the values
* instead of deriving them: the seam's `dsh-code-runtime` README pair, its
* `CodeRuntime.language` JSDoc, and `docs/subsystems/code-runtime.md`
* with its zh pair, plus this package's own README pair and the
* {@link Config.mode} JSDoc.
*/
/**
* Prompt order of the `code` collapse statement: after the persona and before
* the 100-199 per-tool guidance band, so the model reads which tools it may
* call before it reads what each one is for.
*/
const COLLAPSE_SECTION_ORDER = 99;
/**
* The model-facing statement of the `code` collapse. Names the consequence
* (the call fails) and the route (inside the program), because a rule the
* model can only discover by being denied is one it corrects too late.
*/
const CODE_ONLY_INSTRUCTION = `\`${RUN_CODE_NAME}\` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program.`;
const SDK_RENDERERS = {
	typescript: renderToolsSdk,
	python: renderToolsSdkPy
};
/**
* Scheduler entry point omitted from the generated named service API.
* @internal
*/
const TOOL_RUNTIME_SCHEDULER = Symbol("@deepseek-ai/dsh-tools.scheduler");
/** Canonical error code for cancellation after a tool body was invoked. */
const TOOL_ABORTED = "ABORTED";
/** Canonical error code for cancellation before a tool body was invoked. */
const TOOL_ABORTED_BEFORE_DISPATCH = "ABORTED_BEFORE_DISPATCH";
/**
* Thrown (internally) when the model requests a tool that isn't registered.
* Extends {@link HarnessError} (`code: 'UNKNOWN_TOOL'`) so an unknown-tool
* failure is as routable as a tool-thrown one — retry/sandbox/replay code can
* distinguish it from a tool body's own error.
*/
var ToolNotFoundError = class extends HarnessError {
	/**
	* @param toolName - the name the caller asked for.
	* @param reachableFrom - how the model reaches this tool instead, when the
	*   name IS visible and only the presentation denies calling it directly.
	*   Omitted for a name that is registered nowhere.
	*/
	constructor(toolName, reachableFrom) {
		super(reachableFrom === void 0 ? `unknown tool "${toolName}"` : `unknown tool "${toolName}": ${reachableFrom}`, "UNKNOWN_TOOL");
		this.name = "ToolNotFoundError";
	}
};
/** Thrown when a tool body or post-policy value violates its declared output. */
var ToolOutputError = class extends HarnessError {
	/** Schema/value violations in validation order. */
	violations;
	constructor(toolName, violations) {
		super(`tool "${toolName}" returned invalid output: ${violations.join("; ")}`, "INVALID_TOOL_OUTPUT");
		this.name = "ToolOutputError";
		this.violations = violations;
	}
};
/** Convert one projector exception into the canonical invalid-output failure. */
function projectionError(toolName, projector, error) {
	return new ToolOutputError(toolName, [`output.${projector} failed: ${errorMessage(error)}`]);
}
/** Snapshot one projector result before later durable-result materialization. */
function snapshotProjection(toolName, projector, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, [`output.${projector} returned non-lossless JSON`]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw projectionError(toolName, projector, error);
	}
}
/** Snapshot one body or policy value into the canonical invalid-output failure class. */
function snapshotToolValue(toolName, candidate) {
	try {
		const detached = snapshotJsonValue(candidate);
		if (detached === void 0) throw new ToolOutputError(toolName, ["value is not lossless JSON"]);
		return detached;
	} catch (error) {
		if (error instanceof ToolOutputError) throw error;
		throw new ToolOutputError(toolName, [`value snapshot failed: ${errorMessage(error)}`]);
	}
}
/**
* Best-effort human-readable message from an arbitrary thrown value: Error
* instances use `.message`; non-Error objects with a string `message`
* property (e.g. `throw { message: 'denied' }`) use it too; everything else
* is stringified.
*/
function errorMessage(error) {
	try {
		if (error instanceof Error) return error.message;
		if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string") return error.message;
		return String(error);
	} catch {
		return "<unprintable thrown value>";
	}
}
/** Derive one failure message from policy feedback without changing its rendered blocks. */
function failureMessageFromContent(content) {
	const text = content.map((block) => block.type === "text" ? block.text : `[${block.type} content]`).join("\n");
	return text.length > 0 ? text : "tool result blocked by post-execute policy";
}
/** Snapshot and freeze one durable tool-result projection or reject lossy data. */
function materializePresentation(candidate) {
	const detached = snapshotJsonValue(candidate);
	if (detached === void 0) throw new TypeError("tool result must be losslessly JSON-serializable");
	return deepFreeze(detached);
}
/** Structured `{ name, code }` for a thrown HarnessError, else undefined. */
function errorInfo(error) {
	try {
		return error instanceof HarnessError ? {
			name: error.name,
			code: error.code
		} : void 0;
	} catch {
		return;
	}
}
/** One scope's complete tool-registry contribution. */
var ToolLayer = class {
	tools;
	restrictions = new AnonymousEntries();
	guards = new AnonymousEntries();
	/**
	* Presentation this scope's agent declared for itself, shadowing the
	* deployment default. One cell rather than an entry table: two answers to
	* "which form does the model see" is a contradiction, not a merge.
	*/
	mode;
	constructor(scope) {
		this.tools = new NamedEntries((name$1) => /* @__PURE__ */ new Error(scope === void 0 ? `tool "${name$1}" is already registered (for a per-agent variant, register through that agent's \`agent.ctx\` instead)` : `tool "${name$1}" is already registered in this scope`));
	}
	/** Whether every contribution table in this aggregate layer is empty. */
	isEmpty() {
		return this.tools.isEmpty() && this.restrictions.isEmpty() && this.guards.isEmpty() && this.mode === void 0;
	}
	/** Whether every compiled restriction in this layer admits a global tool name. */
	admits(name$1) {
		for (const filter of this.restrictions.values()) if (filter.allow !== void 0 && !filter.allow.has(name$1) || filter.deny !== void 0 && filter.deny.has(name$1)) return false;
		return true;
	}
	/** First monotonic denial from this layer's live guard registrations. */
	guardReason(exec) {
		for (const guard of this.guards.values()) {
			const reason = guard(exec);
			if (reason !== void 0) return reason;
		}
	}
};
/** Resolve the run_code overlap cap at the owning config boundary (direct construction bypasses the Loader schema). */
function resolveMaxParallelSubCalls(value) {
	const maxParallelSubCalls = value ?? 10;
	if (!Number.isInteger(maxParallelSubCalls) || maxParallelSubCalls < 1) throw new Error("maxParallelSubCalls must be a positive integer");
	return maxParallelSubCalls;
}
/**
* Tool registry and execution pipeline. Scoped registrations shadow globals;
* one visibility resolver feeds presentation, lookup, and dispatch.
*/
var ToolRuntime = class extends Service {
	static inject = ["systemPrompt"];
	static Config = z.object({
		mode: z.union([
			"native",
			"code",
			"both"
		]).default("native"),
		maxParallelSubCalls: z.natural().min(1).default(10)
	});
	/** Internal staged view consumed by `dsh-agent-loop`'s parallel scheduler. */
	[TOOL_RUNTIME_SCHEDULER] = {
		prepare: (exec) => this.prepareScheduledExecution(exec),
		dispatch: (exec) => this.dispatchScheduledExecution(exec),
		finalize: (exec, result) => this.finalizeScheduledExecution(exec, result),
		finish: (exec, result) => this.finishScheduledExecution(exec, result)
	};
	/** Context deferred by a running tool body, keyed by its scheduler-owned execution. */
	deferredContexts = /* @__PURE__ */ new WeakMap();
	/** Executions whose tool body declared the current turn complete. */
	concludingExecutions = /* @__PURE__ */ new WeakSet();
	/** Original caller cancellation, kept outside the wrapper-mutable execution object. */
	cancellationStates = /* @__PURE__ */ new WeakMap();
	/** Definition-owned final content transform snapshotted before policy begins. */
	contentFinalizers = /* @__PURE__ */ new WeakMap();
	layers = new ScopedLayers((scope) => new ToolLayer(scope), () => {
		this.ctx.emit("tools/change");
	});
	/** Presentation for scopes that declare none; {@link presentAs} shadows it per scope. */
	defaultMode;
	maxParallelSubCalls;
	/**
	* Reserved presentation transport, kept outside the filterable registration
	* layers. Built on first need rather than at construction: which agents run
	* a code mode is no longer known when the service is constructed, and the
	* transport is stateless beyond its closures over `this`.
	*/
	codeTransport;
	constructor(ctx, config = {}) {
		super(ctx, "tools");
		this.defaultMode = config.mode ?? "native";
		this.maxParallelSubCalls = resolveMaxParallelSubCalls(config.maxParallelSubCalls);
		ctx.systemPrompt.tools((context) => this.wireSchemas(context.scope));
		if (this.defaultMode !== "native") {
			ctx.systemPrompt.section(this.collapseSection());
			ctx.systemPrompt.section(this.sdkSection());
		}
	}
	/**
	* The prompt statement of the `code` executor collapse, registered wherever
	* {@link sdkSection} is and rendering empty outside an effective `code`.
	*
	* Every tool contributes its own guidance section naming its tool, none of
	* them qualify how that tool is reached, and they all render before the SDK
	* (orders 100-199 against {@link SDK_SECTION_ORDER}). Without this the model
	* reads a catalog of tools it is told to use and no statement that only
	* `run_code` may be called, so it emits a native call, receives
	* `UNKNOWN_TOOL` for a tool the prompt just declared, and concludes the
	* deployment is inconsistent. {@link COLLAPSE_SECTION_ORDER} places the rule
	* before that guidance rather than after it.
	*
	* `both` renders empty: native calls do execute there, so the rule is false.
	* @returns the section registration.
	*/
	collapseSection() {
		return {
			name: "tools:code-only",
			order: COLLAPSE_SECTION_ORDER,
			text: (context) => this.modeFor(context.scope) === "code" ? CODE_ONLY_INSTRUCTION : ""
		};
	}
	/**
	* The generated-SDK prompt section, registered globally by a code-mode
	* deployment and per scope by {@link presentAs}.
	*
	* The body regenerates from the CALLING scope, and renders empty for an
	* agent presenting natively — an agent that opted out under a code-mode
	* deployment still sees the global registration, and an empty section is
	* dropped from the rendered prompt.
	* @returns the section registration.
	*/
	sdkSection() {
		return {
			name: "tools:sdk",
			order: 150,
			text: (context) => {
				const mode = this.modeFor(context.scope);
				if (mode === "native") return "";
				const runtime = this.requireCodeRuntime(mode);
				const render = SDK_RENDERERS[runtime.language];
				/* v8 ignore next -- requireCodeRuntime rejects an unknown language before this runs. */
				if (render === void 0) throw new Error(`dsh-tools: no SDK renderer for ${runtime.language}`);
				return render(this.sdkSchemas(context.scope));
			}
		};
	}
	/**
	* The presentation one scope's agent sees: its own declaration, else the
	* deployment default.
	* @param scope - the calling agent, or undefined for the global view.
	* @returns the resolved presentation mode.
	*/
	modeFor(scope) {
		const layers = this.layers.chainLayers(scope);
		for (let index = layers.length - 1; index >= 0; index -= 1) {
			const mode = layers[index]?.mode;
			if (mode !== void 0) return mode;
		}
		return this.defaultMode;
	}
	/**
	* The reserved `run_code` transport, built on first need.
	*
	* It never enters the global layer: per-agent restrictions must not remove
	* it, and a scoped registration must not shadow it. The visibility resolver
	* appends it after resolving the filterable global/scoped capability layers,
	* and only for scopes whose mode actually presents it.
	* @returns the shared transport definition.
	*/
	requireCodeTransport() {
		this.codeTransport ??= createRunCodeTool(this, {
			requireRuntime: () => this.requireCodeRuntime(this.defaultMode),
			peekRuntime: () => this.ctx.get("codeRuntime"),
			maxParallel: this.maxParallelSubCalls,
			shapeDispatchLog: (dispatch) => this.shapeDispatchLog(dispatch)
		});
		return this.codeTransport;
	}
	/**
	* Present the calling scope's tools in `mode` instead of the deployment
	* default. Nearest scope on the chain wins, so a preset's standing
	* declaration covers every agent joined under it.
	*
	* Scoped only, and one declaration per scope: this is how an agent preset
	* composes Code Mode agents beside native ones in the same process, and a
	* process-global override would be the `mode` config field instead.
	* @param mode - the presentation the covered agents' models see.
	* @returns the exact disposer that restores the deployment default.
	*/
	presentAs(mode) {
		const ctx = this.ctx;
		if (scopeOf(ctx) === void 0) throw new Error("tools.presentAs() requires a scoped context (agent.ctx): a context-global presentation is the `mode` config field on the tools row");
		return ctx.effect(function* () {
			yield this.layers.effect(ctx, (layer) => {
				if (layer.mode !== void 0) throw new Error(`tools.presentAs("${mode}") conflicts with "${layer.mode}" already declared for this scope; one composition selects one presentation`);
				layer.mode = mode;
				return () => {
					layer.mode = void 0;
				};
			}, { label: "tools.presentAs()" });
			if (mode !== "native") {
				yield ctx.systemPrompt.section(this.collapseSection());
				yield ctx.systemPrompt.section(this.sdkSection());
			}
		}.bind(this), "tools.presentAs()");
	}
	/**
	* Build one scope's wire schemas and names for prompt-order validation.
	* Restrictions do not make known tools invalid, but a mode collapse does.
	*/
	wireSchemas(scope) {
		const view = this.view(scope);
		const mode = this.modeFor(scope);
		if (mode === "native") return {
			schemas: [...view.visible.values()].map((definition) => this.schemaOf(definition, false)),
			knownNames: [...view.knownNames]
		};
		this.requireCodeRuntime(mode);
		const schemas = [...view.visible.values()].map((definition) => this.schemaOf(definition, false));
		if (mode === "code") return {
			schemas: schemas.filter((schema) => schema.name === RUN_CODE_NAME),
			knownNames: [RUN_CODE_NAME]
		};
		return {
			schemas,
			knownNames: [...view.knownNames, RUN_CODE_NAME]
		};
	}
	/**
	* Resolve the code runtime or throw the actionable misconfiguration error.
	* Read at use time (assembly / run_code execution), NOT via static
	* `inject`: an inject entry would hold `ctx.tools` — and every tool plugin
	* behind it — hostage to a code runtime existing even under `mode:
	* 'native'` (the loop's optional-backend idiom, same as
	* `sessionPersistence`).
	*
	* Assembly and `run_code` execution read separately, so the language is not
	* bound to a request. Harmless while one published backend exists — both
	* reads return the same flavor — but a reload that swapped in a second
	* language between them would hand a program written against one SDK to the
	* other. Binding it is deferred until a second backend ships (the first
	* point it is testable); rationale in the
	* [language-dispatch note](../../../../.agents/notes/implemented/feature/2026-07-31-code-mode-language-dispatch.md).
	*/
	requireCodeRuntime(mode) {
		const runtime = this.ctx.get("codeRuntime");
		if (!runtime) throw new Error(`dsh-tools: mode "${mode}" requires a code runtime — load a ctx.codeRuntime implementation (e.g. @deepseek-ai/dsh-code-runtime-worker-thread) or set tools mode to "native"`);
		if (!Object.hasOwn(SDK_RENDERERS, runtime.language)) {
			const known = Object.keys(SDK_RENDERERS).map((name$1) => JSON.stringify(name$1)).join(", ");
			throw new Error(`dsh-tools: no SDK renderer registered for runtime language ${JSON.stringify(runtime.language)} (known: ${known})`);
		}
		return runtime;
	}
	/**
	* Register globally or in the calling agent scope. Scoped tools shadow
	* globals; duplicates within one layer and the reserved `run_code` name fail.
	* @param definition - tool schema, execution, and optional finalization/presentation callbacks.
	* @returns the exact disposer that unregisters the tool.
	*/
	register(definition) {
		const name$1 = definition.name;
		const output = definition.output;
		if (output === void 0 || typeof output !== "object" || typeof output.render !== "function" || output.presentationMeta !== void 0 && typeof output.presentationMeta !== "function") throw new TypeError(`tool "${name$1}" must declare output { schema, render, presentationMeta? }`);
		assertSupportedJsonSchema(output.schema);
		const timeoutMs = definition.timeoutMs;
		if (timeoutMs !== void 0 && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) throw new TypeError(`tool "${name$1}" timeoutMs must be a positive finite number`);
		if (name$1 === "run_code") throw new Error(`tool name "${RUN_CODE_NAME}" is reserved for the Code Mode presentation transport and cannot be registered or shadowed`);
		return this.layers.effect(this.ctx, (layer) => layer.tools.insert(name$1, definition), { label: "tools.register()" });
	}
	/**
	* Restrict global tools for the calling agent scope. Empty filters, unknown
	* names, scope-local names, and reserved transport names fail. Restrictions
	* intersect; scoped registrations remain visible.
	* @param filter - global-tool mask: `allow` (keep only) and/or `deny` (remove).
	* @returns the exact disposer that lifts this restriction.
	*/
	restrict(filter) {
		const scope = scopeOf(this.ctx);
		if (scope === void 0) throw new Error("tools.restrict() requires a scoped context (agent.ctx): a context-global restriction would mask every agent — deny the tool for the intended agent instead");
		const allow = filter.allow;
		const deny = filter.deny;
		if (allow === void 0 && deny === void 0) throw new Error("tools.restrict({}) is a no-op: pass `allow` and/or `deny` (an empty filter is almost always a materialized-empty-config bug)");
		const compiled = {
			...allow !== void 0 ? { allow: new Set(allow) } : {},
			...deny !== void 0 ? { deny: new Set(deny) } : {}
		};
		if ([...allow ?? [], ...deny ?? []].includes("run_code")) throw new Error(`tools.restrict() cannot name reserved Code Mode presentation transport "${RUN_CODE_NAME}"; restrict end-capability tools instead`);
		const known = this.view(scope).restrictableNames;
		const unknown = [...allow ?? [], ...deny ?? []].filter((name$1) => !known.has(name$1));
		if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}; known global tools: ${[...known].sort().join(", ") || "(none)"}`);
		return this.layers.effect(this.ctx, (layer) => layer.restrictions.append(compiled), { label: "tools.restrict()" });
	}
	/**
	* Register a monotonic guard after the extensible `tools/pre-execute`
	* waterfall. A plain-context guard applies globally; one registered through
	* `agent.ctx` applies only to that agent. Any matching guard may deny by
	* returning a reason, while no guard can force-allow a call another guard
	* denied. The exact effect disposer is returned for ordered ownership and
	* HMR cleanup.
	* @param guard - synchronous check; a returned string denies the execution.
	* @returns the exact disposer that unregisters the guard.
	*/
	guard(guard) {
		return this.layers.effect(this.ctx, (layer) => layer.guards.append(guard), {
			label: "tools.guard()",
			notify: false
		});
	}
	/** First monotonic denial from the global then the scope chain's guard layers, farthest first. */
	guardReason(exec) {
		const globalReason = this.layers.global.guardReason(exec);
		if (globalReason !== void 0) return globalReason;
		if (exec.agent === void 0) return void 0;
		for (const layer of this.layers.chainLayers(exec.agent)) {
			const reason = layer.guardReason(exec);
			if (reason !== void 0) return reason;
		}
	}
	/**
	* Resolve every registry fact one scope needs in one layer traversal. The
	* visible map applies restrictions to the INHERITED surface, then the
	* scope's own registrations and the reserved presentation transport; the
	* other sets retain the pre-restriction facts needed by restriction and
	* prompt-order validation.
	*
	* A restriction filters what a scope inherits — the global layer and every
	* ancestor layer on its chain — and never what its OWN layer registers.
	* That exemption is what a per-child capability filter has to keep intact:
	* the delegation runtime registers a child's reporting and structured-output
	* tools into the child's own layer, and a filter naming the capabilities the
	* child may use must not strip the machinery it answers through.
	*
	* Reading the exempt set as "the global layer" instead of "not mine" held
	* only while every model-facing tool sat in the host composition. Once
	* presets moved them onto the agent plane they became an ANCESTOR
	* contribution, so a child's filter silently stopped constraining anything
	* it was given.
	* @param scope - the viewing scope (the agent), or undefined for the global view.
	* @returns the complete derived view for that scope.
	*/
	view(scope) {
		const layers = this.layers.chainLayers(scope);
		const own$1 = this.layers.peek(scope);
		const inherited = new Map(this.layers.global.tools.entries());
		for (const layer of layers) {
			if (layer === own$1) continue;
			for (const [name$1, definition] of layer.tools.entries()) inherited.set(name$1, definition);
		}
		const visible = /* @__PURE__ */ new Map();
		const knownNames = /* @__PURE__ */ new Set();
		const restrictableNames = /* @__PURE__ */ new Set();
		for (const [name$1, definition] of inherited) {
			knownNames.add(name$1);
			restrictableNames.add(name$1);
			if (layers.every((layer) => layer.admits(name$1))) visible.set(name$1, definition);
		}
		if (own$1 !== void 0) for (const [name$1, definition] of own$1.tools.entries()) {
			knownNames.add(name$1);
			visible.set(name$1, definition);
		}
		if (this.modeFor(scope) !== "native") visible.set(RUN_CODE_NAME, this.requireCodeTransport());
		return {
			visible,
			knownNames,
			restrictableNames
		};
	}
	/**
	* Look up a tool as one scope sees it (scoped
	* shadows global; a restricted-away global reads as absent). Presenters pass
	* the calling agent so the rendered card matches the definition that
	* actually executed.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns the definition the scope resolves, or undefined when none is visible.
	*/
	get(name$1, scope) {
		return this.view(scope).visible.get(name$1);
	}
	/**
	* Resolve the definition that MAY EXECUTE for a call, applying the mode
	* collapse at the operation boundary that owns it. The registry view
	* (`get`) is presentation-agnostic; here a MODEL-DIRECT call under `code`
	* may only name the reserved `run_code` transport, while a nested
	* sub-dispatch (a `parent` token set — the `run_code` SDK calling a tool
	* it bound) may call any visible tool. Denial surfaces as `UNKNOWN_TOOL`
	* through the executor, matching an absent definition.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	* @returns the definition that may run, or undefined when the call must be rejected.
	*/
	resolveExecution(name$1, scope, nested) {
		const tool = this.get(name$1, scope);
		if (tool === void 0) return void 0;
		if (this.collapses(name$1, scope, nested)) return void 0;
		return tool;
	}
	/**
	* Project visible definitions onto the allowlisted model-facing schema fields,
	* excluding execution and presentation callbacks.
	* @param scope - the viewing scope (the agent); omitted = the global view.
	* @returns one deep-cloned schema per visible tool.
	*/
	schemas(scope) {
		return [...this.view(scope).visible.values()].map((definition) => this.schemaOf(definition, true));
	}
	/** Project visible callable tools onto the generated Code Mode SDK contract. */
	sdkSchemas(scope) {
		return [...this.view(scope).visible.values()].filter((definition) => definition.name !== RUN_CODE_NAME).map((definition) => {
			const output = snapshotJsonValue(definition.output.schema);
			/* v8 ignore next -- registration already validated and retained this schema as lossless JSON. */
			if (output === void 0) throw new Error(`tool "${definition.name}" output schema must be lossless JSON before SDK projection`);
			return {
				...this.schemaOf(definition, true),
				output
			};
		});
	}
	/** Project one definition onto the model-facing schema fields. */
	schemaOf(definition, detachParameters) {
		const { name: name$1, description, parameters } = definition;
		const detached = detachParameters ? snapshotJsonValue(parameters) : parameters;
		if (detached === void 0) throw new Error(`tool "${name$1}" parameters must be lossless JSON before schema projection`);
		return {
			name: name$1,
			description,
			parameters: detached
		};
	}
	/**
	* Classify a pending call through the caller's visible tool definition. Only
	* an exact `true` is parallel; unknown, hidden, undeclared, invalid, or
	* throwing classifiers are exclusive.
	* @param exec - call name, parsed arguments, and optional agent scope.
	* @returns the fail-closed scheduling mode.
	*/
	executionMode(exec) {
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (!tool?.isConcurrencySafe) return { kind: "exclusive" };
		try {
			return tool.isConcurrencySafe(exec.arguments) === true ? { kind: "parallel" } : { kind: "exclusive" };
		} catch {
			return { kind: "exclusive" };
		}
	}
	/**
	* Run the `tools/code-dispatch-log` waterfall over one settled sub-dispatch
	* and return the content the bridge should log on `tool/code-dispatch`.
	* Contained: when a listener throws, the method logs the original settled
	* content; that failure must not fail the dispatch or omit the settle event. Private:
	* the ONE consumer is the `run_code` bridge this registry constructs, which
	* receives it as a capability parameter (the `requireRuntime` idiom) — the
	* waterfall, not this invoker, is the public extension point.
	*/
	async shapeDispatchLog(dispatch) {
		try {
			return await this.ctx.waterfall(scopeTarget(this, dispatch.agent), "tools/code-dispatch-log", dispatch, () => Promise.resolve(dispatch.content));
		} catch (error) {
			this.ctx.logger.warn(`tools: code-dispatch-log listener failed for ${dispatch.name}: ${errorMessage(error)}; logging the original settled content`);
			return dispatch.content;
		}
	}
	/**
	* Whether the `code` mode collapse denies a model-direct call: only the
	* reserved `run_code` transport may be named. Nested sub-dispatches (a
	* `parent` token set) bypass the collapse. One home for the
	* security-relevant predicate, shared by {@link resolveExecution} and
	* {@link createExecution} so the two can never drift apart.
	*
	* Resolved through {@link modeFor}, NOT `defaultMode`: an agent given `code`
	* by an agent preset under a native deployment is the composition
	* `dsh-agent-tool-presentation` exists for, and reading the deployment default would
	* leave exactly that agent uncollapsed — announcing one surface while
	* executing another, which is the bypass this collapse closes.
	* @param name - the tool name as registered.
	* @param scope - the viewing scope whose effective presentation mode applies.
	* @param nested - whether the call is a transport sub-dispatch, not a model-direct call.
	*/
	collapses(name$1, scope, nested) {
		return !nested && this.modeFor(scope) === "code" && name$1 !== "run_code";
	}
	/**
	* Execute through pre-policy, guards, around-dispatch, post-policy,
	* definition-owned content finalization, and final notification. Tool and
	* listener failures resolve as materialized error results; an invisible tool
	* reports `UNKNOWN_TOOL`. The returned outcome is the same lossless, frozen
	* snapshot final observers receive. Cancellation
	* arriving after entry and before final result materialization skips a
	* not-yet-started body with `ABORTED_BEFORE_DISPATCH` or replaces a
	* successful started outcome with `ABORTED`; already-started work is still
	* drained and may retain a tool-owned structured error.
	* @param exec - the typed same-process call input. The registry assigns its
	*   correlation token before policy begins.
	* @returns the materialized final result.
	*/
	async execute(exec) {
		return this.prepareExecution(exec, (prepared) => this.completeScheduledExecution(prepared));
	}
	async completeScheduledExecution(prepared) {
		switch (prepared.kind) {
			case "dispatch": {
				const dispatched = await this.dispatchScheduledExecution(prepared.exec);
				return dispatched.kind === "post-result" ? await this.finalizeScheduledExecution(prepared.exec, dispatched.result) : this.finishScheduledExecution(prepared.exec, dispatched.result);
			}
			case "post-result": return await this.finalizeScheduledExecution(prepared.exec, prepared.result);
			case "final-result": return this.finishScheduledExecution(prepared.exec, prepared.result);
			default: return assertNever(prepared, "scheduled tool preparation");
		}
	}
	createExecution(exec) {
		const deferredContexts = [];
		const token = createExecutionToken();
		const callId = exec.callId;
		const rootCallId = exec.rootCallId ?? callId;
		const name$1 = exec.name;
		const agent = exec.agent;
		const parent = exec.parent;
		const signal = exec.signal;
		const visible = this.get(name$1, agent);
		const collapsed = visible !== void 0 && this.collapses(name$1, agent, parent !== void 0);
		const concludingExecutions = this.concludingExecutions;
		const base = {
			token,
			callId,
			rootCallId,
			name: name$1,
			signal,
			...agent !== void 0 ? { agent } : {},
			...parent !== void 0 ? { parent } : {},
			deferContext(context) {
				deferredContexts.push(context);
			},
			concludeTurn() {
				concludingExecutions.add(this);
			}
		};
		const capturedFinalizer = visible?.finalizeContent?.bind(visible);
		const finalizerFor = () => collapsed && !signal.aborted ? void 0 : capturedFinalizer;
		try {
			const detached = snapshotJsonValue(exec.arguments);
			if (detached === void 0) throw new TypeError("tool execution arguments must be losslessly JSON-serializable");
			const execution = {
				...base,
				arguments: deepFreeze(detached)
			};
			this.deferredContexts.set(execution, deferredContexts);
			this.contentFinalizers.set(execution, finalizerFor());
			this.cancellationStates.set(execution, {
				callerSignal: signal,
				bodyInvoked: false
			});
			if (collapsed) {
				if (signal.aborted) return {
					kind: "final-result",
					exec: execution,
					result: toolAbortedBeforeDispatchResult()
				};
				return {
					kind: "final-result",
					exec: execution,
					result: toolErrorResult(new ToolNotFoundError(name$1, `only \`${RUN_CODE_NAME}\` is callable directly — call \`${name$1}\` from inside a \`${RUN_CODE_NAME}\` program instead`))
				};
			}
			return {
				kind: "ready",
				exec: execution
			};
		} catch (error) {
			const execution = {
				...base,
				arguments: void 0
			};
			this.contentFinalizers.set(execution, finalizerFor());
			return {
				kind: "final-result",
				exec: execution,
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run the ordered pre-execute and monotonic guard stages for the scheduler.
	* @param input - the caller-supplied execution input.
	* @returns the prepared execution plus the next scheduler stage.
	* @internal
	*/
	async prepareScheduledExecution(input) {
		return this.prepareExecution(input, (prepared) => prepared);
	}
	async prepareExecution(input, next) {
		const created = this.createExecution(input);
		if (created.kind !== "ready") return next(created);
		const exec = created.exec;
		if (this.callerCancelled(exec)) return next({
			kind: "final-result",
			exec,
			result: toolAbortedBeforeDispatchResult()
		});
		try {
			const carrier = scopeTarget(this, exec.agent);
			const gate = await this.ctx.waterfall(carrier, "tools/pre-execute", exec, () => Promise.resolve({ kind: "allow" }));
			const askResolution = gate.kind === "ask" ? await this.serviceAsk(exec, gate) : {
				decision: gate,
				approvalCancelled: false
			};
			const { decision } = askResolution;
			if (this.callerCancelled(exec) && askResolution.approvalCancelled) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			const denialReason = decision.kind === "allow" ? this.guardReason(exec) : decision.reason;
			if (denialReason !== void 0) return await next({
				kind: "post-result",
				exec,
				result: this.materializeFinalResult({
					content: [{
						type: "text",
						text: `Error: ${denialReason}`
					}],
					isError: true,
					error: { message: denialReason }
				})
			});
			if (this.callerCancelled(exec)) return await next({
				kind: "post-result",
				exec,
				result: toolAbortedBeforeDispatchResult()
			});
			return await next({
				kind: "dispatch",
				exec
			});
		} catch (error) {
			return next({
				kind: "final-result",
				exec,
				result: toolErrorResult(error)
			});
		}
	}
	/** Whether the original caller signal is currently aborted. */
	callerCancelled(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.callerSignal.aborted;
	}
	/** Canonical cancellation outcome selected by whether the tool body started. */
	cancellationResult(exec, prior) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		return state.bodyInvoked ? toolAbortedResult(prior) : toolAbortedBeforeDispatchResult(prior);
	}
	/**
	* Dispatch the registered body with the original caller signal fused back
	* into any around-wrapper replacement. Cancellation never abandons the body:
	* a started promise reaches quiescence before its outcome becomes `ABORTED`.
	*/
	async dispatchToolBody(exec) {
		const state = this.cancellationStates.get(exec);
		/* v8 ignore next -- only registry-minted executions reach the staged scheduler methods */
		if (state === void 0) throw new Error("tool registry scheduler invariant violated: missing cancellation state");
		const wrapperSignal = exec.signal;
		const fused = fuseToolSignals(state.callerSignal, wrapperSignal);
		const signal = fused.signal;
		if (isAborted(signal)) {
			fused.dispose();
			return toolAbortedBeforeDispatchResult();
		}
		exec.signal = signal;
		try {
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (!tool) throw new ToolNotFoundError(exec.name);
			state.bodyInvoked = true;
			const returned = await tool.execute(exec.arguments, exec);
			const result = this.createSuccessResult(exec, tool, returned);
			return isAborted(signal) ? toolAbortedResult(result) : result;
		} catch (error) {
			return toolErrorResult(error);
		} finally {
			fused.dispose();
			exec.signal = wrapperSignal;
		}
	}
	/**
	* Run around-dispatch and the tool body. Tool and unknown-tool failures still
	* receive post-execute; pipeline failures are already final.
	* @param exec - the prepared execution.
	* @returns whether the result still needs post-execute.
	* @internal
	*/
	async dispatchScheduledExecution(exec) {
		try {
			const mutableExec = exec;
			const carrier = scopeTarget(this, exec.agent);
			const result = await this.ctx.waterfall(carrier, "tools/execute", mutableExec, () => this.dispatchToolBody(mutableExec));
			const normalized = this.normalizeDispatchResult(exec, result);
			const deferredContexts = this.deferredContexts.get(exec);
			/* v8 ignore next -- dispatch only receives executions minted by this registry's prepare stage */
			if (deferredContexts === void 0) throw new Error("tool registry scheduler invariant violated: unprepared execution");
			const resultWithDeferredContexts = deferredContexts.length === 0 ? normalized : this.markCanonical(exec, {
				...normalized,
				additionalContexts: [...deferredContexts, ...normalized.additionalContexts ?? []]
			});
			return {
				kind: "post-result",
				result: this.callerCancelled(exec) && !resultWithDeferredContexts.isError ? this.cancellationResult(exec, resultWithDeferredContexts) : resultWithDeferredContexts
			};
		} catch (error) {
			return {
				kind: "final-result",
				result: toolErrorResult(error)
			};
		}
	}
	/**
	* Run ordered post-execute, then apply definition-owned content finalization,
	* materialize, and notify the final outcome.
	* @param exec - the prepared execution.
	* @param result - dispatch/pre result that still needs post-execute.
	* @returns the materialized final result.
	* @internal
	*/
	async finalizeScheduledExecution(exec, result) {
		try {
			const postResult = await this.postExecute(exec, result);
			return this.finishScheduledExecution(exec, this.callerCancelled(exec) && !postResult.isError ? this.cancellationResult(exec, postResult) : postResult);
		} catch (error) {
			return this.finishScheduledExecution(exec, toolErrorResult(error));
		}
	}
	/**
	* Materialize the candidate, apply definition-owned content finalization,
	* then materialize and notify the authoritative result.
	* @param exec - the prepared execution.
	* @param result - final result.
	* @returns the materialized final result.
	* @internal
	*/
	finishScheduledExecution(exec, result) {
		let materializedResult;
		try {
			materializedResult = this.materializeFinalResult(result);
		} catch (error) {
			materializedResult = this.materializeFinalResult(toolErrorResult(error));
		}
		let finalResult;
		try {
			finalResult = this.materializeFinalResult(this.applyFinalContent(exec, materializedResult));
		} catch (error) {
			finalResult = this.materializeFinalResult(toolErrorResult(error));
		}
		this.notifyResult(exec, finalResult);
		return finalResult;
	}
	/** Apply the snapshotted tool-owned content transform without exposing other result fields. */
	applyFinalContent(exec, result) {
		const finalizeContent = this.contentFinalizers.get(exec);
		if (finalizeContent === void 0) return result;
		const content = finalizeContent(exec, result);
		return content === void 0 ? result : {
			...result,
			content
		};
	}
	/** Notify observers without exposing a mutation or error channel into the outcome. */
	notifyResult(exec, result) {
		Object.freeze(exec);
		const { name: toolName, callId } = exec;
		const reportFailure = (error) => {
			this.ctx.logger.warn(`tool "${toolName}" (${callId}): tools/result observer failed: ${errorMessage(error)}`);
		};
		const callbacks = this.ctx.events.dispatch("emit", [
			scopeTarget(this, exec.agent),
			"tools/result",
			exec,
			result
		]);
		for (const callback of callbacks) try {
			const returned = callback(exec, result);
			Promise.resolve(returned).catch(reportFailure);
		} catch (error) {
			reportFailure(error);
		}
	}
	/**
	* Resolve an `ask` decision to allow/deny through the approval seam. The
	* seam is consumed opportunistically with `ctx.get('approval')` — a
	* deployment that composes no ApprovalService keeps the historical degrade
	* to deny, and an unmount mid-session degrades the same way on the next ask.
	* An agent-less execution also degrades: without an agent there is no
	* session to audit to and no UI to route to. Otherwise the outcome maps
	* one-to-one — `allowed-once` proceeds; the three non-grants deny with
	* distinct reasons so the model can tell a human "no" from an absent
	* approval channel.
	*/
	async serviceAsk(exec, ask) {
		const approval = this.ctx.get("approval");
		if (approval === void 0) return {
			decision: {
				kind: "deny",
				reason: ask.reason ?? `tool "${exec.name}" requires approval (not yet supported)`
			},
			approvalCancelled: false
		};
		if (exec.agent === void 0) return {
			decision: {
				kind: "deny",
				reason: `tool "${exec.name}" requires approval, but the call has no agent to route it through`
			},
			approvalCancelled: false
		};
		const outcome = await approval.request({
			agent: exec.agent,
			toolName: exec.name,
			callId: exec.callId,
			...ask.reason !== void 0 ? { reason: ask.reason } : {},
			signal: exec.signal
		});
		switch (outcome) {
			case "allowed-once": return {
				decision: { kind: "allow" },
				approvalCancelled: false
			};
			case "rejected": return {
				decision: {
					kind: "deny",
					reason: `the user rejected tool "${exec.name}"`
				},
				approvalCancelled: false
			};
			case "cancelled": return {
				decision: {
					kind: "deny",
					reason: `approval for tool "${exec.name}" was cancelled`
				},
				approvalCancelled: true
			};
			case "unavailable": return {
				decision: {
					kind: "deny",
					reason: `tool "${exec.name}" requires approval, but no approval channel is available`
				},
				approvalCancelled: false
			};
			default: return assertNever(outcome, "ApprovalOutcome");
		}
	}
	/**
	* Run the `tools/post-execute` waterfall over a dispatched `result` and apply
	* its {@link PostToolDecision}: `accept` keeps the call successful (replacing
	* `content` when given), `block` turns it into an `isError` whose content is
	* the corrective `feedback`. Either decision may attach `additionalContexts`,
	* which are ferried on the returned result for the loop's active-batch FIFO.
	* Context deferred by the tool body survives an accepted result but is
	* discarded when the outer call is blocked; a block exposes only context the
	* blocking decision explicitly supplied.
	* Runs inside `execute`'s outer try/catch (a throwing listener → isError).
	*/
	async postExecute(exec, result) {
		const decision = await this.ctx.waterfall(scopeTarget(this, exec.agent), "tools/post-execute", exec, result, () => Promise.resolve({ kind: "accept" }));
		const decisionContexts = decision.additionalContexts ?? [];
		if (decision.kind === "block") {
			const message = failureMessageFromContent(decision.feedback);
			return this.markCanonical(exec, {
				content: decision.feedback,
				isError: true,
				error: { message },
				...decisionContexts.length > 0 ? { additionalContexts: decisionContexts } : {}
			});
		}
		if (Object.hasOwn(decision, "content") && Object.hasOwn(decision, "value")) throw new TypeError("tools/post-execute accept decision cannot replace both value and content");
		const additionalContexts = [...result.additionalContexts ?? [], ...decisionContexts];
		if (Object.hasOwn(decision, "value")) {
			if (result.isError) throw new TypeError("tools/post-execute cannot replace the value of a failed result");
			const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
			if (tool === void 0) throw new ToolNotFoundError(exec.name);
			const replaced = this.createSuccessResult(exec, tool, decision.value);
			return this.markCanonical(exec, {
				...replaced,
				...additionalContexts.length > 0 ? { additionalContexts } : {}
			});
		}
		return this.markCanonical(exec, {
			...result,
			...decision.content !== void 0 ? { content: decision.content } : {},
			...additionalContexts.length > 0 ? { additionalContexts } : {}
		});
	}
	/** Registry-normalized results and the exact dispatch that validated each value. */
	canonicalResults = /* @__PURE__ */ new WeakMap();
	/** Mark one registry-normalized result as canonical only for its owning dispatch. */
	markCanonical(exec, result) {
		this.canonicalResults.set(result, exec.token);
		return result;
	}
	/** Snapshot, validate, render, and optionally project one successful body value. */
	createSuccessResult(exec, tool, candidate) {
		const detached = snapshotToolValue(tool.name, candidate);
		const violations = validateJsonSchemaValue(tool.output.schema, detached, "value");
		if (violations.length > 0) throw new ToolOutputError(tool.name, violations);
		const value = deepFreeze(detached);
		let rendered;
		try {
			rendered = tool.output.render(exec.arguments, value);
		} catch (error) {
			throw projectionError(tool.name, "render", error);
		}
		const content = snapshotProjection(tool.name, "render", rendered);
		let meta;
		if (exec.parent === void 0 && tool.output.presentationMeta !== void 0) {
			let projected;
			try {
				projected = tool.output.presentationMeta(exec.arguments, value);
			} catch (error) {
				throw projectionError(tool.name, "presentationMeta", error);
			}
			meta = snapshotProjection(tool.name, "presentationMeta", projected);
		}
		const concludesTurn = this.concludingExecutions.has(exec);
		return this.markCanonical(exec, this.materializeFinalResult({
			isError: false,
			value,
			content,
			...meta !== void 0 ? { meta } : {},
			...concludesTurn ? { concludesTurn: true } : {}
		}));
	}
	/** Normalize an around-dispatch wrapper's authored result through the owning output contract. */
	normalizeDispatchResult(exec, result) {
		if (this.canonicalResults.get(result) === exec.token) return result;
		if (result.isError) return this.markCanonical(exec, {
			isError: true,
			error: result.error,
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
		const tool = this.resolveExecution(exec.name, exec.agent, exec.parent !== void 0);
		if (tool === void 0) throw new ToolNotFoundError(exec.name);
		const normalized = this.createSuccessResult(exec, tool, result.value);
		return this.markCanonical(exec, {
			...normalized,
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		});
	}
	/** Materialize the authoritative commit outcome once, immediately before `tools/result`. */
	materializeFinalResult(result) {
		const presentation = {
			content: result.content,
			...result.meta !== void 0 ? { meta: result.meta } : {},
			...result.additionalContexts !== void 0 ? { additionalContexts: result.additionalContexts } : {}
		};
		if (result.isError) return materializePresentation({
			isError: true,
			error: result.error,
			...presentation
		});
		return deepFreeze({
			...materializePresentation({
				isError: false,
				...presentation,
				...result.concludesTurn === true ? { concludesTurn: true } : {}
			}),
			value: result.value
		});
	}
};
/** Mint a same-process correlation token whose identity is its value. */
function createExecutionToken() {
	return Symbol("dsh.tool.execution");
}
function toolErrorResult(error) {
	const info = errorInfo(error);
	const message = errorMessage(error);
	return {
		content: [{
			type: "text",
			text: `Error: ${message}`
		}],
		isError: true,
		error: {
			message,
			...info ? { info } : {}
		}
	};
}
/** Read live abort state across an await without treating it as synchronously immutable. */
function isAborted(signal) {
	return signal.aborted;
}
/**
* Fuse caller and wrapper cancellation without nesting `AbortSignal.any`.
* Keeping the relay dispatch-scoped also removes listeners when work settles.
*/
function fuseToolSignals(caller, wrapper) {
	if (caller === wrapper) return {
		signal: caller,
		dispose() {}
	};
	const controller = new AbortController();
	let listening = false;
	const dispose = () => {
		if (!listening) return;
		listening = false;
		caller.removeEventListener("abort", abortFromCaller);
		wrapper.removeEventListener("abort", abortFromWrapper);
	};
	const abortFrom = (source) => {
		const reason = source.reason;
		controller.abort(reason);
		dispose();
	};
	const abortFromCaller = () => {
		abortFrom(caller);
	};
	const abortFromWrapper = () => {
		abortFrom(wrapper);
	};
	if (wrapper.aborted) abortFromWrapper();
	else if (caller.aborted) abortFromCaller();
	else {
		listening = true;
		caller.addEventListener("abort", abortFromCaller, { once: true });
		wrapper.addEventListener("abort", abortFromWrapper, { once: true });
	}
	return {
		signal: controller.signal,
		dispose
	};
}
/** Canonical result when cancellation supersedes success after body invocation. */
function toolAbortedResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted"
		}],
		isError: true,
		error: {
			message: "tool call aborted",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}
/** Canonical result when cancellation prevents tool body invocation. */
function toolAbortedBeforeDispatchResult(prior) {
	const additionalContexts = prior?.additionalContexts ?? [];
	return {
		content: [{
			type: "text",
			text: "Error: tool call aborted before dispatch"
		}],
		isError: true,
		error: {
			message: "tool call aborted before dispatch",
			info: {
				name: "AbortError",
				code: TOOL_ABORTED_BEFORE_DISPATCH
			}
		},
		...additionalContexts.length > 0 ? { additionalContexts } : {}
	};
}

//#endregion
//#region src/profile-route.ts
/** Route fields that name an LLM, not the subagent transport. */
const ROUTE_KEYS = [
	"provider",
	"model",
	"reasoningEffort",
	"maxTokens"
];
/** Directory under the roster that holds per-profile route files. */
const PROFILE_ROUTES_DIR = "_profiles";
const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BOUND_HASH = /^[a-f0-9]{16}$/;
/** Windows reserved device names. The stem before the first dot is what the OS checks. */
const RESERVED_BASENAMES = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`)
]);
const isEnoent = (error) => error.code === "ENOENT";
const isNotDir = (error) => error.code === "ENOTDIR";
const defaultDelay = (ms) => new Promise((resolve) => {
	setTimeout(resolve, ms);
});
/**
* Why this profile name cannot be a route-overlay directory, or undefined when
* it can. Matches the host's profile-name rules (empty, slashes, `.`, `..`,
* `node_modules` are invalid) and also rejects Windows path-segment traps
* (reserved device names, trailing dot/space, `|?*` and controls). A legal
* host name such as `my profile` is safe. An unsafe name must not fall back
* to writing this profile's route into the shared roster file.
*/
function profilePathProblem(name$1) {
	if (name$1 === "" || name$1.includes("/") || name$1.includes("\\") || name$1 === "." || name$1 === ".." || name$1 === "node_modules") return `profile name ${JSON.stringify(name$1)} is not a usable directory name`;
	if (name$1.length > 200) return `profile name ${JSON.stringify(name$1)} is too long to store a route file`;
	if (/[<>:"|?*]/.test(name$1) || [...name$1].some((char) => char.charCodeAt(0) < 32)) return `profile name ${JSON.stringify(name$1)} contains characters that cannot be a directory`;
	if (name$1.endsWith(".") || name$1.endsWith(" ")) return `profile name ${JSON.stringify(name$1)} cannot end with a dot or space`;
	const stem = name$1.split(".")[0]?.toLowerCase() ?? "";
	if (RESERVED_BASENAMES.has(stem)) return `profile name ${JSON.stringify(name$1)} is a reserved device name`;
}
/** Profile names that are safe as a single path segment under `_profiles/`. */
function isSafeProfileName(name$1) {
	return profilePathProblem(name$1) === void 0;
}
/** Stable id of the shared file's route. An overlay is bound to this value. */
function routeBinding(entry) {
	return createHash("sha256").update(JSON.stringify(pickRoute(entry ?? {}))).digest("hex").slice(0, 16);
}
/**
* Settings-page conflict hash. Includes this profile's overlays so two editors
* of the same profile cannot silently overwrite each other's route, while a
* route saved on another profile does not change this hash.
*/
function hashProfileView(sharedHash, profile, overlays) {
	const payload = Object.keys(overlays).sort().map((id) => [id, overlays[id]]);
	return createHash("sha256").update(JSON.stringify([
		sharedHash,
		profile,
		payload
	])).digest("hex").slice(0, 16);
}
function overlayDirectory(rosterDir, profile) {
	if (!isSafeProfileName(profile)) throw new Error(`unsafe profile name "${profile}"`);
	return nodePath.join(rosterDir, PROFILE_ROUTES_DIR, profile);
}
function pickRoute(entry) {
	const record$1 = entry;
	const route = {};
	const provider = record$1["provider"];
	const model = record$1["model"];
	const reasoningEffort = record$1["reasoningEffort"];
	const maxTokens = record$1["maxTokens"];
	if (typeof provider === "string" && provider !== "") route.provider = provider;
	if (typeof model === "string" && model !== "") route.model = model;
	if (typeof reasoningEffort === "string" && reasoningEffort !== "") route.reasoningEffort = reasoningEffort;
	if (typeof maxTokens === "number") route.maxTokens = maxTokens;
	return route;
}
function hasRoute(route) {
	return route.provider !== void 0 || route.model !== void 0 || route.reasoningEffort !== void 0 || route.maxTokens !== void 0;
}
function sameRoute(left, right) {
	return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort && left.maxTokens === right.maxTokens;
}
/** Drop LLM route fields. Identity, transport, and tool scope stay. */
function stripRoute(entry) {
	const next = { ...entry };
	delete next.provider;
	delete next.model;
	delete next.reasoningEffort;
	delete next.maxTokens;
	return next;
}
function withRoute(entry, route) {
	const next = stripRoute(entry);
	if (route.provider !== void 0) next.provider = route.provider;
	if (route.model !== void 0) next.model = route.model;
	if (route.reasoningEffort !== void 0) next.reasoningEffort = route.reasoningEffort;
	if (route.maxTokens !== void 0) next.maxTokens = route.maxTokens;
	return next;
}
/**
* Shared-file body for a profile-scoped save: keep this profile's identity
* edit, but do not overwrite another profile's authored route.
*/
function preserveSharedRoute(incoming, previous) {
	return withRoute(stripRoute(incoming), pickRoute(previous ?? {}));
}
function isInherit(overlay) {
	return overlay.inherit === true;
}
/**
* Resolve the route this profile should actually call.
* `registered === undefined` means the host exposed no provider list, so a
* shared route cannot be classified as foreign and is left unchanged.
*/
function resolveEffectiveEntry(entry, overlay, registered) {
	if (overlay !== void 0 && isInherit(overlay)) return {
		entry: stripRoute(entry),
		note: "inherit"
	};
	if (overlay !== void 0 && hasRoute(overlay)) {
		const next = withRoute(entry, overlay);
		if (overlay.provider !== void 0 && registered !== void 0 && !registered.has(overlay.provider)) return {
			entry: next,
			note: "profile-missing"
		};
		return {
			entry: next,
			note: "profile"
		};
	}
	if (entry.provider !== void 0 && entry.provider !== "" && registered !== void 0 && !registered.has(entry.provider)) return {
		entry: stripRoute(entry),
		note: "foreign-ignored"
	};
	return {
		entry,
		note: "shared"
	};
}
/** Parse an overlay file, including the optional shared-route binding. */
function parseOverlayDocument(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("profile route must be an object");
	const record$1 = { ...raw };
	const bound = record$1["boundHash"];
	delete record$1["boundHash"];
	if (bound !== void 0 && (typeof bound !== "string" || !BOUND_HASH.test(bound))) throw new Error("boundHash must be 16 hex characters");
	return {
		overlay: parseRouteOverlay(record$1),
		...typeof bound === "string" ? { boundHash: bound } : {}
	};
}
function parseRouteOverlay(raw) {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("profile route must be an object");
	const record$1 = raw;
	const allowed = new Set(["inherit", ...ROUTE_KEYS]);
	const unknown = Object.keys(record$1).filter((key) => !allowed.has(key));
	if (unknown.length > 0) throw new Error(`unknown route fields: ${unknown.join(", ")}`);
	if (record$1["inherit"] === true) {
		if (Object.keys(record$1).filter((key) => key !== "inherit").length > 0) throw new Error("inherit: true cannot be combined with route fields");
		return { inherit: true };
	}
	if ("inherit" in record$1) throw new Error("inherit must be true when present");
	const route = {};
	if ("provider" in record$1) {
		if (typeof record$1["provider"] !== "string" || record$1["provider"] === "") throw new Error("provider must be a non-empty string");
		route.provider = record$1["provider"];
	}
	if ("model" in record$1) {
		if (typeof record$1["model"] !== "string" || record$1["model"] === "") throw new Error("model must be a non-empty string");
		route.model = record$1["model"];
	}
	if ("reasoningEffort" in record$1) {
		if (typeof record$1["reasoningEffort"] !== "string" || !EFFORT_ID.test(record$1["reasoningEffort"])) throw new Error("reasoningEffort must be an effort id");
		route.reasoningEffort = record$1["reasoningEffort"];
	}
	if ("maxTokens" in record$1) {
		const maxTokens = record$1["maxTokens"];
		if (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error("maxTokens must be a positive integer");
		route.maxTokens = maxTokens;
	}
	if (!hasRoute(route)) throw new Error("profile route is empty");
	return route;
}
function serializeRouteOverlay(overlay, boundHash) {
	const doc = isInherit(overlay) ? { inherit: true } : {};
	if (!isInherit(overlay)) for (const key of ROUTE_KEYS) {
		const value = overlay[key];
		if (value !== void 0) doc[key] = value;
	}
	if (boundHash !== void 0) doc["boundHash"] = boundHash;
	return stringify(doc, { lineWidth: 0 });
}
async function atomicWrite(dir, fileName, text, fsp, delay) {
	await fsp.mkdir(dir, { recursive: true });
	const target = nodePath.join(dir, fileName);
	const temp = nodePath.join(dir, `.${fileName}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`);
	await fsp.writeFile(temp, text);
	for (let attempt = 0;; attempt += 1) try {
		await fsp.rename(temp, target);
		return;
	} catch (error) {
		if (attempt >= 2) {
			await fsp.unlink(temp).catch(() => {});
			throw error;
		}
		await delay(50 * 3 ** attempt);
	}
}
/** Read one profile's route file. A missing file is "no overlay", not an error. */
async function readRouteOverlay(rosterDir, profile, id, fsp = nodeFsPort) {
	let dir;
	try {
		dir = overlayDirectory(rosterDir, profile);
	} catch (error) {
		return {
			ok: false,
			message: String(error)
		};
	}
	let text;
	let used;
	for (const name$1 of entryFileNames(id)) try {
		text = (await fsp.readFile(nodePath.join(dir, name$1))).toString("utf8");
		used = name$1;
		break;
	} catch (error) {
		if (!isEnoent(error)) return {
			ok: false,
			message: `profile route unreadable (${profile}/${name$1}): ${String(error)}`
		};
	}
	if (text === void 0 || used === void 0) return { ok: true };
	try {
		const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
		const parsed = parseOverlayDocument(parse(stripped));
		return {
			ok: true,
			overlay: parsed.overlay,
			boundHash: parsed.boundHash,
			text: stripped
		};
	} catch (error) {
		return {
			ok: false,
			message: `profile route ${profile}/${used} is invalid: ${String(error)}`,
			text
		};
	}
}
async function writeRouteOverlay(rosterDir, profile, id, overlay, fsp = nodeFsPort, delay = defaultDelay, boundHash) {
	const dir = overlayDirectory(rosterDir, profile);
	await atomicWrite(dir, `${id}.yaml`, serializeRouteOverlay(overlay, boundHash), fsp, delay);
	const yml = nodePath.join(dir, `${id}.yml`);
	try {
		await fsp.unlink(yml);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}
async function deleteProfileOverlay(rosterDir, profile, id, fsp = nodeFsPort) {
	const dir = overlayDirectory(rosterDir, profile);
	for (const name$1 of entryFileNames(id)) try {
		await fsp.unlink(nodePath.join(dir, name$1));
	} catch (error) {
		if (!isEnoent(error) && !isNotDir(error)) throw error;
	}
}
/**
* Remove every profile's route file for one entry. Deleting the shared entry
* must not leave a stale overlay that reappears if the id is created again.
*/
async function deleteRouteOverlays(rosterDir, id, fsp = nodeFsPort) {
	const root = nodePath.join(rosterDir, PROFILE_ROUTES_DIR);
	let names;
	try {
		names = await fsp.readdir(root);
	} catch (error) {
		if (isEnoent(error) || isNotDir(error)) return;
		throw error;
	}
	for (const profile of names) {
		if (!isSafeProfileName(profile)) continue;
		await deleteProfileOverlay(rosterDir, profile, id, fsp);
	}
}
/**
* Persist a route edit relative to the route the settings page displayed.
* An echoed empty route — the page hid a provider this profile does not
* have — is not an edit and must not become `inherit: true`.
* @returns whether an overlay file was written.
*/
async function syncProfileRoute(options) {
	const fsp = options.fs ?? nodeFsPort;
	const clientRoute = pickRoute(options.client);
	if (sameRoute(clientRoute, pickRoute(options.shown))) return false;
	await writeRouteOverlay(options.dir, options.profile, options.id, hasRoute(clientRoute) ? clientRoute : { inherit: true }, fsp, defaultDelay, routeBinding(options.shared));
	return true;
}
/**
* Both roster spellings are confirmed missing. Any other outcome — the file
* exists, or the check itself failed — is not absence. A read/parse/permission
* error must not be turned into a delete (SUB-PROFILE-SEC-001).
*/
async function sharedEntryConfirmedAbsent(rosterDir, id, fsp) {
	for (const name$1 of entryFileNames(id)) try {
		await fsp.readFile(nodePath.join(rosterDir, name$1));
		return false;
	} catch (error) {
		if (!isEnoent(error)) return false;
	}
	return true;
}
/**
* Find overlay files only when this read proved the shared entry is gone.
*
* A successful directory listing plus a per-id ENOENT re-check is the only
* read-time signal. `unreadable` / `missing` listings, a file that was listed
* but failed to read or parse, and any non-ENOENT re-check keep every
* profile's overlay bytes. Explicit entry deletion still uses
* {@link deleteRouteOverlays}; this function is not that path.
*/
async function* orphanOverlayFiles(rosterDir, listing, presentIds, fsp = nodeFsPort) {
	if (listing !== "ok") return;
	const root = nodePath.join(rosterDir, PROFILE_ROUTES_DIR);
	let profiles;
	try {
		profiles = await fsp.readdir(root);
	} catch (error) {
		if (isEnoent(error) || isNotDir(error)) return;
		return;
	}
	for (const profile of profiles) {
		if (!isSafeProfileName(profile)) continue;
		const dir = overlayDirectory(rosterDir, profile);
		let names;
		try {
			names = await fsp.readdir(dir);
		} catch (error) {
			if (isEnoent(error) || isNotDir(error)) continue;
			continue;
		}
		for (const name$1 of names) {
			const lower = name$1.toLowerCase();
			if (!lower.endsWith(".yaml") && !lower.endsWith(".yml")) continue;
			const id = lower.endsWith(".yaml") ? lower.slice(0, -5) : lower.slice(0, -4);
			if (presentIds.has(id)) continue;
			if (!await sharedEntryConfirmedAbsent(rosterDir, id, fsp)) continue;
			yield nodePath.join(dir, name$1);
		}
	}
}
async function hasOrphanOverlays(rosterDir, listing, presentIds, fsp) {
	return !(await orphanOverlayFiles(rosterDir, listing, presentIds, fsp).next()).done;
}
async function deleteOrphanOverlays(rosterDir, listing, presentIds, fsp = nodeFsPort) {
	for await (const file of orphanOverlayFiles(rosterDir, listing, presentIds, fsp)) try {
		await fsp.unlink(file);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

//#endregion
//#region src/model-policy.ts
const POLICY_KEY = "subagentModelSelectionPolicy";
function isModelId(value) {
	return typeof value === "string" && value.trim().length > 0;
}
function isPolicy(state) {
	if (!Array.isArray(state) || state.length === 0) return false;
	const seen = /* @__PURE__ */ new Set();
	for (const route of state) {
		if (typeof route !== "object" || route === null || Array.isArray(route) || Object.keys(route).length !== 2 || !Object.hasOwn(route, "provider") || !Object.hasOwn(route, "model")) return false;
		const { provider, model } = route;
		if (!isModelId(provider) || !isModelId(model)) return false;
		const key = JSON.stringify([provider, model]);
		if (seen.has(key)) return false;
		seen.add(key);
	}
	return true;
}
/** Enforce the official session policy for an explicit child model override. */
function assertSessionModelAllowed(ctx, parent, route) {
	const unavailable = () => /* @__PURE__ */ new Error("Cannot verify the official subagent model-selection policy for this session. Omit provider, model, and reasoning_effort to use the role's saved model.");
	const { provider, model } = route;
	if (!isModelId(provider) || !isModelId(model)) throw new Error("The child LLM provider and model must be non-empty.");
	if (!parent.session) throw unavailable();
	let policy;
	try {
		policy = ctx.get("sessionProjections")?.stateOf?.(parent.session, POLICY_KEY);
	} catch {
		throw unavailable();
	}
	const denied = `Child LLM route "${provider}/${model}" is not allowed for this session.`;
	if (policy === null) {
		const requested = parent.session.requestHeader?.()?.config;
		const current = requested === void 0 ? parent.options : requested;
		if (provider === current?.provider && model === current.model) return;
		throw new Error(`${denied} Explicit overrides are limited to the current parent model. In the Subagent model selection page, select the allowed models, save, and start a new parent session.`);
	}
	if (!isPolicy(policy)) throw unavailable();
	if (!policy.some((allowed) => allowed.provider === provider && allowed.model === model)) throw new Error(`${denied} Check list_subagent_models if available, or select the model in Subagent model selection, save, and start a new parent session.`);
}

//#endregion
//#region src/dispatch.ts
function nativeHost(ctx) {
	const host = ctx.subagents;
	if (typeof host?.startActivation === "function" && typeof host.namesOf === "function" && typeof host.resolveName === "function" && typeof host.resolveMaxDepth === "function" && typeof host.getProvider === "function") return host;
}
function sameModelSelection(a, b) {
	return a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort;
}
async function startWithForkRoute(ctx, host, spec, route) {
	const { provider, model, reasoningEffort } = route;
	if (!spec.parent.id || !provider || !model) throw new Error("Cannot apply the selected model to this fork.");
	const childId = randomUUID();
	const lifetime = new AbortController();
	const signal = AbortSignal.any([spec.signal, lifetime.signal]);
	let finished = false;
	const detach = ctx.effect(function* () {
		yield ctx.on("agent/created", (event) => {
			const { agent } = event;
			if (agent.id !== childId) return;
			if (!("source" in event) || event.source !== "startup" || agent.session.header.parentSession !== spec.parent.id) throw new Error("The fork was not created under the expected parent.");
			const child = agent;
			if ("inheritedEventCount" in agent.session && agent.session.inheritedEventCount === 0) {
				const initial = child.model?.current?.();
				if (!initial || sameModelSelection(initial, route)) return;
			}
			if (typeof child.model?.select !== "function") throw new Error("This host cannot select a model for a forked child.");
			child.model.select({
				provider,
				model,
				...reasoningEffort !== void 0 ? { reasoningEffort } : {}
			});
		}, {
			global: true,
			prepend: true
		});
		yield () => {
			if (!finished) lifetime.abort();
		};
	}, "subagent-library: select fork model");
	try {
		return await host.startActivation({
			...spec,
			childId,
			signal
		});
	} finally {
		finished = true;
		await detach();
	}
}
const own = (record$1, id) => Object.hasOwn(record$1, id) ? record$1[id] : void 0;
function depthLimit(host, roleLimit) {
	const limit = host.resolveMaxDepth();
	if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("The host returned an invalid maxDepth.");
	return Math.min(limit, roleLimit ?? limit);
}
/** Availability knowable without a calling session, also used by the settings view. */
function roleUnavailable(ctx, lib, id, override) {
	if (validateEntryId(id)) return `entry id "${id}" is invalid`;
	if (lib.raw.listing === "unreadable") return "The role directory is unreadable.";
	const broken = lib.raw.diagnostics.find((item) => item.severity === "error" && item.id === id);
	if (broken) return `Role "${id}" is unreadable: ${broken.message}`;
	const row = own(lib.view.entries, id);
	if (!row) return `subagent library has no entry "${id}" (available: ${Object.keys(lib.view.entries).join(", ") || "none"})`;
	if (!row.enabled) return `entry "${id}" is disabled`;
	if (row.entry.toolFilter !== void 0) return `This host cannot enforce a per-child toolFilter. Review and explicitly remove the saved toolFilter to enable "${id}".`;
	if (lib.notes[id] === "overlay-broken") return lib.overlayErrors[id] || "Invalid profile route.";
	if (lib.notes[id] === "profile-missing" && !override) return `Provider "${row.entry.provider}" is not registered in this profile. Edit the role route for "${lib.profile}".`;
	const host = nativeHost(ctx);
	if (!host) return "This host lacks the native named activations, member addressing, or delegation limits required for dispatch.";
	const transport = row.entry.subagentProvider ?? lib.subagentProvider;
	const backend = host.getProvider(transport);
	if (!backend) return `subagent transport provider "${transport}" is not registered`;
	if (typeof backend.prepareContinuable !== "function") return `Transport "${transport}" does not support continuable children.`;
	if (!backend.capabilities.depthLimit) return `Transport "${transport}" cannot enforce maxDepth.`;
	if ((override || Object.keys(pickRoute(row.entry)).length) && !backend.capabilities.agentOptions) return `Transport "${transport}" does not support agentOptions for this role.`;
	if (depthLimit(host, row.entry.maxDepth) === 0) return "maxDepth is 0. Child creation is disabled.";
}
function groupById(lib, id) {
	if (validateEntryId(id)) throw new Error(`Invalid group_id "${id}".`);
	const problem = lib.groupDiagnostics.find((d) => d.severity === "error" && (d.id === id || !d.id && d.file === "_groups"));
	if (problem) throw new Error(`Group "${id}" is unreadable: ${problem.message}`);
	const group = own(lib.groups, id);
	if (!group) throw new Error(`Unknown group_id "${id}". Use list_subagents({kind:"groups"}).`);
	return group;
}
function checkArguments(args, keys) {
	if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error("Expected an object with named arguments.");
	if (Object.hasOwn(args, "run_in_background")) throw new Error("Remove run_in_background. delegate now returns the native name immediately. Read the result through the host notification.");
	const extra = Object.keys(args).filter((key) => !keys.includes(key));
	if (extra.length) throw new Error(`Unknown arguments: ${extra.join(", ")}. Accepted: ${keys.join(", ")}.`);
	for (const [key, value] of Object.entries(args)) if (typeof value !== "string") throw new Error(`Argument "${key}" must be a string.`);
}
function modelOverride(args) {
	const { provider, model, reasoning_effort } = args;
	if (provider === void 0 && model === void 0 && reasoning_effort === void 0) return void 0;
	if (!provider?.trim() || !model?.trim()) throw new Error("A model override requires both a non-empty provider and model. Omit all three model fields to use the role default.");
	if (reasoning_effort !== void 0 && !reasoning_effort.trim()) throw new Error("Provide a non-empty reasoning_effort or omit it for the selected model default.");
	return {
		provider,
		model,
		reasoningEffort: reasoning_effort
	};
}
function childModelRoute(inherited, overrides = {}) {
	const provider = overrides.provider ?? inherited?.provider;
	const model = overrides.model ?? inherited?.model;
	const sameModel = provider === inherited?.provider && model === inherited?.model;
	return pickRoute({
		provider,
		model,
		reasoningEffort: Object.hasOwn(overrides, "reasoningEffort") ? overrides.reasoningEffort : sameModel ? inherited?.reasoningEffort : void 0
	});
}
async function preflight(ctx, host, entry, parent, signal, override) {
	signal.throwIfAborted();
	const maxDepth = depthLimit(host, entry.maxDepth);
	const depth = Math.max(parent.options?.subagentDepth ?? 0, parent.session?.header?.delegationDepth ?? 0);
	if (depth >= maxDepth) throw new Error(`Child depth ${depth + 1} exceeds maxDepth ${maxDepth}.`);
	const route = {
		...pickRoute(entry),
		...override
	};
	const options = {
		maxDepth,
		...Object.keys(route).length ? { agentOptions: route } : {}
	};
	if (route.provider !== void 0 || route.model !== void 0 || route.reasoningEffort !== void 0) {
		const requested = childModelRoute(parent.session?.requestHeader?.()?.config ?? parent.options, route);
		if (!requested.provider || !requested.model) throw new Error("Cannot resolve the saved child route without an effective provider and model.");
		const llm = ctx.get("llm");
		if (typeof llm?.resolveCallConfig !== "function") throw new Error("The host LLM service cannot validate the saved role route.");
		const resolved = await llm.resolveCallConfig(requested, signal);
		return {
			options,
			checked: {
				requested,
				display: pickRoute({
					provider: resolved?.provider ?? requested.provider,
					model: resolved?.model ?? requested.model,
					reasoningEffort: resolved?.reasoningEffort ?? requested.reasoningEffort
				})
			}
		};
	}
	return { options };
}
const SESSION_DEFAULT = "(session default)";
function registerLibraryTools(ctx, loadEffective, routeNoteText, getSettingsFailure) {
	const readLibrary = () => {
		const failure = getSettingsFailure();
		if (failure !== void 0) throw new Error(failure);
		return loadEffective();
	};
	async function catalog(args, parent, signal) {
		if (args.kind !== void 0 && args.kind !== "roles" && args.kind !== "groups") throw new Error("kind must be \"roles\" or \"groups\".");
		if (args.group_id !== void 0 && args.kind === "roles") throw new Error("group_id requires kind \"groups\" or no kind.");
		const lib = await readLibrary();
		const rows = [];
		const groups = args.group_id !== void 0 || args.kind === "groups";
		const reasons = /* @__PURE__ */ new Map();
		function configuredRoute(id, entry) {
			const routeNote = routeNoteText(lib, id);
			return {
				provider: entry.provider ?? SESSION_DEFAULT,
				model: entry.model ?? SESSION_DEFAULT,
				...entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {},
				...routeNote ? { routeNote } : {}
			};
		}
		async function availability(id) {
			if (!reasons.has(id)) {
				let reason$1 = roleUnavailable(ctx, lib, id);
				if (!reason$1 && parent) try {
					await preflight(ctx, nativeHost(ctx), lib.view.entries[id].entry, parent, signal);
				} catch (error) {
					signal.throwIfAborted();
					reason$1 = error instanceof Error ? error.message : String(error);
				}
				reasons.set(id, reason$1);
			}
			const reason = reasons.get(id);
			return reason === void 0 ? { launchable: true } : {
				launchable: false,
				reason
			};
		}
		if (!groups) for (const [id, row] of Object.entries(lib.view.entries)) rows.push({
			id,
			description: row.entry.description,
			...configuredRoute(id, row.entry),
			...!row.enabled ? { enabled: false } : {},
			...await availability(id)
		});
		else if (args.group_id === void 0) for (const [id, group] of Object.entries(lib.groups)) rows.push({
			id,
			...group.name ? { name: group.name } : {},
			description: group.description,
			enabled: group.enabled !== false,
			memberCount: group.members.length
		});
		else {
			const group = groupById(lib, args.group_id);
			const members = [];
			for (const member of group.members) {
				const role = own(lib.view.entries, member.role);
				members.push({
					...member,
					...role ? configuredRoute(member.role, role.entry) : {},
					...group.enabled === false ? {
						launchable: false,
						reason: "Group is disabled."
					} : await availability(member.role)
				});
			}
			return [{
				id: args.group_id,
				...group.name ? { name: group.name } : {},
				description: group.description,
				enabled: group.enabled !== false,
				...group.instructions ? { instructions: group.instructions } : {},
				members
			}];
		}
		const diagnostics = (groups ? lib.groupDiagnostics : lib.view.diagnostics).filter((d) => d.severity !== "info").map((d) => `${d.severity}${d.id ? ` [${d.id}]` : ""}: ${d.message}`);
		if (diagnostics.length) rows.push({ diagnostics });
		return rows;
	}
	ctx.tools.register(defineTool({
		name: "list_subagents",
		description: "List saved roles or groups. Use group_id to see exact slot keys, roles, default assignments and availability.",
		parameters: {
			kind: {
				type: "string",
				enum: ["roles", "groups"],
				description: "Omit for roles. Use groups to browse saved groups."
			},
			group_id: {
				type: "string",
				description: "Inspect one group. Implies groups."
			}
		},
		output: {
			schema: {
				type: "array",
				items: { type: "json" }
			},
			render: (_args, rows) => [{
				type: "text",
				text: JSON.stringify(rows)
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			checkArguments(args, ["kind", "group_id"]);
			return catalog(args, exec.agent, exec.signal);
		}
	}));
	ctx.tools.register(defineTool({
		name: "delegate",
		description: "Start one member by library_id or by group_id and exact slot. For independent tasks, issue separate delegate calls in the same response. Use each returned name to address that member. Omit model fields to use the role default. Select an authorized model only when the task calls for it.",
		parameters: {
			library_id: {
				type: "string",
				description: "Role ID for a direct start. Omit when selecting a group slot."
			},
			group_id: {
				type: "string",
				description: "Group containing the selected slot. Requires slot."
			},
			slot: {
				type: "string",
				description: "One exact slot key in group_id. Its saved assignment is included."
			},
			prompt: {
				type: "string",
				required: true,
				description: "Task and context for this member."
			},
			description: {
				type: "string",
				description: "Optional short display label."
			},
			provider: {
				type: "string",
				description: "LLM provider for this start. Requires model. Use list_subagent_models if available to discover authorized choices."
			},
			model: {
				type: "string",
				description: "Exact model ID for this start. Requires provider."
			},
			reasoning_effort: {
				type: "string",
				description: "Effort for the selected provider and model. Omit for that model’s default."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					kind: {
						type: "string",
						required: true
					},
					library_id: {
						type: "string",
						required: true
					},
					name: {
						type: "string",
						required: true
					},
					subagentId: {
						type: "string",
						required: true
					},
					group_id: { type: "string" },
					slot: { type: "string" },
					routeNote: { type: "string" },
					provider: { type: "string" },
					model: { type: "string" },
					reasoningEffort: { type: "string" }
				}
			},
			render: (_args, receipt) => [{
				type: "text",
				text: JSON.stringify(receipt)
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			checkArguments(args, [
				"library_id",
				"group_id",
				"slot",
				"prompt",
				"description",
				"provider",
				"model",
				"reasoning_effort"
			]);
			if (!args.prompt?.trim()) throw new Error("Provide a non-empty prompt for this member.");
			const grouped = args.group_id !== void 0 && args.slot !== void 0 && args.library_id === void 0;
			if (!(args.library_id !== void 0 && args.group_id === void 0 && args.slot === void 0) && !grouped) {
				if (args.group_id !== void 0 && args.slot === void 0 && args.library_id === void 0) {
					const group$1 = groupById(await readLibrary(), args.group_id);
					throw new Error(`Group "${args.group_id}" requires exactly one slot. Available: ${group$1.members.map((member) => member.slot).join(", ")}.`);
				}
				throw new Error("Specify either library_id alone or group_id with exactly one slot.");
			}
			if (!exec.agent) throw new Error("delegate requires a calling agent.");
			const override = modelOverride(args);
			const lib = await readLibrary();
			let id = args.library_id;
			let group;
			let assignment;
			if (grouped) {
				group = groupById(lib, args.group_id);
				if (group.enabled === false) throw new Error(`Group "${args.group_id}" is disabled.`);
				const member = group.members.find((m) => m.slot === args.slot);
				if (!member) throw new Error(`Unknown slot "${args.slot}" in "${args.group_id}". Available: ${group.members.map((m) => m.slot).join(", ")}.`);
				id = member.role;
				assignment = member.assignment;
			}
			const library_id = id;
			const target = grouped ? `${args.group_id}/${args.slot} (${library_id})` : library_id;
			const unavailable = roleUnavailable(ctx, lib, library_id, override);
			if (unavailable) throw new Error(`delegate "${target}": ${unavailable}`);
			const entry = lib.view.entries[library_id].entry;
			const routeNote = override ? void 0 : routeNoteText(lib, library_id);
			const sections = [
				entry.persona && `Role persona:\n${entry.persona}`,
				group?.instructions && `Group instructions:\n${group.instructions}`,
				assignment && `Slot assignment:\n${assignment}`
			].filter(Boolean);
			const text = sections.length ? [...sections, `Task:\n${args.prompt}`].join("\n\n") : args.prompt;
			const parent = exec.agent;
			const host = nativeHost(ctx);
			const provider = entry.subagentProvider ?? lib.subagentProvider;
			const transport = host.getProvider(provider);
			try {
				if (override) assertSessionModelAllowed(ctx, parent, override);
				const { options, checked } = await preflight(ctx, host, entry, parent, exec.signal, override);
				exec.signal.throwIfAborted();
				if (host.getProvider(provider) !== transport) throw new Error("Transport changed during route validation. Retry the selected member.");
				if (override) assertSessionModelAllowed(ctx, parent, override);
				const header = parent.session?.requestHeader?.();
				const live = childModelRoute(header?.config ?? parent.options, options.agentOptions);
				const launch = checked && sameModelSelection(checked.requested, live) ? checked.display : live;
				const badge = launch.model ? ` [${[launch.model, launch.reasoningEffort].filter(Boolean).join(" · ")}]` : "";
				const description = args.description?.trim();
				const label = `${grouped ? `${args.group_id}/${args.slot}` : library_id}${badge}${description ? ` · ${description}` : ""}`;
				const spec = {
					parent,
					signal: exec.signal,
					provider,
					label,
					delivery: "parent",
					prompt: [{
						type: "text",
						text
					}],
					...options
				};
				const forkRoute = !checked && header?.adapterDefaults?.reasoningEffort ? {
					...live,
					reasoningEffort: void 0
				} : live;
				const started = transport?.inheritsParentContext && (checked || live.provider && live.model) ? await startWithForkRoute(ctx, host, spec, forkRoute) : await host.startActivation(spec);
				if (!started.name || !started.childId) throw new Error("Missing native receipt. Check list_agents for this label before retrying.");
				return {
					kind: "activation",
					library_id,
					...grouped ? {
						group_id: args.group_id,
						slot: args.slot
					} : {},
					name: started.name,
					subagentId: started.childId,
					...launch,
					...routeNote ? { routeNote } : {}
				};
			} catch (error) {
				exec.signal.throwIfAborted();
				throw new Error(`delegate "${target}": ${error instanceof Error ? error.message : String(error)}`, { cause: error });
			}
		}
	}));
	ctx.systemPrompt.section({
		name: "subagent-library",
		order: 116.6,
		text: (context) => ctx.tools.get("list_subagents", context.scope) === void 0 ? "" : "Use native subagent tools for ad hoc work. Browse saved roles and groups with list_subagents. You can delegate independent assignments in parallel, one call per member."
	});
	ctx.get("commands")?.register({
		name: "subagent",
		description: "Browse saved roles, groups and group slots.",
		input: { hint: "roles | groups [group-id]" },
		handler: async (invocation) => {
			const [kind = "roles", group_id, extra] = invocation.rawInput.trim().split(/\s+/).filter(Boolean);
			if (extra || kind !== "roles" && kind !== "groups" || group_id && kind !== "groups") return {
				kind: "error",
				text: "用法：/subagent roles 或 /subagent groups [group-id]"
			};
			try {
				return {
					kind: "success",
					text: formatCatalog(await catalog({
						kind,
						group_id
					}, invocation.agent, invocation.signal), kind, group_id).join("\n")
				};
			} catch (error) {
				return {
					kind: "error",
					text: error instanceof Error ? error.message : String(error)
				};
			}
		}
	});
}
function formatConfiguredRoute(row) {
	if (!row.model) return "";
	const model = row.model === SESSION_DEFAULT ? "跟随主会话模型" : row.model;
	return `${row.provider && row.provider !== SESSION_DEFAULT ? `${row.provider}/` : ""}${model}${row.reasoningEffort ? ` · ${row.reasoningEffort}` : ""}`;
}
/** Render the same on-demand catalog for the command palette. */
function formatCatalog(rows, kind, groupId) {
	const title = groupId ? `编队 ${groupId}` : kind === "groups" ? "编队目录" : "角色名册";
	const lines = [title];
	if (!rows.length) return [`${title}为空。`];
	for (const value of rows) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		if (Array.isArray(value.diagnostics)) {
			for (const message of value.diagnostics) lines.push(`! ${message}`);
			continue;
		}
		if (value.id !== groupId) {
			const label = value.name ? `${value.id}（${value.name}）` : value.id;
			const status = value.reason ? ` · 不可派遣：${value.reason}` : value.enabled === false ? " · 已停用" : "";
			const detail = kind === "groups" ? `${value.memberCount} 名成员` : formatConfiguredRoute(value);
			lines.push(`${label} · ${value.description}（${detail}）${status}`);
			if (value.routeNote) lines.push(`  ${value.routeNote}`);
			continue;
		}
		lines.push(`${value.name ? `${value.name} · ` : ""}${value.description}${value.enabled === false ? " · 已停用" : ""}`);
		if (value.instructions) lines.push(`编队说明：${value.instructions}`);
		if (Array.isArray(value.members)) for (const member of value.members) {
			if (!member || typeof member !== "object" || Array.isArray(member)) continue;
			lines.push([
				`${member.slot} → ${member.role}`,
				formatConfiguredRoute(member),
				member.assignment,
				member.launchable ? "可派遣" : `不可派遣：${member.reason}`
			].filter(Boolean).join(" · "));
		}
	}
	return lines;
}

//#endregion
//#region src/index.ts
const name = "subagent-library";
const inject = [
	"subagents",
	"tools",
	"systemPrompt"
];
const Config = z.object({
	subagentProvider: z.string().default("spawn"),
	entriesDir: z.string(),
	entries: z.dict(EntrySchema).default({})
});
function apply(ctx, config) {
	const SETTINGS_NS = "subagent-library";
	let configEditorHost;
	let settings;
	/** Non-null when the settings seam could not initialize (e.g. a hand-edited
	*  stored section fails the Config schema on the legacy register path).
	*  Failures surface through every consumer instead of leaving the library
	*  silently degraded. */
	let settingsFailure;
	ctx.inject(["settings"], (sctx) => {
		/** Structural view covering both host generations (type deps stay pinned
		*  to 0.1.0-rc.6, so nothing here can rely on their static types). */
		const svc = sctx.settings;
		if (typeof svc?.register === "function") {
			try {
				const scope = svc.register(SETTINGS_NS, Config, { base: config });
				const legacyRaw = () => {
					try {
						return (svc.describe?.().find((candidate) => String(candidate.ns) === SETTINGS_NS))?.user ?? void 0;
					} catch {
						return;
					}
				};
				settings = {
					readConfig: () => scope.get(),
					legacyUserEntries: () => legacyRaw()?.entries,
					unsetEntries: async (ids) => {
						if (ids.length === 0) return "done";
						if (typeof svc.mutate !== "function") return "no-settings";
						if (svc.writable === false) return "skipped-readonly";
						await svc.mutate(SETTINGS_NS, ids.map((id) => ({
							op: "unset",
							path: ["entries", id]
						})));
						return "done";
					},
					isWritable: () => svc.writable !== false
				};
			} catch (error) {
				settingsFailure = `subagent-library 设置段注册失败：${String(error)}。请检查存储的 subagent-library 配置段（常见：description 缺失、entries 写成数组、YAML 布尔/字符串误写）。`;
			}
			return;
		}
		if (typeof svc?.register !== "function") {
			/** Resolved schema defaults, computed once. Used to RESTORE effective
			*  defaults in the apply()-closure when a raw patch `next` drops keys —
			*  the ConfigEditor raw layer does NOT carry schema defaults
			*  (e.g. `subagentProvider: 'spawn'`), and a wholesale overwrite of the
			*  resolved config with raw values silently removed them, breaking
			*  delegation with "provider not registered"
			*  (SUB-COMPAT-017-004). Defaults are restored in the closure ONLY —
			*  never written back into the raw patch. */
			let schemaDefaultsCache;
			const schemaDefaults = () => {
				if (schemaDefaultsCache === void 0) try {
					schemaDefaultsCache = Config({});
				} catch {
					schemaDefaultsCache = {
						subagentProvider: "spawn",
						entries: {}
					};
				}
				const cached = schemaDefaultsCache;
				return {
					...cached,
					entries: { ...cached["entries"] ?? {} }
				};
			};
			/** Reflect a reconciled RAW config into the apply()-closure, re-resolving
			*  schema defaults for keys the raw layer dropped. The Loader reconcile
			*  may restart this plugin asynchronously, but the in-flight HTTP
			*  response and later reads must not lose defaults in the meantime. */
			const applyReconciled = (next) => {
				const target = config;
				const defaults = schemaDefaults();
				const keys = new Set([
					...Object.keys(defaults),
					...Object.keys(target),
					...Object.keys(next)
				]);
				for (const key of keys) {
					if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
					if (Object.hasOwn(next, key)) target[key] = next[key];
					else if (defaults[key] !== void 0) target[key] = defaults[key];
					else if (key in target) delete target[key];
				}
			};
			settings = {
				readConfig: () => config,
				legacyUserEntries: () => config.entries ?? void 0,
				unsetEntries: async (ids) => {
					if (ids.length === 0) return "done";
					const editor = configEditorHost;
					if (editor === void 0) return "no-settings";
					if (svc.writable === false) return "skipped-readonly";
					const entry = editor.entries?.().find((row) => {
						const id = row.options?.id ?? row.id;
						return String(id ?? "") === SETTINGS_NS;
					});
					if (entry === void 0) return "no-settings";
					let applied;
					await editor.edit(entry, (current) => {
						const patchEntries = typeof current["entries"] === "object" && current["entries"] !== null ? { ...current["entries"] } : {};
						const merged = {
							...config.entries ?? {},
							...patchEntries
						};
						let changed = false;
						for (const id of ids) if (Object.hasOwn(merged, id)) {
							delete merged[id];
							changed = true;
						}
						const next = changed ? {
							...current,
							entries: merged
						} : { ...current };
						applied = next;
						return next;
					});
					if (applied !== void 0) applyReconciled(applied);
					return "done";
				},
				isWritable: () => svc.writable !== false
			};
			return;
		}
	});
	ctx.inject(["settings", "configEditor"], (ectx) => {
		const editor = ectx.configEditor;
		if (editor !== void 0) configEditorHost = editor;
	});
	/** Library entries restricted to schema-consistent ids: a hand-written key
	*  like `k3_reviewer` passes z.dict (any string key) but can never be
	*  delegated or deleted, so it is filtered out of every view. */
	const filterEntries = (raw) => Object.fromEntries(Object.entries(raw ?? {}).filter(([id]) => ENTRY_ID.test(id)));
	const resolveConfig = () => {
		const base = settings?.readConfig() ?? config;
		return {
			...base,
			entries: filterEntries(base.entries)
		};
	};
	const fsPort = () => ctx[kFsPort] ?? nodeFsPort;
	let migratedDir;
	let migrationFailure;
	/** Seed missing files once per directory, retaining the legacy settings.
	* Retry a partial migration on the next maintenance read. */
	const ensureMigrated = async (dir, cfg) => {
		const legacy = cfg.entries ?? {};
		if (Object.keys(legacy).length === 0) return;
		if (migratedDir === dir) return;
		try {
			const result = await migrateLegacyEntries({
				dir,
				legacy,
				fs: fsPort()
			});
			if (result.diagnostics.length === 0) {
				migratedDir = dir;
				migrationFailure = void 0;
			} else migrationFailure = `${result.diagnostics.map((item) => item.message).join("；")}（修复后将自动重试）`;
		} catch (error) {
			migrationFailure = `${String(error)}——下次使用名册时自动重试；重启 dsh web 亦可立即重试`;
		}
	};
	/** Fresh roster view for every consumer (tools, command, settings API):
	*  no cache — tens of small files read in milliseconds, and the cache layer
	*  is exactly where mtime/case/rename bugs live (v0.3.0 design review). */
	const loadLibrary = async (maintain, cfg, dir) => {
		if (settingsFailure !== void 0) throw new Error(settingsFailure);
		if (maintain) await ensureMigrated(dir, cfg);
		const view = await loadRoster({
			dir,
			legacy: cfg.entries,
			fs: fsPort()
		});
		if (migrationFailure !== void 0) view.diagnostics.unshift({
			severity: "warning",
			message: `旧条目自动迁移未完成：${migrationFailure}`
		});
		return {
			subagentProvider: cfg.subagentProvider,
			view
		};
	};
	/** Launcher-owned profile. Absent hosts keep the shared-file route. An
	*  unsafe name is still a profile — it must not silently write its route
	*  into the shared roster. */
	const currentProfile = () => {
		const profile = ctx.get("profileContext");
		if (profile == null) return { kind: "absent" };
		const name$1 = profile.name;
		if (typeof name$1 !== "string" || name$1 === "") return {
			kind: "unsafe",
			name: "",
			reason: "宿主提供的 profile 缺少名称，无法保存该配置的模型设置。"
		};
		const reason = profilePathProblem(name$1);
		return reason === void 0 ? {
			kind: "ready",
			name: name$1
		} : {
			kind: "unsafe",
			name: name$1,
			reason
		};
	};
	/** Provider ids registered in THIS process. Undefined when the host has no
	*  `llm` service — a missing list must not be treated as "no providers",
	*  or every shared route would be dropped. */
	const registeredProviderIds = () => {
		const llm = ctx.get("llm");
		if (typeof llm?.listProviders !== "function") return void 0;
		try {
			const ids = llm.listProviders().map((item) => item?.id).filter((id) => typeof id === "string" && id !== "");
			return new Set(ids);
		} catch {
			return;
		}
	};
	/** Only the directory lock owner may migrate or clean up overlays. */
	const readEffective = async (maintain, cfg, dir) => {
		const lib = await loadLibrary(maintain, cfg, dir);
		const { groups, groupDiagnostics, groupRevision } = await loadGroups(lib.view.dir, fsPort());
		const sharedHash = createHash("sha256").update(JSON.stringify([
			dir,
			lib.view.hash,
			lib.view.fileRevision,
			groupRevision
		])).digest("hex").slice(0, 16);
		const state = currentProfile();
		if (state.kind === "absent") return {
			...lib,
			groups,
			groupDiagnostics,
			raw: lib.view,
			view: {
				...lib.view,
				hash: sharedHash
			},
			notes: {},
			ignoredProviders: {},
			overlayErrors: {},
			overlayTexts: {}
		};
		const registered = registeredProviderIds();
		const notes = Object.create(null);
		const ignoredProviders = Object.create(null);
		const overlayErrors = Object.create(null);
		const overlayTexts = Object.create(null);
		const entries = Object.create(null);
		const diagnostics = [...lib.view.diagnostics];
		let staleProfileOverlay = false;
		if (state.kind === "unsafe") diagnostics.unshift({
			severity: "error",
			message: `${state.reason}。本 profile 不会把模型路由写进共享名册；未注册的共享 provider 仍不会被调用。`
		});
		else if (maintain) await deleteOrphanOverlays(lib.view.dir, lib.view.listing, lib.view.presentIds, fsPort());
		for (const [id, row] of Object.entries(lib.view.entries)) {
			let overlay = void 0;
			if (state.kind === "ready") {
				const read = await readRouteOverlay(lib.view.dir, state.name, id, fsPort());
				if (!read.ok) {
					notes[id] = "overlay-broken";
					overlayErrors[id] = read.message;
					if (read.text !== void 0) overlayTexts[id] = read.text;
					entries[id] = {
						...row,
						entry: stripRoute(row.entry)
					};
					diagnostics.push({
						severity: "error",
						id,
						message: read.message
					});
					continue;
				}
				if (read.overlay !== void 0 && read.boundHash !== void 0 && read.boundHash !== routeBinding(row.entry)) {
					const readable = row.source === "file" && !lib.view.diagnostics.some((d) => d.id === id && d.severity === "error");
					if (readable) staleProfileOverlay = true;
					if (maintain && readable) await deleteProfileOverlay(lib.view.dir, state.name, id, fsPort());
					else if (read.text !== void 0) overlayTexts[id] = read.text;
					diagnostics.push({
						severity: "warning",
						id,
						message: `profile "${state.name}" 的路由覆盖已失效（共享名册路由已变），已忽略。`
					});
				} else {
					overlay = read.overlay;
					if (read.text !== void 0 && read.overlay !== void 0) overlayTexts[id] = read.text;
				}
			}
			const resolved = resolveEffectiveEntry(row.entry, overlay, registered);
			notes[id] = resolved.note;
			entries[id] = {
				...row,
				entry: resolved.entry
			};
			if (resolved.note === "foreign-ignored" && row.entry.provider !== void 0) ignoredProviders[id] = row.entry.provider;
		}
		const hash = hashProfileView(sharedHash, state.name, Object.fromEntries(Object.keys(entries).map((id) => [id, JSON.stringify([
			notes[id],
			overlayTexts[id],
			overlayErrors[id]
		])])));
		return {
			groups,
			groupDiagnostics,
			subagentProvider: lib.subagentProvider,
			raw: lib.view,
			view: {
				...lib.view,
				entries,
				diagnostics,
				hash
			},
			...state.kind === "ready" ? { profile: state.name } : {
				profile: state.name,
				profileProblem: state.reason
			},
			notes,
			ignoredProviders,
			overlayErrors,
			overlayTexts,
			staleProfileOverlay,
			...registered === void 0 ? {} : { registeredProviders: [...registered] }
		};
	};
	const loadEffective = async () => {
		const config$1 = resolveConfig();
		const dir = resolveEntriesDir(config$1.entriesDir);
		const opened = await readEffective(false, config$1, dir);
		const { listing, presentIds } = opened.raw;
		let needsMaintenance = opened.staleProfileOverlay === true;
		if (dir !== migratedDir && listing !== "unreadable") {
			const legacy = Object.keys(config$1.entries ?? {}).filter((id) => !validateEntryId(id));
			if (legacy.length) if (legacy.some((id) => !presentIds.has(id)) || migrationFailure !== void 0) needsMaintenance = true;
			else migratedDir = dir;
		}
		if (!needsMaintenance && opened.profile !== void 0 && !opened.profileProblem) needsMaintenance = await hasOrphanOverlays(dir, listing, presentIds, fsPort());
		if (!needsMaintenance) return opened;
		let unlock;
		try {
			unlock = await lockRoster(dir, fsPort(), 0);
		} catch {
			return opened;
		}
		try {
			const latest = resolveConfig();
			return resolveEntriesDir(latest.entriesDir) === dir ? await readEffective(true, latest, dir) : opened;
		} finally {
			await unlock();
		}
	};
	const routeNoteText = (lib, id) => {
		const note = lib.notes[id];
		const profile = lib.profile ?? "this profile";
		if (note === "foreign-ignored") return `provider "${lib.ignoredProviders[id] ?? "?"}" is not registered in profile "${profile}"; this call uses the session model`;
		if (note === "profile") return `route is pinned to profile "${profile}"`;
		if (note === "inherit") return `profile "${profile}" inherits the session model`;
		if (note === "profile-missing") return `profile "${profile}" route provider is not registered in this profile`;
		if (note === "overlay-broken") return lib.overlayErrors[id];
	};
	const MAX_BODY_BYTES = 1 << 20;
	const readJsonBody = async (req) => {
		const chunks = [];
		let size = 0;
		for await (const chunk of req) {
			const buffer = chunk;
			size += buffer.length;
			if (size > MAX_BODY_BYTES) return {
				ok: false,
				error: "too-large"
			};
			chunks.push(buffer);
		}
		if (chunks.length === 0) return {
			ok: true,
			body: {}
		};
		try {
			const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			return typeof parsed === "object" && parsed !== null ? {
				ok: true,
				body: parsed
			} : {
				ok: false,
				error: "bad-json"
			};
		} catch {
			return {
				ok: false,
				error: "bad-json"
			};
		}
	};
	const sendJson = (res, status, value) => {
		const body = JSON.stringify(value);
		res.writeHead(status, {
			"content-type": "application/json; charset=utf-8",
			"content-length": Buffer.byteLength(body),
			"cache-control": "no-store"
		});
		res.end(body);
	};
	const guardWrite = (req, res) => {
		if ((req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase() !== "application/json") {
			sendJson(res, 415, {
				ok: false,
				error: "content-type-json-required"
			});
			return false;
		}
		const origin = req.headers.origin;
		if (origin !== void 0) {
			let originHost = "";
			try {
				originHost = new URL(origin).host;
			} catch {
				originHost = "";
			}
			const hostHeader = req.headers.host ?? "";
			const sameOrigin = originHost !== "" && originHost === hostHeader;
			const loopback = originHost.startsWith("127.0.0.1:") || originHost.startsWith("localhost:") || originHost.startsWith("[::1]:");
			if (!sameOrigin && !loopback) {
				sendJson(res, 403, {
					ok: false,
					error: "cross-origin-forbidden"
				});
				return false;
			}
		}
		return true;
	};
	/** Wire shape of one roster row for the settings editor: the stored entry
	*  plus the enabled flag when false and a `source` marker for legacy rows. */
	const availability = (reason) => reason ? {
		launchable: false,
		reason
	} : { launchable: true };
	/** Legacy settings entries currently shadowed by a roster file — the safe
	*  one-click cleanup set for the 0.2→0.3 transition (a legacy row WITHOUT a
	*  file is still serving and must survive). */
	const legacyShadowedIds = (view) => {
		const raw = settings?.legacyUserEntries();
		if (raw === void 0) return [];
		return Object.keys(raw).filter((id) => ENTRY_ID.test(id) && view.entries[id]?.source === "file");
	};
	const profileRouteWarnings = (lib) => {
		if (lib.profile === void 0) return [];
		return Object.entries(lib.ignoredProviders).map(([id, provider]) => ({
			severity: "warning",
			id,
			message: `共享名册路由 provider "${provider}" 未在当前 profile "${lib.profile}" 注册，调用将改用本会话模型。在此填写的 Provider/模型只保存到这个 profile。`
		}));
	};
	const wireView = (lib, legacySkipWarning = false, extraWarnings = []) => {
		const reasons = /* @__PURE__ */ new Map();
		const reasonFor = (id) => {
			if (!reasons.has(id)) reasons.set(id, roleUnavailable(ctx, lib, id));
			return reasons.get(id);
		};
		const diagnostics = [
			...extraWarnings.map((message) => ({
				severity: "warning",
				message
			})),
			...legacySkipWarning ? [{
				severity: "warning",
				message: "设置服务只读：settings 中的旧副本未能同步移除，被删条目可能以旧副本复活"
			}] : [],
			...profileRouteWarnings(lib),
			...lib.view.diagnostics,
			...lib.groupDiagnostics
		];
		return {
			ok: true,
			writable: true,
			dir: lib.view.dir,
			hash: lib.view.hash,
			...lib.profile !== void 0 ? { profile: lib.profile } : {},
			...lib.profileProblem && { routeWriteProblem: lib.profileProblem },
			entries: Object.fromEntries(Object.entries(lib.view.entries).map(([id, row]) => [id, {
				...row.entry,
				...row.enabled ? {} : { enabled: false },
				...row.source === "legacy" && { source: "legacy" },
				...lib.notes[id] && lib.notes[id] !== "shared" && { routeNote: lib.notes[id] },
				...availability(reasonFor(id))
			}])),
			sharedEntries: Object.fromEntries(Object.entries(lib.raw.entries).map(([id, row]) => [id, {
				...row.entry,
				...row.enabled ? {} : { enabled: false }
			}])),
			groups: Object.fromEntries(Object.entries(lib.groups).map(([id, group]) => [id, {
				...group,
				members: group.members.map((member) => ({
					...member,
					...availability(group.enabled === false ? `编队 "${id}" 已停用` : reasonFor(member.role))
				}))
			}])),
			groupDiagnostics: lib.groupDiagnostics,
			roleUsages: roleUsages(lib.groups),
			diagnostics,
			legacyCount: legacyShadowedIds(lib.view).length
		};
	};
	ctx.inject(["webServer"], (wctx) => {
		const web = wctx.webServer;
		/** Best-effort removal of legacy-only settings entries (the file half is
		*  already gone). No expectedRevision: last-write-wins — a racing settings
		*  writer must not fail a delete that mostly succeeded. Returns whether
		*  the unset actually ran, so a read-only settings service can be surfaced
		*  instead of a silent false success (red team A7 / k3 #4). */
		const unsetLegacy = async (ids) => {
			if (ids.length === 0) return "done";
			return settings?.unsetEntries(ids) ?? "no-settings";
		};
		class WriteProblem extends Error {
			constructor(status, code, message, details = {}) {
				super(message);
				this.status = status;
				this.code = code;
				this.details = details;
			}
		}
		const applyWrite = async (body, opened) => {
			const current = opened.raw;
			const fs = fsPort();
			const op = body.op;
			const id = typeof body.id === "string" ? body.id : "";
			const warnings = [];
			const unreadable = (diagnostics) => new WriteProblem(503, "references-unreadable", "引用或角色无法完整读取，请修复后重试。", { diagnostics });
			const checkDeletion = (ids) => {
				if (!ids.length) return;
				if (opened.groupDiagnostics.length) throw unreadable(opened.groupDiagnostics);
				const usages = roleUsages(opened.groups);
				const references = ids.flatMap((roleId) => (usages[roleId] ?? []).map((ref) => ids.length === 1 ? ref : {
					roleId,
					...ref
				}));
				if (references.length) throw new WriteProblem(409, "role-in-use", "有编队成员还在使用这个角色。请先给他们换个角色，或将他们移出编队。", { references });
			};
			const readErrors = (role) => current.unreadableIds.has(role) ? current.diagnostics.filter((d) => d.id === role && d.severity !== "info") : [];
			const deleteRoles = async (ids) => {
				for (const role of ids) {
					await deleteEntryFile(current.dir, role, fs);
					await deleteRouteOverlays(current.dir, role, fs);
				}
				return await unsetLegacy(ids) === "skipped-readonly";
			};
			if (op === "clear-legacy") {
				if (settings && !settings.isWritable()) throw new WriteProblem(403, "readonly", "设置服务只读，无法清除旧副本");
				await unsetLegacy(legacyShadowedIds(current));
				return {};
			}
			if (op !== "save" && op !== "delete" && op !== "save-entry" && op !== "save-group" && op !== "delete-group") throw new WriteProblem(400, "unknown-op", "未知的保存操作");
			const invalidId = op === "save" ? void 0 : validateEntryId(id);
			if (invalidId) throw new WriteProblem(400, "invalid-id", invalidId);
			if (op === "save-group" || op === "delete-group") {
				if (opened.groupDiagnostics.some((d) => !d.id)) throw unreadable(opened.groupDiagnostics);
				const groupProblems = opened.groupDiagnostics.filter((d) => d.id === id);
				if (op === "save-group" && groupProblems.length) throw unreadable(groupProblems);
				if (groupProblems.some((d) => d.file !== `_groups/${id}.yaml` && d.file !== `_groups/${id}.yml`)) throw unreadable(groupProblems);
				if (op === "delete-group") {
					await deleteGroup(current.dir, id, fs);
					return {};
				}
				let group;
				try {
					group = parseGroup(body.group, true);
				} catch (error) {
					throw new WriteProblem(400, "invalid-group", String(error));
				}
				const oldMembers = new Map(opened.groups[id]?.members.map((m) => [m.slot, m.role]));
				for (const { role, slot } of group.members) {
					if (oldMembers.get(slot) === role) continue;
					if (current.listing === "unreadable") throw unreadable(current.diagnostics);
					const problems = current.diagnostics.filter((d) => d.id === role && d.severity === "error");
					if (!problems.length) problems.push(...readErrors(role));
					if (problems.length) throw unreadable(problems);
					if (!current.entries[role]) throw new WriteProblem(400, "invalid-reference", `成员 "${slot}" 使用的角色 "${role}" 不在名册里`, {
						slot,
						role
					});
				}
				if (!isDeepStrictEqual(group, opened.groups[id])) await writeGroup(current.dir, id, group, fs);
				return {};
			}
			if (current.listing === "unreadable") throw unreadable(current.diagnostics);
			if (op === "delete") {
				checkDeletion([id]);
				return { skipped: await deleteRoles([id]) };
			}
			const single = op === "save-entry";
			const candidate = single ? { [id]: body.entry } : body.entries;
			if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new WriteProblem(400, "entries-object-required", "entries 需要对象");
			const documents = /* @__PURE__ */ new Map();
			let route;
			if (single && body.route !== void 0) {
				if (opened.profileProblem) throw new WriteProblem(400, "profile-path", opened.profileProblem);
				try {
					route = parseRouteOverlay(body.route);
				} catch (error) {
					throw new WriteProblem(400, "invalid-route", String(error));
				}
			}
			if (single && body.clearToolFilter !== void 0 && typeof body.clearToolFilter !== "boolean") throw new WriteProblem(400, "rejected", "clearToolFilter 需要布尔值");
			const deletedIds = single ? [] : Object.keys(current.entries).filter((role) => !Object.hasOwn(candidate, role));
			checkDeletion(deletedIds);
			if (!single) {
				const damaged = [...current.unreadableIds].flatMap(readErrors);
				if (damaged.length) throw unreadable(damaged);
				if (deletedIds.some((role) => current.entries[role].entry.toolFilter !== void 0)) throw new WriteProblem(409, "tool-filter-protected", "请在角色行显式删除带有工具限制的角色。");
			}
			for (const [role, value] of Object.entries(candidate)) {
				const invalid = validateEntryId(role);
				if (invalid) throw new WriteProblem(400, "invalid-entry-id", invalid);
				const problems = readErrors(role);
				if (problems.length) throw unreadable(problems);
				if (!value || typeof value !== "object" || Array.isArray(value)) throw new WriteProblem(400, "rejected", "条目需要对象");
				const payload = { ...value };
				for (const key of [
					"source",
					"routeNote",
					"launchable",
					"reason"
				]) delete payload[key];
				const previous = current.entries[role]?.entry;
				if (previous?.backgroundMode && !Object.hasOwn(payload, "backgroundMode")) payload.backgroundMode = previous.backgroundMode;
				if (single && body.clearToolFilter === true) delete payload.toolFilter;
				else if (single && previous?.toolFilter !== void 0 && !Object.hasOwn(payload, "toolFilter")) payload.toolFilter = previous.toolFilter;
				let parsed;
				try {
					parsed = parseEntryDocument(payload);
				} catch (error) {
					throw new WriteProblem(400, "rejected", `条目 "${role}"：${String(error)}`);
				}
				if (previous?.toolFilter !== void 0 && !(single && body.clearToolFilter === true) && !isDeepStrictEqual(previous.toolFilter, parsed.entry.toolFilter)) throw new WriteProblem(409, "tool-filter-protected", `角色 "${role}" 的工具限制需要单独确认移除。`);
				if (!single && opened.profileProblem && !sameRoute(pickRoute(parsed.entry), pickRoute(opened.view.entries[role]?.entry ?? {}))) throw new WriteProblem(400, "profile-path", opened.profileProblem);
				documents.set(role, parsed);
			}
			for (const [role, doc] of documents) {
				const prev = current.entries[role];
				let shared = single || opened.profile !== void 0 ? preserveSharedRoute(doc.entry, prev?.entry) : doc.entry;
				if (!opened.profile && route !== void 0) shared = "inherit" in route ? stripRoute(doc.entry) : withRoute(doc.entry, route);
				if (prev?.source === "file" && prev.file === entryFileName(role) && serializeEntry(prev.entry, prev.enabled) === serializeEntry(shared, doc.enabled)) try {
					await removeYmlSibling(current.dir, role, fs);
				} catch (error) {
					warnings.push(`条目 "${role}" 的同名 .yml 残留清除失败：${String(error)}`);
				}
				else await writeEntryFile({
					dir: current.dir,
					id: role,
					entry: shared,
					enabled: doc.enabled,
					fs
				});
				if (doc.entry.toolFilter !== void 0) warnings.push(`条目 "${role}" 带 toolFilter，当前宿主无法强制执行逐条目工具过滤。`);
				if (opened.profile && !opened.profileProblem) {
					if (single && route !== void 0) await writeRouteOverlay(current.dir, opened.profile, role, route, fs, void 0, routeBinding(shared));
					else if (!single) await syncProfileRoute({
						dir: current.dir,
						profile: opened.profile,
						id: role,
						client: doc.entry,
						shown: opened.view.entries[role]?.entry ?? { description: doc.entry.description },
						shared,
						fs
					});
				}
			}
			return {
				skipped: await deleteRoles(deletedIds),
				warnings
			};
		};
		wctx.effect(() => web.register({
			kind: "exact",
			path: "/subagent-library/api",
			handler: async (req, res) => {
				if (req.method === "GET") {
					if (settingsFailure !== void 0) {
						sendJson(res, 503, {
							ok: false,
							error: "not-ready",
							message: settingsFailure
						});
						return;
					}
					try {
						sendJson(res, 200, wireView(await loadEffective()));
					} catch (error) {
						sendJson(res, 500, {
							ok: false,
							error: "roster-unreadable",
							message: String(error)
						});
					}
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, {
						ok: false,
						error: "method-not-allowed"
					});
					return;
				}
				if (!guardWrite(req, res)) return;
				if (settingsFailure !== void 0) {
					sendJson(res, 503, {
						ok: false,
						error: "not-ready",
						message: settingsFailure
					});
					return;
				}
				const read = await readJsonBody(req);
				if (!read.ok) {
					if (read.error === "too-large") sendJson(res, 413, {
						ok: false,
						error: "body-too-large"
					});
					else sendJson(res, 400, {
						ok: false,
						error: "bad-json"
					});
					return;
				}
				const body = read.body;
				const expectedHash = typeof body.expectedHash === "string" ? body.expectedHash : void 0;
				if ([
					"save-entry",
					"save-group",
					"delete-group"
				].includes(String(body.op)) && !expectedHash) {
					sendJson(res, 400, {
						ok: false,
						error: "expected-hash-required"
					});
					return;
				}
				let response;
				let status = 200;
				const config$1 = { ...resolveConfig() };
				const dir = resolveEntriesDir(config$1.entriesDir);
				const latestConfig = () => {
					const latest = resolveConfig();
					return resolveEntriesDir(latest.entriesDir) === dir ? latest : config$1;
				};
				try {
					const unlock = await lockRoster(dir, fsPort());
					try {
						const opened = await readEffective(body.op === "clear-legacy" && expectedHash === void 0, latestConfig(), dir);
						if (expectedHash !== void 0 && expectedHash !== opened.view.hash) throw new WriteProblem(409, "conflict", "名册已变更，请核对最新内容。");
						const result = await applyWrite(body, opened);
						response = wireView(await readEffective(true, latestConfig(), dir), result.skipped, result.warnings);
					} finally {
						await unlock();
					}
				} catch (error) {
					const busy = error.code === "ROSTER_BUSY";
					status = error instanceof WriteProblem ? error.status : busy ? 503 : 500;
					const code = error instanceof WriteProblem ? error.code : busy ? "roster-busy" : "write-failed";
					const view = await readEffective(false, latestConfig(), dir).then(wireView).catch(() => void 0);
					response = {
						ok: false,
						error: code,
						message: String(error),
						...error instanceof WriteProblem && error.details,
						view
					};
				}
				sendJson(res, status, response);
			}
		}), "subagent-library: settings api route");
	});
	registerLibraryTools(ctx, loadEffective, routeNoteText, () => settingsFailure);
}

//#endregion
export { Config, apply, inject, name };
//# sourceMappingURL=index.js.map