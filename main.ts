import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	TAbstractFile,
	normalizePath,
	requestUrl,
	FuzzySuggestModal,
	EditorSuggest,
} from "obsidian";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface HotkeyDef {
	modifiers: string[]; // e.g. ["Ctrl","Shift"]
	key: string;         // e.g. "P"
}

interface CategorySuggestion {
	name: string;
	isNew: boolean;
}

interface WPPublisherSettings {
	wpUrl: string;
	wpUsername: string;
	wpPassword: string;
	showSidebarButton: boolean;
	defaultTemplatePath: string;
	publishFolder: string;    // required folder path for publishable notes
	wpCategories: string;
	autoCreateCategories: boolean;
	wpCategoriesLastRefreshedAt: number;
	wpCategoriesLastSource: "manual" | "wordpress";
	wpCategoriesLastWordPressSnapshot: string;
	wpCategoriesLastMessage: string;
	wpIdCache: Record<string, string>;
	wpContentHashCache: Record<string, string>;
	wpSyncMigrationVersion: number;
	autoApplyTemplateOnNewNotes: boolean;
	syncOnSave: boolean;
	hotkeyPublish: HotkeyDef | null;
	hotkeyDraft: HotkeyDef | null;
}

const DEFAULT_SETTINGS: WPPublisherSettings = {
	wpUrl: "",
	wpUsername: "",
	wpPassword: "",
	showSidebarButton: true,
	defaultTemplatePath: "",
	publishFolder: "",
	wpCategories: "Blog\nNews\nProjects\nTo Do List\nUncategorized\nWrite Ups",
	autoCreateCategories: true,
	wpCategoriesLastRefreshedAt: 0,
	wpCategoriesLastSource: "manual",
	wpCategoriesLastWordPressSnapshot: "",
	wpCategoriesLastMessage: "",
	wpIdCache: {},
	wpContentHashCache: {},
	wpSyncMigrationVersion: 0,
	autoApplyTemplateOnNewNotes: true,
	syncOnSave: true,
	hotkeyPublish: null,
	hotkeyDraft: null,
};

const WP_PUBLISHER_VERSION = "1.0.4";
const DEFAULT_WP_POST_TEMPLATE = `---
category: 
excerpt: 
status: draft
comments: off
wp-id: 
wp-sync: 
---
`;

function categoryNamesFromSettings(s: WPPublisherSettings): string[] {
	return s.wpCategories
		.split(/[\n,]/)
		.map(c => c.trim())
		.filter(Boolean);
}

function canonicalCategoryName(s: WPPublisherSettings, name: string): string {
	const match = categoryNamesFromSettings(s).find(c => c.toLowerCase() === name.toLowerCase());
	return match || name;
}

function unknownCategoryNames(s: WPPublisherSettings, names: string[]): string[] {
	const known = categoryNamesFromSettings(s).map(c => c.toLowerCase());
	return names.filter(name => !known.includes(name.toLowerCase()));
}

function mergeCategoryNames(existing: string[], incoming: string[]): string[] {
	return Array.from(new Map(
		[...existing, ...incoming]
			.map(c => c.trim())
			.filter(Boolean)
			.map(c => [c.toLowerCase(), c])
	).values()).sort((a, b) => a.localeCompare(b));
}

function normalizedCategorySnapshot(value: string | string[]): string {
	const categories = Array.isArray(value) ? value : value.split(/[\n,]/);
	return mergeCategoryNames([], categories).join("\n");
}

function formatRelativeRefreshTime(timestamp: number): string {
	if (!timestamp) return "never";
	const diffMs = Math.max(0, Date.now() - timestamp);
	const diffMinutes = Math.floor(diffMs / 60000);
	if (diffMinutes < 1) return "just now";
	if (diffMinutes === 1) return "1 minute ago";
	if (diffMinutes < 60) return `${diffMinutes} minutes ago`;
	const diffHours = Math.floor(diffMinutes / 60);
	if (diffHours === 1) return "1 hour ago";
	if (diffHours < 24) return `${diffHours} hours ago`;
	const diffDays = Math.floor(diffHours / 24);
	if (diffDays === 1) return "1 day ago";
	return `${diffDays} days ago`;
}

function yamlQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function buildDefaultTemplate(s: WPPublisherSettings): string {
	const categories = categoryNamesFromSettings(s);
	const categoryReference = categories.length
		? `%% Categories: ${categories.join(" · ")} %%\n\n`
		: "";
	return `${DEFAULT_WP_POST_TEMPLATE}${categoryReference}%%
Ctrl + Alt + D = Draft
Ctrl + Shift + P = Publish
%%
`;
}

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

async function flushPendingObsidianPropertyEdit() {
	const active = document.activeElement;
	if (active instanceof HTMLElement) {
		active.dispatchEvent(new Event("input", { bubbles: true }));
		active.dispatchEvent(new Event("change", { bubbles: true }));
		active.blur();
		await wait(250);
	}
}

// ─────────────────────────────────────────────
// Hotkey helpers
// ─────────────────────────────────────────────

function hotkeyLabel(hk: HotkeyDef | null): string {
	if (!hk) return "Not set";
	const parts = [...hk.modifiers, hk.key];
	return parts.join(" + ");
}

/** Build a display string from a raw KeyboardEvent, e.g. "Ctrl + Shift + P" */
function eventToHotkey(e: KeyboardEvent): HotkeyDef | null {
	// Ignore bare modifier keypresses
	if (["Control","Shift","Alt","Meta"].includes(e.key)) return null;

	const modifiers: string[] = [];
	if (e.ctrlKey)  modifiers.push("Ctrl");
	if (e.altKey)   modifiers.push("Alt");
	if (e.shiftKey) modifiers.push("Shift");
	if (e.metaKey)  modifiers.push("Meta");

	// Require at least one modifier so we don't steal plain typing
	if (modifiers.length === 0) return null;

	const key = e.key.length === 1 ? e.key.toUpperCase() : e.key;
	return { modifiers, key };
}

// ─────────────────────────────────────────────
// Markdown → HTML
// ─────────────────────────────────────────────

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

function mdToHtml(md: string): string {
	// Match the original Python script behavior: strip Obsidian comments before publishing.
	md = md.replace(/%%[\s\S]*?%%/g, "").trim();

	const lines = md.split("\n");
	const htmlLines: string[] = [];
	let inUl = false;
	let inOl = false;
	let inCodeBlock = false;
	let codeLang = "";
	let codeBuffer: string[] = [];

	const closeLists = () => {
		if (inUl) { htmlLines.push("</ul>"); inUl = false; }
		if (inOl) { htmlLines.push("</ol>"); inOl = false; }
	};

	const youtubeEmbed = (url: string): string | null => {
		const match = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([A-Za-z0-9_-]+)/);
		return match ? `<div class="wp-embed-responsive"><iframe src="https://www.youtube.com/embed/${match[1]}" frameborder="0" allowfullscreen></iframe></div>` : null;
	};

	const vimeoEmbed = (url: string): string | null => {
		const match = url.match(/vimeo\.com\/(\d+)/);
		return match ? `<div class="wp-embed-responsive"><iframe src="https://player.vimeo.com/video/${match[1]}" frameborder="0" allowfullscreen></iframe></div>` : null;
	};

	const videoEmbed = (url: string): string | null => youtubeEmbed(url) ?? vimeoEmbed(url);

	const inline = (text: string): string => {
		text = text.replace(/!\[([^\]]*)\]\((https?:\/\/(?:www\.)?(?:youtube\.com\/watch\S+|youtu\.be\/\S+|vimeo\.com\/\S+))\)/gi, (_m, _alt, url) => videoEmbed(url) ?? _m);
		text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');
		text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
		text = text.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, target, alias) => alias ? alias : target);
		text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
		text = text.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
		text = text.replace(/__(.+?)__/g, "<strong>$1</strong>");
		text = text.replace(/\*(.+?)\*/g, "<em>$1</em>");
		text = text.replace(/_(.+?)_/g, "<em>$1</em>");
		text = text.replace(/`([^`]+)`/g, "<code>$1</code>");
		text = text.replace(/~~(.+?)~~/g, "<del>$1</del>");
		return text;
	};

	for (const rawLine of lines) {
		const line = rawLine.trimEnd();

		if (line.startsWith("```")) {
			if (!inCodeBlock) {
				closeLists();
				inCodeBlock = true;
				codeLang = line.slice(3).trim();
				codeBuffer = [];
			} else {
				inCodeBlock = false;
				htmlLines.push(`<pre><code class="language-${codeLang}">${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
			}
			continue;
		}

		if (inCodeBlock) { codeBuffer.push(rawLine); continue; }

		const trimmed = line.trim();
		if (!trimmed) { closeLists(); htmlLines.push(""); continue; }

		const embed = videoEmbed(trimmed);
		if (embed) { closeLists(); htmlLines.push(embed); continue; }

		if (/^(?:---|\*\*\*|___)\s*$/.test(trimmed)) { closeLists(); htmlLines.push("<hr>"); continue; }

		const heading = line.match(/^(#{1,6})\s+(.+)$/);
		if (heading) {
			closeLists();
			const level = heading[1].length;
			htmlLines.push(`<h${level}>${inline(heading[2])}</h${level}>`);
			continue;
		}

		const quote = line.match(/^>\s(.+)$/);
		if (quote) { closeLists(); htmlLines.push(`<blockquote>${inline(quote[1])}</blockquote>`); continue; }

		const ul = line.match(/^[-*+]\s(.+)$/);
		if (ul) {
			if (inOl) { htmlLines.push("</ol>"); inOl = false; }
			if (!inUl) { htmlLines.push("<ul>"); inUl = true; }
			htmlLines.push(`<li>${inline(ul[1])}</li>`);
			continue;
		}

		const ol = line.match(/^\d+\.\s(.+)$/);
		if (ol) {
			if (inUl) { htmlLines.push("</ul>"); inUl = false; }
			if (!inOl) { htmlLines.push("<ol>"); inOl = true; }
			htmlLines.push(`<li>${inline(ol[1])}</li>`);
			continue;
		}

		closeLists();
		htmlLines.push(`<p>${inline(trimmed)}</p>`);
	}

	if (inCodeBlock) htmlLines.push(`<pre><code class="language-${codeLang}">${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
	closeLists();
	return htmlLines.join("\n").trim();
}

// ─────────────────────────────────────────────
// Frontmatter helpers
// ─────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	const match = content.match(/^---\n([\s\S]*?)\n---/);
	if (!match) return result;
	let currentListKey = "";
	for (const line of match[1].split("\n")) {
		const listItem = line.match(/^\s*-\s+(.+)$/);
		if (listItem && currentListKey) {
			const value = listItem[1].trim().replace(/^["']|["']$/g, "");
			result[currentListKey] = result[currentListKey] ? `${result[currentListKey]}, ${value}` : value;
			continue;
		}
		const idx = line.indexOf(":");
		if (idx === -1) {
			currentListKey = "";
			continue;
		}
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
		currentListKey = key && !value ? key : "";
		if (/^\[.*\]$/.test(value)) {
			value = value.slice(1, -1)
				.split(",")
				.map(v => v.trim().replace(/^["']|["']$/g, ""))
				.filter(Boolean)
				.join(", ");
		}
		if (key && value) result[key] = value;
	}
	return result;
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function stripPrivateComments(content: string): string {
	return content.replace(/%%[\s\S]*?%%/g, "");
}

function hashString(value: string): string {
	let hash = 5381;
	for (let i = 0; i < value.length; i++) {
		hash = ((hash << 5) + hash) ^ value.charCodeAt(i);
	}
	return (hash >>> 0).toString(16);
}

function postContentFingerprint(content: string): string {
	const fm = parseFrontmatter(content);
	const body = stripPrivateComments(stripFrontmatter(content)).trim();
	const meaningfulFrontmatter = [
		"title",
		"category",
		"categories",
		"excerpt",
		"comments",
		"comment_status",
	]
		.map(key => `${key}:${(fm[key] || "").trim()}`)
		.join("\n");
	return hashString(`${meaningfulFrontmatter}\n---\n${body}`);
}

function getCommentStatus(fm: Record<string, string>): "open" | "closed" | null {
	const raw = (fm["comments"] || fm["comment_status"] || "").trim().toLowerCase();
	if (!raw) return null;
	if (["on", "open", "enable", "enabled", "yes", "true", "allow", "allowed"].includes(raw)) return "open";
	if (["off", "closed", "close", "disable", "disabled", "no", "false", "deny", "denied"].includes(raw)) return "closed";
	return null;
}

async function setFrontmatterKey(app: App, file: TFile, key: string, value: string) {
	let content = await app.vault.read(file);
	const originalContent = content;
	const hasFM = /^---\n/.test(content);
	if (hasFM) {
		const fmEnd = content.indexOf("\n---", 4);
		if (fmEnd === -1) return;
		const fmBlock = content.slice(0, fmEnd);
		const rest = content.slice(fmEnd);
		// Always emit valid YAML with one space after the colon. A replacement
		// function also avoids numeric values being interpreted as capture groups.
		const keyRegex = new RegExp(`^${key}:[\\t ]*(.*)$`, "m");
		if (keyRegex.test(fmBlock)) {
			content = fmBlock.replace(keyRegex, () => `${key}: ${value}`) + rest;
		} else {
			content = fmBlock + `\n${key}: ${value}` + rest;
		}
	} else {
		content = `---\n${key}: ${value}\n---\n${content}`;
	}
	// Avoid the status-sync modify loop when the value is already current.
	if (content !== originalContent) await app.vault.modify(file, content);
}

async function deleteFrontmatterKey(app: App, file: TFile, key: string) {
	let content = await app.vault.read(file);
	const originalContent = content;
	const hasFM = /^---\n/.test(content);
	if (!hasFM) return;
	const fmEnd = content.indexOf("\n---", 4);
	if (fmEnd === -1) return;
	const fmBlock = content.slice(0, fmEnd);
	const rest = content.slice(fmEnd);
	const lines = fmBlock.split("\n");
	const filtered = lines.filter(line => {
		const trimmed = line.trim();
		return trimmed !== `${key}:` && !trimmed.startsWith(`${key}: `);
	});
	content = filtered.join("\n") + rest;
	if (content !== originalContent) await app.vault.modify(file, content);
}

// ─────────────────────────────────────────────
// WordPress REST helpers
// ─────────────────────────────────────────────

interface WPPost { id: number; status: string; link: string; }
interface WPCurrentUser { id: number; name?: string; slug?: string; username?: string; }

function basicAuth(u: string, p: string) { return "Basic " + btoa(`${u}:${p}`); }

function normalizeWpIdentity(value: string): string {
	return value.trim().toLowerCase();
}

function wpUserMatchesConfiguredUsername(user: WPCurrentUser, configuredUsername: string): boolean {
	const expected = normalizeWpIdentity(configuredUsername);
	return [user.username, user.slug, user.name]
		.filter(Boolean)
		.some(value => normalizeWpIdentity(String(value)) === expected);
}

async function testWordPressConnection(s: WPPublisherSettings): Promise<WPCurrentUser> {
	const base = s.wpUrl.replace(/\/$/, "");
	const resp = await requestUrl({
		url: `${base}/wp-json/wp/v2/users/me?context=edit`,
		method: "GET",
		headers: { Authorization: basicAuth(s.wpUsername, s.wpPassword) },
		throw: false,
	});
	if (resp.status >= 400) {
		let msg = `HTTP ${resp.status}`;
		try { const e = resp.json; if (e?.message) msg = e.message; else if (e?.code) msg = e.code; } catch { /**/ }
		throw new Error(msg);
	}
	const user = resp.json as WPCurrentUser;
	if (!user?.id) throw new Error("WordPress did not return an authenticated user.");
	if (!wpUserMatchesConfiguredUsername(user, s.wpUsername)) {
		const actual = user.username || user.slug || user.name || `user #${user.id}`;
		throw new Error(`Authenticated as "${actual}", not "${s.wpUsername}". Check the WordPress username.`);
	}
	return user;
}

async function wpRequest(
	s: WPPublisherSettings,
	method: string,
	endpoint: string,
	body?: Record<string, unknown>
): Promise<WPPost> {
	const url = `${s.wpUrl.replace(/\/$/, "")}/wp-json/wp/v2/${endpoint}`;
	const resp = await requestUrl({
		url, method,
		headers: {
			Authorization: basicAuth(s.wpUsername, s.wpPassword),
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
		throw: false,
	});
	if (resp.status >= 400) {
		let msg = `HTTP ${resp.status}`;
		try { const e = resp.json; if (e?.message) msg = e.message; else if (e?.code) msg = e.code; } catch { /**/ }
		throw new Error(msg);
	}
	return resp.json as WPPost;
}

async function findCategoryId(s: WPPublisherSettings, name: string): Promise<number | null> {
	const base = s.wpUrl.replace(/\/$/, "");
	const sr = await requestUrl({
		url: `${base}/wp-json/wp/v2/categories?search=${encodeURIComponent(name)}&per_page=10`,
		method: "GET",
		headers: { Authorization: basicAuth(s.wpUsername, s.wpPassword) },
		throw: false,
	});
	if (sr.status === 200) {
		const cats = sr.json as Array<{ id: number; name: string }>;
		const match = cats.find(c => c.name.toLowerCase() === name.toLowerCase());
		if (match) return match.id;
	}
	return null;
}

async function resolveCategory(s: WPPublisherSettings, name: string): Promise<number> {
	const base = s.wpUrl.replace(/\/$/, "");
	const existingId = await findCategoryId(s, name);
	if (existingId) return existingId;
	const cr = await requestUrl({
		url: `${base}/wp-json/wp/v2/categories`,
		method: "POST",
		headers: { Authorization: basicAuth(s.wpUsername, s.wpPassword), "Content-Type": "application/json" },
		body: JSON.stringify({ name }),
		throw: false,
	});
	if (cr.status >= 400) throw new Error(`Could not create category "${name}"`);
	return (cr.json as { id: number }).id;
}

function categoryNamesFromFrontmatter(fm: Record<string, string>): string[] {
	const raw = (fm["category"] || fm["categories"] || "").trim();
	if (!raw) return [];
	return raw.split(",").map(c => c.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

async function resolveCategories(s: WPPublisherSettings, fm: Record<string, string>, createMissingCategories = true): Promise<number[] | undefined> {
	const names = categoryNamesFromFrontmatter(fm);
	// Same behavior as the Python version/readme: a blank category lets WordPress use Uncategorized.
	if (names.length === 0) return undefined;
	const ids: number[] = [];
	for (const name of names) {
		const canonical = canonicalCategoryName(s, name);
		if (createMissingCategories) {
			ids.push(await resolveCategory(s, canonical));
		} else {
			const existingId = await findCategoryId(s, canonical);
			if (existingId) ids.push(existingId);
		}
	}
	return ids;
}

async function fetchWordPressCategoryNames(s: WPPublisherSettings): Promise<string[]> {
	const base = s.wpUrl.replace(/\/$/, "");
	const names: string[] = [];
	for (let page = 1; page <= 20; page++) {
		const resp = await requestUrl({
			url: `${base}/wp-json/wp/v2/categories?per_page=100&hide_empty=false&_fields=name&page=${page}`,
			method: "GET",
			headers: { Authorization: basicAuth(s.wpUsername, s.wpPassword) },
			throw: false,
		});
		if (resp.status === 400 && page > 1) break;
		if (resp.status >= 400) {
			let msg = `HTTP ${resp.status}`;
			try {
				const e = resp.json;
				if (e?.message) msg = e.message;
				else if (e?.code) msg = e.code;
			} catch { /**/ }
			throw new Error(`Could not load categories (${msg})`);
		}
		const cats = Array.isArray(resp.json) ? resp.json as Array<{ name: string }> : [];
		names.push(...cats.map(c => c.name).filter(Boolean));
		if (cats.length < 100) break;
	}
	return mergeCategoryNames([], names);
}

async function findExistingPostByTitle(s: WPPublisherSettings, title: string): Promise<number | null> {
	const base = s.wpUrl.replace(/\/$/, "");
	const resp = await requestUrl({
		url: `${base}/wp-json/wp/v2/posts?search=${encodeURIComponent(title)}&per_page=10&status=any`,
		method: "GET",
		headers: { Authorization: basicAuth(s.wpUsername, s.wpPassword) },
		throw: false,
	});
	if (resp.status >= 400) return null;
	const posts = resp.json as Array<{ id: number; title?: { rendered?: string } }>;
	const match = posts.find(p => (p.title?.rendered ?? "").replace(/<[^>]+>/g, "").trim().toLowerCase() === title.trim().toLowerCase());
	return match?.id ?? null;
}

async function uploadImage(s: WPPublisherSettings, app: App, filePath: string): Promise<string> {
	const base = s.wpUrl.replace(/\/$/, "");
	const file = app.vault.getAbstractFileByPath(filePath);
	if (!(file instanceof TFile)) throw new Error(`Image not found: ${filePath}`);
	const binary = await app.vault.readBinary(file);
	const ext = file.extension.toLowerCase();
	const mimeMap: Record<string, string> = {
		jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
		gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
	};
	const mime = mimeMap[ext] ?? "application/octet-stream";
	const res = await requestUrl({
		url: `${base}/wp-json/wp/v2/media`,
		method: "POST",
		headers: {
			Authorization: basicAuth(s.wpUsername, s.wpPassword),
			"Content-Type": mime,
			"Content-Disposition": `attachment; filename="${file.name}"`,
		},
		body: binary, throw: false,
	});
	if (res.status >= 400) throw new Error(`Image upload failed for ${file.name}`);
	return (res.json as { source_url: string }).source_url;
}

async function processImages(app: App, s: WPPublisherSettings, html: string, sourceFile: TFile): Promise<string> {
	const matches = [...html.matchAll(/src="([^"]+)"/g)];
	for (const match of matches) {
		const src = match[1];
		if (/^https?:\/\//.test(src)) continue;
		const resolved = normalizePath(sourceFile.parent ? `${sourceFile.parent.path}/${src}` : src);
		try { html = html.replace(`src="${src}"`, `src="${await uploadImage(s, app, resolved)}"`); } catch { /**/ }
	}
	const wikiMatches = [...html.matchAll(/!\[\[([^\]]+\.(png|jpe?g|gif|webp|svg))\]\]/gi)];
	for (const match of wikiMatches) {
		const fileName = match[1];
		const found = app.vault.getFiles().find(f => f.name === fileName || f.path === fileName);
		if (!found) continue;
		try {
			const remoteUrl = await uploadImage(s, app, found.path);
			html = html.replace(match[0], `<img src="${remoteUrl}" alt="${fileName}">`);
		} catch { /**/ }
	}
	return html;
}

// ─────────────────────────────────────────────
// Folder picker modal
// ─────────────────────────────────────────────

class FolderSuggestModal extends FuzzySuggestModal<TFolder> {
	onChoose: (folder: TFolder) => void;

	constructor(app: App, onChoose: (folder: TFolder) => void) {
		super(app);
		this.onChoose = onChoose;
	}

	getItems(): TFolder[] {
		// Collect every folder in the vault
		const folders: TFolder[] = [];
		const recurse = (folder: TFolder) => {
			folders.push(folder);
			for (const child of folder.children) {
				if (child instanceof TFolder) recurse(child);
			}
		};
		recurse(this.app.vault.getRoot());
		return folders;
	}

	getItemText(folder: TFolder): string {
		return folder.path === "/" ? "(Vault root)" : folder.path;
	}

	onChooseItem(folder: TFolder): void {
		this.onChoose(folder);
	}
}

// ─────────────────────────────────────────────
// Note picker modal (for template selection)
// ─────────────────────────────────────────────

class FileSuggestModal extends FuzzySuggestModal<TFile> {
	onChoose: (file: TFile) => void;

	constructor(app: App, onChoose: (file: TFile) => void) {
		super(app);
		this.onChoose = onChoose;
	}

	getItems(): TFile[] {
		return this.app.vault.getMarkdownFiles();
	}

	getItemText(file: TFile): string {
		return file.path;
	}

	onChooseItem(file: TFile): void {
		this.onChoose(file);
	}
}

// ─────────────────────────────────────────────
// New-note name modal
// ─────────────────────────────────────────────

class NewNoteModal extends Modal {
	onSubmit: (name: string) => void;
	suggestedName: string;
	inputEl!: HTMLInputElement;

	constructor(app: App, onSubmit: (name: string) => void, suggestedName = "Site Post") {
		super(app);
		this.onSubmit = onSubmit;
		this.suggestedName = suggestedName;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "New note from WP template" });
		const wrap = contentEl.createDiv();
		wrap.createEl("label", { text: "Note name:" });
		this.inputEl = wrap.createEl("input", { type: "text", placeholder: "Site Post" });
		this.inputEl.value = this.suggestedName;
		this.inputEl.style.cssText = "width:100%;margin-top:8px;padding:6px;font-size:14px;";

		const btns = contentEl.createDiv();
		btns.style.cssText = "display:flex;gap:8px;margin-top:16px;justify-content:flex-end;";
		btns.createEl("button", { text: "Cancel" }).onclick = () => this.close();
		const ok = btns.createEl("button", { text: "Create note", cls: "mod-cta" });
		ok.onclick = () => { this.onSubmit(this.inputEl.value); this.close(); };
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter") { this.onSubmit(this.inputEl.value); this.close(); }
		});
		this.inputEl.focus();
	}

	onClose() { this.contentEl.empty(); }
}

// ─────────────────────────────────────────────
// Category editor suggestions
// ─────────────────────────────────────────────

class CategoryEditorSuggest extends EditorSuggest<CategorySuggestion> {
	plugin: WPPublisherPlugin;

	constructor(app: App, plugin: WPPublisherPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onTrigger(cursor: any, editor: Editor): any {
		const line = editor.getLine(cursor.line);
		const beforeCursor = line.slice(0, cursor.ch);
		const match = beforeCursor.match(/^(\s*categories?\s*:\s*)(.*)$/i);
		if (!match) return null;

		const valueBefore = match[2];
		const tokenStart = valueBefore.lastIndexOf(",") + 1;
		const token = valueBefore.slice(tokenStart);
		const leadingSpaces = token.match(/^\s*/)?.[0].length ?? 0;
		const query = token.trimStart();
		const startCh = match[1].length + tokenStart + leadingSpaces;

		return {
			start: { line: cursor.line, ch: startCh },
			end: cursor,
			query,
		};
	}

	getSuggestions(context: any): CategorySuggestion[] {
		const categories = categoryNamesFromSettings(this.plugin.settings);
		const query = (context.query || "").trim().toLowerCase();
		const matches = categories
			.filter(c => !query || c.toLowerCase().includes(query))
			.slice(0, 25)
			.map(name => ({ name, isNew: false }));

		if (query && !categories.some(c => c.toLowerCase() === query)) {
			matches.push({ name: context.query.trim(), isNew: true });
		}
		return matches;
	}

	renderSuggestion(value: CategorySuggestion, el: HTMLElement) {
		const row = el.createDiv();
		row.style.cssText = "display:flex;align-items:center;justify-content:space-between;gap:12px;";
		row.createSpan({ text: value.name });
		if (value.isNew) {
			const badge = row.createSpan({ text: "NEW" });
			badge.style.cssText = "font-size:10px;letter-spacing:0.04em;color:var(--text-accent);border:1px solid var(--text-accent);border-radius:4px;padding:1px 5px;";
			badge.title = "This category is not in Known categories. WordPress will create it on publish if it does not already exist.";
		}
	}

	selectSuggestion(value: CategorySuggestion) {
		const context = (this as any).context;
		if (!context) return;
		context.editor.replaceRange(value.name, context.start, context.end);
	}
}

// ─────────────────────────────────────────────
// Main Plugin
// ─────────────────────────────────────────────

export default class WPPublisherPlugin extends Plugin {
	settings!: WPPublisherSettings;
	private hotkeyCleanups: Array<() => void> = [];
	private internalWriteUntil: Record<string, number> = {};
	private pendingCategoryNoticeUntil: Record<string, number> = {};
	private pendingCategoryCreateTimers: Record<string, number> = {};
	settingsTab?: WPPublisherSettingTab;
	isRecordingHotkey = false;
	ribbonIconEl: HTMLElement | null = null;

	updateRibbonIcon() {
		this.ribbonIconEl?.remove();
		this.ribbonIconEl = null;
		if (!this.settings.showSidebarButton) return;
		this.ribbonIconEl = this.addRibbonIcon("upload-cloud", "Publish to WordPress", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) this.publishNote(view.file, "publish");
			else new Notice("Open a note first.");
		});
	}

	async onload() {
		await this.loadSettings();

		// Ribbon icon
		this.updateRibbonIcon();

		// Command: publish
		this.addCommand({
			id: "wp-publish",
			name: "Publish note to WordPress",
			editorCallback: (_e: Editor, view: MarkdownView) => {
				if (view.file) this.publishNote(view.file, "publish");
			},
		});

		// Command: draft
		this.addCommand({
			id: "wp-draft",
			name: "Save note as WordPress draft",
			editorCallback: (_e: Editor, view: MarkdownView) => {
				if (view.file) this.publishNote(view.file, "draft");
			},
		});

		// Command: revert
		this.addCommand({
			id: "wp-revert-draft",
			name: "Revert WordPress post to draft",
			editorCallback: (_e: Editor, view: MarkdownView) => {
				if (view.file) this.revertToDraft(view.file);
			},
		});

		// Command: new from template
		this.addCommand({
			id: "wp-new-from-template",
			name: "New note from WP-Publisher template",
			callback: () => this.newNoteFromTemplate(),
		});

		// Command: apply template to current note
		this.addCommand({
			id: "wp-apply-template",
			name: "Apply WP-Publisher template to current note",
			editorCallback: (_e: Editor, view: MarkdownView) => {
				if (view.file) this.applyTemplateToCurrentNote(view.file);
			},
		});

		this.addCommand({
			id: "wp-migrate-sync-fields",
			name: "Migrate published notes to WP sync tracking",
			callback: () => this.migrateWpSyncField(),
		});

		this.addCommand({
			id: "wp-clear-link",
			name: "Clear WordPress link from current note",
			editorCallback: async (_e: Editor, view: MarkdownView) => {
				if (!view.file) return;
				await this.forgetWpId(view.file);
				new Notice("WP-Publisher link cleared for this note.");
			},
		});

		// Register custom hotkeys from settings
		this.registerSavedHotkeys();

		// Category suggestions from Settings → WP-Publisher → Categories.
		this.registerEditorSuggest(new CategoryEditorSuggest(this.app, this));
		this.updateCategoryCacheNote().catch(e => console.warn("WP-Publisher category cache update failed", e));
		await this.migrateWpSyncField().catch(e => console.warn("WP-Publisher wp-sync migration failed", e));

		// Auto-sync on save
		this.registerEvent(
			this.app.vault.on("modify", async (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const path = normalizePath(file.path);
				const isInternalWrite = (this.internalWriteUntil[path] || 0) > Date.now();
				if (isInternalWrite) {
					return;
				}
				const content = await this.app.vault.read(file);
				const fm = parseFrontmatter(content);
				const wpId = await this.resolveWpId(file, fm);
				if (wpId) {
					const currentHash = postContentFingerprint(content);
					const lastSyncedHash = this.settings.wpContentHashCache[path]?.trim();
					const currentSyncState = (fm["wp-sync"] || "").trim().toLowerCase();
					if (!lastSyncedHash && currentSyncState === "synced") {
						this.settings.wpContentHashCache[path] = currentHash;
						await this.saveSettings();
						return;
					}
					const nextSyncState = lastSyncedHash && currentHash === lastSyncedHash ? "synced" : "out-of-sync";
					if (currentSyncState !== nextSyncState) {
						await this.setPluginFrontmatterKey(file, "wp-sync", nextSyncState);
					}
					this.schedulePendingCategoryCreation(file);
				}
				if (this.settings.syncOnSave && wpId) await this.syncStatus(file, wpId);
			})
		);

		// Auto-apply template to ordinary new blank notes created in the publish folder.
		// The explicit "New note from WP-Publisher template" command already creates
		// notes with content, so this handler skips non-empty files to avoid doubles.
		this.registerEvent(
			this.app.vault.on("create", async (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				await this.autoApplyTemplateToNewNote(file);
			})
		);

		this.settingsTab = new WPPublisherSettingTab(this.app, this);
		this.addSettingTab(this.settingsTab);
	}

	onunload() {
		for (const timer of Object.values(this.pendingCategoryCreateTimers)) window.clearTimeout(timer);
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	async addKnownCategories(names: string[], showNotice = true) {
		const merged = mergeCategoryNames(categoryNamesFromSettings(this.settings), names);
		if (merged.join("\n") === categoryNamesFromSettings(this.settings).join("\n")) return;
		this.settings.wpCategories = merged.join("\n");
		this.settings.wpCategoriesLastRefreshedAt = Date.now();
		this.settings.wpCategoriesLastSource = "wordpress";
		this.settings.wpCategoriesLastWordPressSnapshot = normalizedCategorySnapshot(merged);
		this.settings.wpCategoriesLastMessage = `Updated from WordPress: ${names.join(", ")}`;
		await this.saveSettings();
		await this.updateCategoryCacheNote();
		this.settingsTab?.refreshCategoryList();
		if (showNotice) new Notice(`Added to Known categories: ${names.join(", ")}`, 6000);
	}

	notifyPendingUnknownCategories(file: TFile, fm: Record<string, string>) {
		const unknownCategories = unknownCategoryNames(this.settings, categoryNamesFromFrontmatter(fm));
		if (unknownCategories.length === 0) return;
		const path = normalizePath(file.path);
		const now = Date.now();
		if ((this.pendingCategoryNoticeUntil[path] || 0) > now) return;
		this.pendingCategoryNoticeUntil[path] = now + 30000;
		const statusName = (fm["status"] || "unknown").trim() || "unknown";
		const message = this.settings.autoCreateCategories
			? `This post is currently ${statusName}, but this category has not been created yet: ${unknownCategories.join(", ")}. Publish or save as draft to create/update it in WordPress.`
			: `This post is currently ${statusName}, and this category is not in the list: ${unknownCategories.join(", ")}. Automatic category creation is off.`;
		new Notice(message, 12000);
	}

	schedulePendingCategoryCreation(file: TFile) {
		const path = normalizePath(file.path);
		if (this.pendingCategoryCreateTimers[path]) {
			window.clearTimeout(this.pendingCategoryCreateTimers[path]);
		}
		this.pendingCategoryCreateTimers[path] = window.setTimeout(() => {
			delete this.pendingCategoryCreateTimers[path];
			this.createMissingCategoriesForFile(file).catch(e => {
				console.warn("WP-Publisher category auto-create failed", e);
				new Notice(`Category auto-create failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
			});
		}, 1500);
	}

	async createMissingCategoriesForFile(file: TFile) {
		if (!this.settings.autoCreateCategories) return;
		const validErr = this.validateSettings();
		await flushPendingObsidianPropertyEdit();
		const content = await this.app.vault.read(file);
		const fm = parseFrontmatter(content);
		const wpId = await this.resolveWpId(file, fm);
		if (!wpId) return;
		const unknownCategories = unknownCategoryNames(this.settings, categoryNamesFromFrontmatter(fm));
		if (unknownCategories.length === 0) return;
		if (validErr) {
			this.notifyPendingUnknownCategories(file, fm);
			throw new Error(validErr);
		}
		for (const name of unknownCategories) {
			await resolveCategory(this.settings, name);
		}
		await this.addKnownCategories(unknownCategories, false);
		const statusName = (fm["status"] || "unknown").trim() || "unknown";
		new Notice(`Created/confirmed WordPress ${unknownCategories.length === 1 ? "category" : "categories"} for ${statusName} post: ${unknownCategories.join(", ")}`, 8000);
	}

	async setPluginFrontmatterKey(file: TFile, key: string, value: string) {
		const path = normalizePath(file.path);
		this.internalWriteUntil[path] = Date.now() + 1500;
		await setFrontmatterKey(this.app, file, key, value);
	}

	async migrateWpSyncField() {
		let updated = 0;
		const migrationVersion = this.settings.wpSyncMigrationVersion || 0;
		const firstMigration = migrationVersion < 1;
		const baselineMigration = migrationVersion < 3;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const path = normalizePath(file.path);
			const content = await this.app.vault.read(file);
			const fm = parseFrontmatter(content);
			const cachedId = this.settings.wpIdCache[path]?.trim();
			const frontmatterId = (fm["wp-id"] || "").trim();
			const syncMarker = (fm["wp-sync"] || "").trim();
			const wpId = frontmatterId || (syncMarker ? cachedId : "");
			if (!wpId) continue;
			if (!cachedId && frontmatterId) {
				this.settings.wpIdCache[path] = frontmatterId;
			}
			if (baselineMigration) {
				this.settings.wpContentHashCache[path] = postContentFingerprint(content);
			}
			if (cachedId && frontmatterId !== cachedId) {
				await this.setPluginFrontmatterKey(file, "wp-id", cachedId);
			}
			if (firstMigration || baselineMigration || !syncMarker) {
				await this.setPluginFrontmatterKey(file, "wp-sync", "synced");
			}
			updated++;
		}
		if (baselineMigration) {
			this.settings.wpSyncMigrationVersion = 3;
		}
		if (updated > 0) {
			await this.saveSettings();
			new Notice(`WP-Publisher migrated ${updated} published note${updated === 1 ? "" : "s"} to wp-sync tracking.`);
		} else if (baselineMigration) {
			await this.saveSettings();
		}
	}

	async resolveWpId(file: TFile, fm: Record<string, string>): Promise<string | null> {
		const path = normalizePath(file.path);
		const cached = this.settings.wpIdCache[path]?.trim();
		const fmId = (fm["wp-id"] || "").trim();
		const syncMarker = (fm["wp-sync"] || "").trim();
		if (cached) {
			if (!fmId && !syncMarker) return null;
			if (fmId !== cached) {
				await this.setPluginFrontmatterKey(file, "wp-id", cached);
			}
			return cached;
		}
		if (!fmId) return null;
		this.settings.wpIdCache[path] = fmId;
		await this.saveSettings();
		await this.setPluginFrontmatterKey(file, "wp-id", fmId);
		return fmId;
	}

	async storeWpId(file: TFile, wpId: string) {
		const path = normalizePath(file.path);
		this.settings.wpIdCache[path] = wpId;
		await this.saveSettings();
		await this.setPluginFrontmatterKey(file, "wp-id", wpId);
	}

	async storeSyncedContentHash(file: TFile, content: string) {
		const path = normalizePath(file.path);
		this.settings.wpContentHashCache[path] = postContentFingerprint(content);
		await this.saveSettings();
	}

	async forgetWpId(file: TFile) {
		const path = normalizePath(file.path);
		if (this.settings.wpIdCache[path]) {
			delete this.settings.wpIdCache[path];
			await this.saveSettings();
		}
		if (this.settings.wpContentHashCache[path]) {
			delete this.settings.wpContentHashCache[path];
			await this.saveSettings();
		}
		await deleteFrontmatterKey(this.app, file, "wp-id");
		await deleteFrontmatterKey(this.app, file, "wp-sync");
	}

	getNextSitePostPath(folder: string): string {
		const normalizedFolder = normalizePath(folder);
		const prefix = normalizedFolder && normalizedFolder !== "/" ? `${normalizedFolder}/` : "";
		let index = 1;
		while (true) {
			const baseName = `Site Post ${index}`;
			const path = normalizePath(`${prefix}${baseName}.md`);
			if (!this.app.vault.getAbstractFileByPath(path)) return path;
			index++;
		}
	}

	async ensureFolderPath(folderPath: string) {
		const normalized = normalizePath(folderPath);
		if (!normalized || normalized === "/") return;
		const parts = normalized.split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`Cannot create folder "${current}" because a file already exists there.`);
			await this.app.vault.createFolder(current);
		}
	}


	// ── Hotkeys registered from stored combos ──
	async updateCategoryCacheNote() {
		const names = Array.from(new Map(categoryNamesFromSettings(this.settings).map(c => [c.toLowerCase(), c])).values())
			.sort((a, b) => a.localeCompare(b));
		const templatePath = (this.settings.defaultTemplatePath || "").trim();
		const templateFolder = templatePath
			? templatePath.split("/").slice(0, -1).join("/")
			: "";
		const cacheFolder = templateFolder || (this.settings.publishFolder || "").trim() || "";
		const cachePath = normalizePath(`${cacheFolder ? `${cacheFolder}/` : ""}WP-Publisher Category Cache.md`);
		await this.ensureFolderPath(cachePath.split("/").slice(0, -1).join("/"));
		const yamlList = names.length
			? names.map(name => `  - "${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join("\n")
			: "[]";
		const categoryBlock = names.length ? `category:\n${yamlList}\ncategories:\n${yamlList}` : "category: []\ncategories: []";
		const content = `---\n${categoryBlock}\nwp-publisher-internal: category-cache\n---\n# WP-Publisher Category Cache\n\nThis note is maintained by WP-Publisher so Obsidian's native property dropdown can suggest known WordPress categories.\n\nEdit categories in Settings -> WP-Publisher -> Categories. You can ignore this note.\n`;
		for (const file of this.app.vault.getMarkdownFiles()) {
			const path = normalizePath(file.path);
			if (path === cachePath) continue;
			const current = await this.app.vault.read(file);
			if (current.includes("wp-publisher-internal: category-cache")) {
				await this.app.vault.delete(file);
			}
		}
		const existing = this.app.vault.getAbstractFileByPath(cachePath);
		if (existing instanceof TFile) {
			const current = await this.app.vault.read(existing);
			if (current !== content) await this.app.vault.modify(existing, content);
		} else if (!existing) {
			await this.app.vault.create(cachePath, content);
		}
	}

	registerSavedHotkeys() {
		for (const cleanup of this.hotkeyCleanups) cleanup();
		this.hotkeyCleanups = [];

		// Listen in the capture phase so Obsidian/browser-level shortcuts like
		// Ctrl+Shift+P do not swallow the event before WP-Publisher sees it.
		const tryHotkey = (hk: HotkeyDef | null, action: () => void) => {
			if (!hk) return;
			const handler = (e: KeyboardEvent) => {
				if (this.isRecordingHotkey) return;
				const pressed = eventToHotkey(e);
				if (!pressed) return;
				if (
					pressed.key === hk.key &&
					pressed.modifiers.length === hk.modifiers.length &&
					hk.modifiers.every(m => pressed.modifiers.includes(m))
				) {
					e.preventDefault();
					action();
				}
			};
			document.addEventListener("keydown", handler, true);
			this.hotkeyCleanups.push(() => document.removeEventListener("keydown", handler, true));
		};

		tryHotkey(this.settings.hotkeyPublish, () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) this.publishNote(view.file, "publish");
		});

		tryHotkey(this.settings.hotkeyDraft, () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) this.publishNote(view.file, "draft");
		});
	}

	// ── Validate settings ──
	validateSettings(): string | null {
		if (!this.settings.wpUrl) return "WordPress URL is not set. Go to Settings → WP-Publisher.";
		if (!this.settings.wpUsername) return "WordPress username is not set.";
		if (!this.settings.wpPassword) return "WordPress application password is not set.";
		try { new URL(this.settings.wpUrl); } catch {
			return "WordPress URL is invalid — include https://, e.g. https://mysite.com";
		}
		return null;
	}

	// ── Folder check ──
	publishFolderError(): string | null {
		const folder = this.settings.publishFolder.trim();
		if (!folder || folder === "/") return "Publish folder is not set. Go to Settings → WP-Publisher and choose a dedicated folder.";
		return null;
	}

	fileIsAllowed(file: TFile): boolean {
		const folder = this.settings.publishFolder.trim();
		if (!folder || folder === "/") return false;
		return file.path.startsWith(folder + "/") || file.parent?.path === folder;
	}

	// ── Publish / update ──
	async publishNote(file: TFile, desiredStatus: "publish" | "draft") {
		const err = this.validateSettings();
		if (err) { new Notice(`⛔ ${err}`, 8000); return; }
		const folderErr = this.publishFolderError();
		if (folderErr) { new Notice(`⛔ ${folderErr}`, 10000); return; }

		if (!this.fileIsAllowed(file)) {
			const folder = this.settings.publishFolder;
			new Notice(`⛔ This note is not in the publish folder:\n"${folder}"\n\nChange the folder in Settings → WP-Publisher, or move the note.`, 10000);
			return;
		}

		await flushPendingObsidianPropertyEdit();
		const content = await this.app.vault.read(file);
		const fm = parseFrontmatter(content);
		let html = mdToHtml(stripFrontmatter(content));

		try { html = await processImages(this.app, this.settings, html, file); } catch { /**/ }

		const title = fm["title"] || file.basename;
		const payload: Record<string, unknown> = {
			title,
			content: html,
			status: desiredStatus,
			excerpt: fm["excerpt"] || "",
		};
		const commentStatus = getCommentStatus(fm);
		if (commentStatus) payload["comment_status"] = commentStatus;

		const previousStatus = (fm["status"] || "").trim().toLowerCase();
		try {
			const unknownCategories = unknownCategoryNames(this.settings, categoryNamesFromFrontmatter(fm));
			if (unknownCategories.length > 0) {
				const message = this.settings.autoCreateCategories
					? `Not in Known categories; WordPress will create if missing: ${unknownCategories.join(", ")}`
					: `Not in Known categories and automatic category creation is off: ${unknownCategories.join(", ")}`;
				new Notice(message, 8000);
			}
			const categoryIds = await resolveCategories(this.settings, fm, this.settings.autoCreateCategories);
			if (categoryIds) payload["categories"] = categoryIds;

			const existingId = await this.resolveWpId(file, fm) || await findExistingPostByTitle(this.settings, title);
			let post: WPPost;
			if (existingId) {
				post = await wpRequest(this.settings, "POST", `posts/${existingId}`, payload);
				await this.storeWpId(file, String(post.id));
				const msg = desiredStatus === "draft"
					? (previousStatus === "publish" ? "Taken down to draft" : "Draft updated")
					: (previousStatus === "draft" ? "Published from draft" : "Post updated");
				new Notice(`✅ ${msg}: "${title}"`);
			} else {
				post = await wpRequest(this.settings, "POST", "posts", payload);
				await this.storeWpId(file, String(post.id));
				new Notice(desiredStatus === "publish" ? `✅ Published: "${title}"` : `✅ Saved as new draft: "${title}"`);
			}
			if (unknownCategories.length > 0 && this.settings.autoCreateCategories) {
				try {
					await this.addKnownCategories(unknownCategories);
				} catch (categoryUpdateError) {
					console.warn("WP-Publisher could not update Known categories after publish", categoryUpdateError);
					new Notice("Post succeeded, but WP-Publisher could not refresh Known categories. Reload or use Replace from WordPress.", 10000);
				}
			}
			await this.storeSyncedContentHash(file, content);
			await this.setPluginFrontmatterKey(file, "status", post.status);
			await this.setPluginFrontmatterKey(file, "wp-sync", "synced");
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			await this.setPluginFrontmatterKey(file, "status", "error");
			new Notice(`⛔ Publish failed: ${msg}`, 10000);
		}
	}

	// ── Revert to draft ──
	async revertToDraft(file: TFile) {
		const err = this.validateSettings();
		if (err) { new Notice(`⛔ ${err}`, 8000); return; }
		const folderErr = this.publishFolderError();
		if (folderErr) { new Notice(`⛔ ${folderErr}`, 10000); return; }
		if (!this.fileIsAllowed(file)) {
			const folder = this.settings.publishFolder;
			new Notice(`⛔ This note is not in the publish folder:\n"${folder}"\n\nChange the folder in Settings → WP-Publisher, or move the note.`, 10000);
			return;
		}
		const content = await this.app.vault.read(file);
		const fm = parseFrontmatter(content);
		const wpId = await this.resolveWpId(file, fm);
		if (!wpId) { new Notice("⛔ This note hasn't been published yet (no wp-id)."); return; }
		try {
			await wpRequest(this.settings, "POST", `posts/${wpId}`, { status: "draft" });
			await this.setPluginFrontmatterKey(file, "status", "draft");
			new Notice(`✅ Reverted to draft: "${fm["title"] || file.basename}"`);
		} catch (e: unknown) {
			new Notice(`⛔ Revert failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

	// ── Sync on save ──
	async syncStatus(file: TFile, wpId: string) {
		try {
			const post = await wpRequest(this.settings, "GET", `posts/${wpId}`);
			await this.setPluginFrontmatterKey(file, "status", post.status);
		} catch { /**/ }
	}

	// ── Template helpers ──
	async getTemplateContent(): Promise<string> {
		const templatePath = this.settings.defaultTemplatePath.trim();
		if (!templatePath) return buildDefaultTemplate(this.settings);
		const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(templatePath));
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template note not found: "${templatePath}". Check the path in Settings → WP-Publisher.`);
		}
		return await this.app.vault.read(templateFile);
	}

	// ── New note from template ──
	async newNoteFromTemplate() {
		const folderErr = this.publishFolderError();
		if (folderErr) { new Notice(`⛔ ${folderErr}`, 10000); return; }

		let templateContent: string;
		try {
			templateContent = await this.getTemplateContent();
		} catch (e: unknown) {
			new Notice(`⛔ ${e instanceof Error ? e.message : String(e)}`, 10000);
			return;
		}

		const folder = this.settings.publishFolder.trim();
		const suggestedName = this.getNextSitePostPath(folder).split("/").pop()?.replace(/\.md$/i, "") || "Site Post";

		new NewNoteModal(this.app, async (noteName: string) => {
			if (!noteName.trim()) { new Notice("Note name cannot be empty."); return; }

			const fileName = noteName.endsWith(".md") ? noteName : `${noteName}.md`;
			const newPath = normalizePath(`${folder}/${fileName}`);

			try {
				const newFile = await this.app.vault.create(newPath, templateContent);
				await this.app.workspace.getLeaf(false).openFile(newFile);
				new Notice(`✅ Created "${noteName}" from template.`);
			} catch (e: unknown) {
				new Notice(`⛔ Could not create note: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		}, suggestedName).open();
	}

	async applyTemplateToCurrentNote(file: TFile) {
		try {
			const existing = await this.app.vault.read(file);
			if (existing.trim().length > 0 && !confirm("This note already has content. Add the WP template to the top anyway?")) return;
			const templateContent = await this.getTemplateContent();
			await this.app.vault.modify(file, `${templateContent.trim()}\n\n${existing}`.trimEnd() + "\n");
			new Notice(`✅ WP-Publisher template applied to "${file.basename}".`);
		} catch (e: unknown) {
			new Notice(`⛔ Could not apply template: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

	async autoApplyTemplateToNewNote(file: TFile) {
		if (!this.settings.autoApplyTemplateOnNewNotes) return;

		const folder = this.settings.publishFolder.trim();
		// Avoid surprising people by templating every note in the vault. Auto-apply is
		// only for a deliberately configured publish folder.
		if (!folder || folder === "/") return;
		if (!this.fileIsAllowed(file)) return;

		const templatePath = this.settings.defaultTemplatePath.trim();
		if (templatePath && normalizePath(templatePath) === file.path) return;

		try {
			// Give Obsidian a moment to finish creating/opening the blank note.
			await wait(250);
			const existing = await this.app.vault.read(file);
			if (existing.trim().length > 0) return;

			let targetFile = file;
			if (/^Untitled(?: \d+)?$/i.test(file.basename)) {
				const newPath = this.getNextSitePostPath(folder);
				if (newPath !== file.path) {
					await this.app.fileManager.renameFile(file, newPath);
					const moved = this.app.vault.getAbstractFileByPath(newPath);
					if (moved instanceof TFile) targetFile = moved;
				}
			}

			const templateContent = await this.getTemplateContent();
			await this.app.vault.modify(targetFile, templateContent.trimEnd() + "\n");
			new Notice(`WP template applied to new post note: "${targetFile.basename}".`);
		} catch (e: unknown) {
			new Notice(`Could not auto-apply WP template: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

}

// ─────────────────────────────────────────────
// Settings Tab
// ─────────────────────────────────────────────

class WPPublisherSettingTab extends PluginSettingTab {
	plugin: WPPublisherPlugin;
	categoryTextAreaEl?: HTMLTextAreaElement;
	categoryInlineStatusEl?: HTMLDivElement;

	constructor(app: App, plugin: WPPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	refreshCategoryList() {
		if (this.categoryTextAreaEl && this.categoryTextAreaEl.value !== this.plugin.settings.wpCategories) {
			this.categoryTextAreaEl.value = this.plugin.settings.wpCategories;
		}
		this.refreshCategoryStatus();
	}

	refreshCategoryStatus() {
		const categoryCount = categoryNamesFromSettings(this.plugin.settings).length;
		const source = this.plugin.settings.wpCategoriesLastSource === "wordpress" ? "WordPress" : "Manual";
		const currentSnapshot = normalizedCategorySnapshot(this.plugin.settings.wpCategories);
		const lastSnapshot = this.plugin.settings.wpCategoriesLastWordPressSnapshot || "";
		const status = this.plugin.settings.wpCategoriesLastSource === "wordpress" && currentSnapshot === lastSnapshot
			? "in sync"
			: "needs refresh";
		if (this.categoryInlineStatusEl) {
			this.categoryInlineStatusEl.empty();
			const message = this.plugin.settings.wpCategoriesLastMessage || "No category updates yet";
			this.categoryInlineStatusEl.createEl("div", { text: message }).style.cssText = "font-weight:600;color:var(--text-normal);";
			this.categoryInlineStatusEl.createEl("div", { text: `Refresh state: ${status}` });
		}
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		this.plugin.updateCategoryCacheNote().catch(e => console.warn("WP-Publisher category cache update failed", e));

		// ── WordPress Connection ──────────────────────────────────
		containerEl.createEl("h2", { text: `WordPress connection — WP-Publisher ${WP_PUBLISHER_VERSION}` });

		new Setting(containerEl)
			.setName("Site URL")
			.setDesc("Full URL including https://, e.g. https://mysite.com")
			.addText(t => t
				.setPlaceholder("https://mysite.com")
				.setValue(this.plugin.settings.wpUrl)
				.onChange(async v => { this.plugin.settings.wpUrl = v.trim(); await this.plugin.saveSettings(); })
			);

		new Setting(containerEl)
			.setName("Username")
			.setDesc("Your WordPress login username")
			.addText(t => t
				.setPlaceholder("admin")
				.setValue(this.plugin.settings.wpUsername)
				.onChange(async v => { this.plugin.settings.wpUsername = v.trim(); await this.plugin.saveSettings(); })
			);

		const passwordIsLocked = this.plugin.settings.wpPassword.trim().length > 0;
		let pendingPassword = "";
		let passwordInputEl: HTMLInputElement | null = null;

		const passwordSetting = new Setting(containerEl)
			.setName("Application password")
			.setDesc(passwordIsLocked
				? "Saved and locked. The password is not shown here again. Clear it before entering a replacement."
				: "Paste the one-time WordPress Application Password, then click Lock password. Different from your login password.")
			.addText(t => {
				passwordInputEl = t.inputEl;
				t.setPlaceholder(passwordIsLocked ? "Password saved and locked" : "xxxx xxxx xxxx xxxx xxxx xxxx")
					.setValue("")
					.onChange(v => { pendingPassword = v.trim(); });
				t.inputEl.type = "password";
				t.inputEl.disabled = passwordIsLocked;
				t.inputEl.autocomplete = "new-password";
			})
			.addButton(btn => btn
				.setButtonText("?")
				.setTooltip("What is this?")
				.onClick(() => {
					new Notice("Use a WordPress Application Password. Paste it once, click Lock password, and the plugin hides it. To change it later, click Clear password and paste a new one.", 12000);
				})
			);

		if (!passwordIsLocked) {
			passwordSetting
				.addButton(btn => btn
					.setButtonText("Show")
					.setTooltip("Temporarily show/hide what you typed before locking")
					.onClick(() => {
						if (!passwordInputEl) return;
						const showing = passwordInputEl.type === "text";
						passwordInputEl.type = showing ? "password" : "text";
						btn.setButtonText(showing ? "Show" : "Hide");
					})
				)
				.addButton(btn => btn
					.setButtonText("Lock password")
					.setCta()
					.onClick(async () => {
						if (!pendingPassword) {
							new Notice("Paste the WordPress application password first, then click Lock password.", 8000);
							return;
						}
						this.plugin.settings.wpPassword = pendingPassword;
						await this.plugin.saveSettings();
						pendingPassword = "";
						new Notice("✅ Application password saved and locked. It will not be shown in settings again.", 8000);
						this.display();
					})
				);
		} else {
			passwordSetting.addButton(btn => btn
				.setButtonText("Clear password")
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.wpPassword = "";
					await this.plugin.saveSettings();
					new Notice("Application password cleared. Paste a new one and click Lock password to replace it.", 8000);
					this.display();
				})
			);
		}

		// Connection test
		const testRow = containerEl.createDiv();
		testRow.style.marginBottom = "16px";
		const testBtn = testRow.createEl("button", { text: "Test connection", cls: "mod-cta" });
		const testResult = testRow.createEl("span");
		testResult.style.cssText = "margin-left:12px;font-size:13px;";
		testBtn.onclick = async () => {
			testResult.textContent = "Testing…";
			const validErr = this.plugin.validateSettings();
			if (validErr) { testResult.textContent = `⛔ ${validErr}`; return; }
			try {
				await testWordPressConnection(this.plugin.settings);
				testResult.textContent = "✅ Connected";
			} catch (e: unknown) {
				testResult.textContent = `⛔ ${e instanceof Error ? e.message : String(e)}`;
			}
		};

		// ── Publishing rules ──────────────────────────────────────
		containerEl.createEl("h2", { text: "Publishing rules" });

		// Publish folder
		const folderSetting = new Setting(containerEl)
			.setName("Publish folder")
			.setDesc("Only notes in this folder can be published or drafted. Choose a dedicated folder for WordPress posts.")
			.addText(t => {
				t.setPlaceholder("Posts")
					.setValue(this.plugin.settings.publishFolder)
					.onChange(async v => {
						this.plugin.settings.publishFolder = v.trim();
						await this.plugin.saveSettings();
						folderSetting.settingEl.querySelector(".wp-folder-label")?.remove();
					});
				return t;
			})
			.addButton(btn => btn
				.setButtonText("Browse…")
				.onClick(() => {
					new FolderSuggestModal(this.app, async (folder: TFolder) => {
						if (folder.path === "/") {
							new Notice("Choose a dedicated publish folder, not the vault root.", 8000);
							return;
						}
						const path = folder.path;
						this.plugin.settings.publishFolder = path;
						await this.plugin.saveSettings();
						this.display(); // re-render to show new value
					}).open();
				})
			);

		// Show current folder as a badge under the setting
		if (this.plugin.settings.publishFolder) {
			const badge = folderSetting.settingEl.createEl("div", {
				cls: "wp-folder-label",
				text: `📁 ${this.plugin.settings.publishFolder}`,
			});
			badge.style.cssText = "font-size:12px;color:var(--text-muted);margin-top:4px;";
		}

		// ── Template ─────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Template" });

		const tplSetting = new Setting(containerEl)
			.setName("Default template note")
			.setDesc("Path to a note used as the template for new posts. Leave blank to use the built-in WP-Publisher template. The note filename is used as the WordPress title.")
			.addText(t => {
				t.setPlaceholder("Templates/WP Post.md")
					.setValue(this.plugin.settings.defaultTemplatePath)
					.onChange(async v => {
						this.plugin.settings.defaultTemplatePath = v.trim();
						await this.plugin.saveSettings();
						this.refreshTemplateStatus(tplSetting.settingEl);
					});
				return t;
			})
			.addButton(btn => btn
				.setButtonText("Browse…")
				.onClick(() => {
					new FileSuggestModal(this.app, async (file: TFile) => {
						this.plugin.settings.defaultTemplatePath = file.path;
						await this.plugin.saveSettings();
						this.display();
					}).open();
				})
			);

		this.refreshTemplateStatus(tplSetting.settingEl);

		new Setting(containerEl)
			.setName("Apply template to new notes in publish folder")
			.setDesc("When enabled, ordinary blank notes created inside the publish folder automatically receive the selected WP template. Existing/non-empty notes are left alone.")
			.addToggle(t => t
				.setValue(this.plugin.settings.autoApplyTemplateOnNewNotes)
				.onChange(async v => {
					this.plugin.settings.autoApplyTemplateOnNewNotes = v;
					await this.plugin.saveSettings();
				})
			);


		new Setting(containerEl)
			.setName("Sync status on save")
			.setDesc("Silently update status: in frontmatter whenever you save a note with a plugin-managed wp-id.")
			.addToggle(t => t
				.setValue(this.plugin.settings.syncOnSave)
				.onChange(async v => { this.plugin.settings.syncOnSave = v; await this.plugin.saveSettings(); })
			);

		// ── Categories ───────────────────────────────────────────
		containerEl.createEl("h2", { text: "Categories" });
		containerEl.createEl("p", {
			text: "Add known WordPress categories here. Put each category on its own line, or separate categories with commas.",
		}).style.cssText = "font-size:13px;color:var(--text-muted);margin-bottom:8px;";

		new Setting(containerEl)
			.setName("Automatically create missing categories")
			.setDesc("If enabled, missing categories are created in WordPress when a note is published or drafted, and for linked posts when category edits settle.")
			.addToggle(t => t
				.setValue(this.plugin.settings.autoCreateCategories)
				.onChange(async v => {
					this.plugin.settings.autoCreateCategories = v;
					await this.plugin.saveSettings();
				})
			);

		const categorySetting = new Setting(containerEl)
			.setName("Known categories")
			.setDesc("Used for category suggestions while typing category: or categories: in note frontmatter.")
			.addTextArea(t => {
				t.setPlaceholder("Blog\nNews\nProjects")
					.setValue(this.plugin.settings.wpCategories)
					.onChange(async v => {
						this.plugin.settings.wpCategories = v;
						this.plugin.settings.wpCategoriesLastSource = "manual";
						this.plugin.settings.wpCategoriesLastMessage = "Edited Known categories manually.";
						await this.plugin.saveSettings();
						await this.plugin.updateCategoryCacheNote();
						this.refreshCategoryList();
					});
				t.inputEl.rows = 6;
				t.inputEl.style.width = "100%";
				t.inputEl.style.minWidth = "360px";
				t.inputEl.style.resize = "vertical";
				this.categoryTextAreaEl = t.inputEl;
			})
			.addButton(btn => btn
				.setButtonText("?")
				.setTooltip("Category list format")
				.onClick(() => {
					const behavior = this.plugin.settings.autoCreateCategories
						? "If a note is published or drafted and the category is not in the list, the category is created automatically in WordPress."
						: "If automatic category creation is off, only categories that already exist in WordPress will be assigned on publish or draft.";
					new Notice(`Use one category per line or separate them with commas. ${behavior}`, 12000);
				})
			)
			.addButton(btn => btn
				.setButtonText("Refresh from WordPress")
				.setCta()
				.setTooltip("Replace Known categories with the current WordPress category list.")
				.onClick(async () => {
					const validErr = this.plugin.validateSettings();
					if (validErr) { new Notice(`⛔ ${validErr}`, 8000); return; }
					try {
						const loaded = await fetchWordPressCategoryNames(this.plugin.settings);
						const merged = mergeCategoryNames([], loaded);
						this.plugin.settings.wpCategories = merged.join("\n");
						this.plugin.settings.wpCategoriesLastRefreshedAt = Date.now();
						this.plugin.settings.wpCategoriesLastSource = "wordpress";
						this.plugin.settings.wpCategoriesLastWordPressSnapshot = normalizedCategorySnapshot(merged);
						this.plugin.settings.wpCategoriesLastMessage = `Replaced Known categories from WordPress. ${merged.length} categories loaded.`;
						await this.plugin.saveSettings();
						await this.plugin.updateCategoryCacheNote();
						this.refreshCategoryList();
						new Notice(`✅ Loaded ${loaded.length} categories from WordPress.`);
					} catch (e: unknown) {
						this.plugin.settings.wpCategoriesLastMessage = `Category refresh failed: ${e instanceof Error ? e.message : String(e)}`;
						await this.plugin.saveSettings();
						this.refreshCategoryStatus();
						new Notice(`⛔ Category load failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
					}
				})
			);
		categorySetting.settingEl.style.alignItems = "stretch";
		categorySetting.infoEl.style.alignSelf = "flex-start";
		categorySetting.controlEl.style.flexDirection = "column";
		categorySetting.controlEl.style.alignItems = "stretch";
		categorySetting.controlEl.style.gap = "8px";

		const categoryButtonRow = categorySetting.controlEl.createDiv();
		categoryButtonRow.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
		const categoryButtons = Array.from(categorySetting.controlEl.querySelectorAll("button"));
		for (const button of categoryButtons) categoryButtonRow.appendChild(button);
		this.categoryInlineStatusEl = categorySetting.controlEl.createDiv();
		this.categoryInlineStatusEl.style.cssText = "font-size:12px;color:var(--text-muted);padding:8px 2px 0 2px;line-height:1.6;";
		this.refreshCategoryStatus();

		// ── Hotkeys ──────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Hotkeys" });
		containerEl.createEl("p", {
			text: "Click Record, press your desired key combination, then click Stop recording to save it. Press Escape to cancel recording.",
		}).style.cssText = "font-size:13px;color:var(--text-muted);margin-bottom:12px;";

		this.addHotkeySetting(containerEl, "Publish hotkey", "hotkeyPublish");
		this.addHotkeySetting(containerEl, "Draft hotkey", "hotkeyDraft");

		new Setting(containerEl)
			.setName("Show sidebar publish button")
			.setDesc("Show or hide the WP-Publisher button in Obsidian's left sidebar.")
			.addToggle(t => t
				.setValue(this.plugin.settings.showSidebarButton)
				.onChange(async v => {
					this.plugin.settings.showSidebarButton = v;
					await this.plugin.saveSettings();
					this.plugin.updateRibbonIcon();
				})
			);

		// Note about Obsidian's built-in hotkey system
		containerEl.createEl("p", {
			text: "You can also assign hotkeys via Obsidian's built-in Settings \u2192 Hotkeys page \u2014 search for 'WP-Publisher' to find all commands there.",
		}).style.cssText = "font-size:12px;color:var(--text-muted);margin-top:8px;";

		// ── Frontmatter reference ─────────────────────────────────
		containerEl.createEl("h2", { text: "Frontmatter keys" });
		const info = containerEl.createEl("div");
		info.style.cssText = "font-size:13px;color:var(--text-muted);line-height:1.8;";
		info.innerHTML = `
			<code>title:</code> — optional override; by default the post title comes from the note filename<br>
			<code>category:</code> — WordPress category (auto-created if new; blank uses WordPress Uncategorized)<br>
			<code>excerpt:</code> — post summary / meta description<br>
			<code>comments:</code> — <code>on</code> or <code>off</code>; sends WordPress comment_status open/closed for anti-bot control<br>
			<code>status:</code> — updated automatically by the plugin<br>
			<code>wp-id:</code> — visible publish marker, managed automatically by WP-Publisher<br>
			<code>wp-sync:</code> — <code>synced</code> after publish/draft; <code>out-of-sync</code> after local edits<br>
		`;

		const footer = containerEl.createEl("div");
		footer.style.cssText = "margin-top:24px;padding-top:12px;border-top:1px solid var(--background-modifier-border);font-size:12px;color:var(--text-muted);";
		footer.createSpan({ text: "WP-Publisher on GitHub: " });
		const githubLink = footer.createEl("a", {
			text: "github",
			href: "https://github.com/Wicked-Shrapnel/Obsidian-2-WordPress-Plugin",
		});
		githubLink.setAttr("target", "_blank");
		githubLink.setAttr("rel", "noopener");
	}

	// Show a green ✅ or red ⛔ next to the template path
	refreshTemplateStatus(settingEl: HTMLElement) {
		settingEl.querySelector(".wp-tpl-status")?.remove();
		const path = this.plugin.settings.defaultTemplatePath.trim();
		if (!path) return;
		const exists = this.app.vault.getAbstractFileByPath(normalizePath(path)) instanceof TFile;
		const span = settingEl.createEl("span", {
			cls: "wp-tpl-status",
			text: exists ? "✅ Found" : "⛔ Not found — check the path",
		});
		span.style.cssText = `font-size:12px;margin-left:8px;color:${exists ? "var(--color-green)" : "var(--color-red)"};`;
	}

	// Build a single hotkey recorder row
	addHotkeySetting(
		container: HTMLElement,
		label: string,
		settingKey: "hotkeyPublish" | "hotkeyDraft"
	) {
		const current = this.plugin.settings[settingKey];

		const row = new Setting(container).setName(label);

		// Display span
		const display = row.controlEl.createEl("span");
		display.style.cssText = "min-width:160px;display:inline-block;font-size:13px;padding:4px 8px;background:var(--background-modifier-form-field);border-radius:4px;border:1px solid var(--background-modifier-border);";
		display.textContent = hotkeyLabel(current);

		let recording = false;
		let pendingHotkey: HotkeyDef | null = null;
		let keyHandler: ((e: KeyboardEvent) => void) | null = null;

		const detachRecorder = () => {
			recording = false;
			this.plugin.isRecordingHotkey = false;
			recordBtn.classList.remove("mod-warning");
			if (keyHandler) {
				document.removeEventListener("keydown", keyHandler, true);
				document.removeEventListener("keyup", keyHandler, true);
				window.removeEventListener("keydown", keyHandler, true);
				window.removeEventListener("keyup", keyHandler, true);
				keyHandler = null;
			}
		};

		const savePendingHotkey = async () => {
			detachRecorder();
			recordBtn.textContent = "Record";
			if (!pendingHotkey) return;
			this.plugin.settings[settingKey] = pendingHotkey;
			await this.plugin.saveSettings();
			this.plugin.registerSavedHotkeys();
			display.textContent = hotkeyLabel(pendingHotkey);
			new Notice(`✅ ${label} set to ${hotkeyLabel(pendingHotkey)}`);
			pendingHotkey = null;
		};

		// Record button
		const recordBtn = row.controlEl.createEl("button", { text: "Record" });
		recordBtn.style.marginLeft = "8px";
		recordBtn.onclick = async () => {
			if (recording) { await savePendingHotkey(); return; }
			recording = true;
			pendingHotkey = null;
			this.plugin.isRecordingHotkey = true;
			recordBtn.textContent = "Stop recording";
			recordBtn.classList.add("mod-warning");
			display.textContent = "Press keybind…";

			keyHandler = (e: KeyboardEvent) => {
				if (e.key === "Escape") {
					e.preventDefault();
					e.stopPropagation();
					e.stopImmediatePropagation();
					pendingHotkey = null;
					display.textContent = hotkeyLabel(this.plugin.settings[settingKey]);
					detachRecorder();
					recordBtn.textContent = "Record";
					return;
				}

				const hk = eventToHotkey(e);
				if (!hk) return; // bare modifier, keep waiting
				e.preventDefault();
				e.stopPropagation();
				e.stopImmediatePropagation();

				pendingHotkey = hk;
				display.textContent = hotkeyLabel(hk);
			};

			document.addEventListener("keydown", keyHandler, true);
			document.addEventListener("keyup", keyHandler, true);
			window.addEventListener("keydown", keyHandler, true);
			window.addEventListener("keyup", keyHandler, true);
		};

		// Clear button
		const clearBtn = row.controlEl.createEl("button", { text: "Clear" });
		clearBtn.style.marginLeft = "6px";
		clearBtn.onclick = async () => {
			detachRecorder();
			recordBtn.textContent = "Record";
			pendingHotkey = null;
			this.plugin.settings[settingKey] = null;
			await this.plugin.saveSettings();
			this.plugin.registerSavedHotkeys();
			display.textContent = hotkeyLabel(null);
		};
	}
}

