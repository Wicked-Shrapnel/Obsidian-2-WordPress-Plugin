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
} from "obsidian";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

interface HotkeyDef {
	modifiers: string[]; // e.g. ["Ctrl","Shift"]
	key: string;         // e.g. "P"
}

interface WPPublisherSettings {
	wpUrl: string;
	wpUsername: string;
	wpPassword: string;
	defaultTemplatePath: string;
	publishFolder: string;    // "" = any folder; otherwise restrict to this path
	autoApplyTemplateOnNewNotes: boolean;
	syncOnSave: boolean;
	hotkeyPublish: HotkeyDef | null;
	hotkeyDraft: HotkeyDef | null;
}

const DEFAULT_SETTINGS: WPPublisherSettings = {
	wpUrl: "",
	wpUsername: "",
	wpPassword: "",
	defaultTemplatePath: "",
	publishFolder: "",
	autoApplyTemplateOnNewNotes: true,
	syncOnSave: true,
	hotkeyPublish: null,
	hotkeyDraft: null,
};

const HERMES_PLUGIN_VERSION = "1.0.3-hermes.1";
const DEFAULT_WP_POST_TEMPLATE = `---
category: 
excerpt: 
status: draft
wp-id: 
---
`;

const wait = (ms: number) => new Promise(resolve => window.setTimeout(resolve, ms));

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
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx === -1) continue;
		const key = line.slice(0, idx).trim();
		const value = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
		if (key) result[key] = value;
	}
	return result;
}

function stripFrontmatter(content: string): string {
	return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
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

// ─────────────────────────────────────────────
// WordPress REST helpers
// ─────────────────────────────────────────────

interface WPPost { id: number; status: string; link: string; }

function basicAuth(u: string, p: string) { return "Basic " + btoa(`${u}:${p}`); }

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

async function resolveCategory(s: WPPublisherSettings, name: string): Promise<number> {
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
	return raw.split(",").map(c => c.trim()).filter(Boolean);
}

async function resolveCategories(s: WPPublisherSettings, fm: Record<string, string>): Promise<number[] | undefined> {
	const names = categoryNamesFromFrontmatter(fm);
	// Same behavior as the Python version/readme: a blank category lets WordPress use Uncategorized.
	if (names.length === 0) return undefined;
	const ids: number[] = [];
	for (const name of names) ids.push(await resolveCategory(s, name));
	return ids;
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
	inputEl!: HTMLInputElement;

	constructor(app: App, onSubmit: (name: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: "New note from WP template" });
		const wrap = contentEl.createDiv();
		wrap.createEl("label", { text: "Note name:" });
		this.inputEl = wrap.createEl("input", { type: "text", placeholder: "My new post" });
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
// Main Plugin
// ─────────────────────────────────────────────

export default class WPPublisherPlugin extends Plugin {
	settings!: WPPublisherSettings;

	async onload() {
		await this.loadSettings();

		// Ribbon icon
		this.addRibbonIcon("upload-cloud", "Publish to WordPress", () => {
			const view = this.app.workspace.getActiveViewOfType(MarkdownView);
			if (view?.file) this.publishNote(view.file, "publish");
			else new Notice("Open a note first.");
		});

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
			name: "New note from WP Publisher template",
			callback: () => this.newNoteFromTemplate(),
		});

		// Command: apply template to current note
		this.addCommand({
			id: "wp-apply-template",
			name: "Apply WP Publisher template to current note",
			editorCallback: (_e: Editor, view: MarkdownView) => {
				if (view.file) this.applyTemplateToCurrentNote(view.file);
			},
		});

		// Register custom hotkeys from settings
		this.registerSavedHotkeys();

		// Auto-sync on save
		this.registerEvent(
			this.app.vault.on("modify", async (file: TAbstractFile) => {
				if (!this.settings.syncOnSave) return;
				if (!(file instanceof TFile) || file.extension !== "md") return;
				const content = await this.app.vault.read(file);
				const fm = parseFrontmatter(content);
				if (fm["wp-id"]) await this.syncStatus(file, fm["wp-id"]);
			})
		);

		// Auto-apply template to ordinary new blank notes created in the publish folder.
		// The explicit "New note from WP Publisher template" command already creates
		// notes with content, so this handler skips non-empty files to avoid doubles.
		this.registerEvent(
			this.app.vault.on("create", async (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				await this.autoApplyTemplateToNewNote(file);
			})
		);

		this.addSettingTab(new WPPublisherSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	// ── Hotkeys registered from stored combos ──
	registerSavedHotkeys() {
		// We listen globally on keydown. The Scope API needs modifiers as
		// Obsidian Modifier[], but we can also just listen via document.
		// Using the app's Scope is cleaner and respects modal states.
		const tryHotkey = (hk: HotkeyDef | null, action: () => void) => {
			if (!hk) return;
			// Map our stored modifier names to Obsidian Modifier type
			const modMap: Record<string, string> = {
				Ctrl: "Mod", Alt: "Alt", Shift: "Shift", Meta: "Meta"
			};
			// Fall back to document keydown – simpler and reliable
			const handler = (e: KeyboardEvent) => {
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
			this.registerDomEvent(document, "keydown", handler);
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
		if (!this.settings.wpUrl) return "WordPress URL is not set. Go to Settings → WP Publisher.";
		if (!this.settings.wpUsername) return "WordPress username is not set.";
		if (!this.settings.wpPassword) return "WordPress application password is not set.";
		try { new URL(this.settings.wpUrl); } catch {
			return "WordPress URL is invalid — include https://, e.g. https://mysite.com";
		}
		return null;
	}

	// ── Folder check ──
	fileIsAllowed(file: TFile): boolean {
		const folder = this.settings.publishFolder.trim();
		if (!folder || folder === "/") return true; // unrestricted
		return file.path.startsWith(folder + "/") || file.parent?.path === folder;
	}

	// ── Publish / update ──
	async publishNote(file: TFile, desiredStatus: "publish" | "draft") {
		const err = this.validateSettings();
		if (err) { new Notice(`⛔ ${err}`, 8000); return; }

		if (!this.fileIsAllowed(file)) {
			const folder = this.settings.publishFolder;
			new Notice(`⛔ This note is not in the publish folder:\n"${folder}"\n\nChange the folder in Settings → WP Publisher, or move the note.`, 10000);
			return;
		}

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

		const previousStatus = (fm["status"] || "").trim().toLowerCase();
		try {
			const categoryIds = await resolveCategories(this.settings, fm);
			if (categoryIds) payload["categories"] = categoryIds;

			const existingId = fm["wp-id"] || await findExistingPostByTitle(this.settings, title);
			let post: WPPost;
			if (existingId) {
				post = await wpRequest(this.settings, "POST", `posts/${existingId}`, payload);
				await setFrontmatterKey(this.app, file, "wp-id", String(post.id));
				const msg = desiredStatus === "draft"
					? (previousStatus === "publish" ? "Taken down to draft" : "Draft updated")
					: (previousStatus === "draft" ? "Published from draft" : "Post updated");
				new Notice(`✅ ${msg}: "${title}"`);
			} else {
				post = await wpRequest(this.settings, "POST", "posts", payload);
				await setFrontmatterKey(this.app, file, "wp-id", String(post.id));
				new Notice(desiredStatus === "publish" ? `✅ Published: "${title}"` : `✅ Saved as new draft: "${title}"`);
			}
			await setFrontmatterKey(this.app, file, "status", post.status);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			await setFrontmatterKey(this.app, file, "status", "error");
			new Notice(`⛔ Publish failed: ${msg}`, 10000);
		}
	}

	// ── Revert to draft ──
	async revertToDraft(file: TFile) {
		const err = this.validateSettings();
		if (err) { new Notice(`⛔ ${err}`, 8000); return; }
		const content = await this.app.vault.read(file);
		const fm = parseFrontmatter(content);
		if (!fm["wp-id"]) { new Notice("⛔ This note hasn't been published yet (no wp-id)."); return; }
		try {
			await wpRequest(this.settings, "POST", `posts/${fm["wp-id"]}`, { status: "draft" });
			await setFrontmatterKey(this.app, file, "status", "draft");
			new Notice(`✅ Reverted to draft: "${fm["title"] || file.basename}"`);
		} catch (e: unknown) {
			new Notice(`⛔ Revert failed: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}

	// ── Sync on save ──
	async syncStatus(file: TFile, wpId: string) {
		try {
			const post = await wpRequest(this.settings, "GET", `posts/${wpId}`);
			await setFrontmatterKey(this.app, file, "status", post.status);
		} catch { /**/ }
	}

	// ── Template helpers ──
	async getTemplateContent(): Promise<string> {
		const templatePath = this.settings.defaultTemplatePath.trim();
		if (!templatePath) return DEFAULT_WP_POST_TEMPLATE;
		const templateFile = this.app.vault.getAbstractFileByPath(normalizePath(templatePath));
		if (!(templateFile instanceof TFile)) {
			throw new Error(`Template note not found: "${templatePath}". Check the path in Settings → WP Publisher.`);
		}
		return await this.app.vault.read(templateFile);
	}

	// ── New note from template ──
	async newNoteFromTemplate() {
		let templateContent: string;
		try {
			templateContent = await this.getTemplateContent();
		} catch (e: unknown) {
			new Notice(`⛔ ${e instanceof Error ? e.message : String(e)}`, 10000);
			return;
		}

		new NewNoteModal(this.app, async (noteName: string) => {
			if (!noteName.trim()) { new Notice("Note name cannot be empty."); return; }

			// Place new note in the publish folder if one is set, otherwise vault root
			const folder = this.settings.publishFolder.trim();
			const fileName = noteName.endsWith(".md") ? noteName : `${noteName}.md`;
			const newPath = normalizePath(folder && folder !== "/" ? `${folder}/${fileName}` : fileName);

			try {
				const newFile = await this.app.vault.create(newPath, templateContent);
				await this.app.workspace.getLeaf(false).openFile(newFile);
				new Notice(`✅ Created "${noteName}" from template.`);
			} catch (e: unknown) {
				new Notice(`⛔ Could not create note: ${e instanceof Error ? e.message : String(e)}`, 8000);
			}
		}).open();
	}

	async applyTemplateToCurrentNote(file: TFile) {
		try {
			const existing = await this.app.vault.read(file);
			if (existing.trim().length > 0 && !confirm("This note already has content. Add the WP template to the top anyway?")) return;
			const templateContent = await this.getTemplateContent();
			await this.app.vault.modify(file, `${templateContent.trim()}\n\n${existing}`.trimEnd() + "\n");
			new Notice(`✅ WP Publisher template applied to "${file.basename}".`);
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

			const templateContent = await this.getTemplateContent();
			await this.app.vault.modify(file, templateContent.trimEnd() + "\n");
			new Notice(`✅ WP template applied to new post note: "${file.basename}".`);
		} catch (e: unknown) {
			new Notice(`⛔ Could not auto-apply WP template: ${e instanceof Error ? e.message : String(e)}`, 10000);
		}
	}
}

// ─────────────────────────────────────────────
// Settings Tab
// ─────────────────────────────────────────────

class WPPublisherSettingTab extends PluginSettingTab {
	plugin: WPPublisherPlugin;

	constructor(app: App, plugin: WPPublisherPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── WordPress Connection ──────────────────────────────────
		containerEl.createEl("h2", { text: `WordPress connection — Hermes ${HERMES_PLUGIN_VERSION}` });

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
				await wpRequest(this.plugin.settings, "GET", "posts?per_page=1");
				testResult.textContent = "✅ Connected!";
			} catch (e: unknown) {
				testResult.textContent = `⛔ ${e instanceof Error ? e.message : String(e)}`;
			}
		};

		// ── Publishing rules ──────────────────────────────────────
		containerEl.createEl("h2", { text: "Publishing rules" });

		// Publish folder
		const folderSetting = new Setting(containerEl)
			.setName("Publish folder")
			.setDesc("Only notes in this folder can be published. Leave empty to allow any note.")
			.addText(t => {
				t.setPlaceholder("(any folder)")
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
						const path = folder.path === "/" ? "" : folder.path;
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

		// Clear folder button (only when a folder is set)
		if (this.plugin.settings.publishFolder) {
			new Setting(containerEl)
				.setName("")
				.addButton(btn => btn
					.setButtonText("Clear folder restriction (allow all notes)")
					.onClick(async () => {
						this.plugin.settings.publishFolder = "";
						await this.plugin.saveSettings();
						this.display();
					})
				);
		}

		new Setting(containerEl)
			.setName("Sync status on save")
			.setDesc("Silently update status: in frontmatter whenever you save a note that has a wp-id.")
			.addToggle(t => t
				.setValue(this.plugin.settings.syncOnSave)
				.onChange(async v => { this.plugin.settings.syncOnSave = v; await this.plugin.saveSettings(); })
			);

		// ── Template ─────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Template" });

		const tplSetting = new Setting(containerEl)
			.setName("Default template note")
			.setDesc("Path to a note used as the template for new posts. Leave blank to use the built-in Hermes template. The note filename is used as the WordPress title.")
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

		// ── Hotkeys ──────────────────────────────────────────────
		containerEl.createEl("h2", { text: "Hotkeys" });
		containerEl.createEl("p", {
			text: "Click a record button, then press your desired key combination (must include Ctrl, Alt, Shift, or Meta). Press Escape to cancel recording.",
		}).style.cssText = "font-size:13px;color:var(--text-muted);margin-bottom:12px;";

		this.addHotkeySetting(containerEl, "Publish hotkey", "hotkeyPublish");
		this.addHotkeySetting(containerEl, "Draft hotkey", "hotkeyDraft");

		// Note about Obsidian's built-in hotkey system
		containerEl.createEl("p", {
			text: "You can also assign hotkeys via Obsidian's built-in Settings \u2192 Hotkeys page \u2014 search for 'WP Publisher' to find all commands there.",
		}).style.cssText = "font-size:12px;color:var(--text-muted);margin-top:8px;";

		// ── Frontmatter reference ─────────────────────────────────
		containerEl.createEl("h2", { text: "Frontmatter keys" });
		const info = containerEl.createEl("div");
		info.style.cssText = "font-size:13px;color:var(--text-muted);line-height:1.8;";
		info.innerHTML = `
			<code>title:</code> — optional override; by default the post title comes from the note filename<br>
			<code>category:</code> — WordPress category (auto-created if new; blank uses WordPress Uncategorized)<br>
			<code>excerpt:</code> — post summary / meta description<br>
			<code>status:</code> — updated automatically by the plugin<br>
			<code>wp-id:</code> — written automatically after first publish<br>
		`;
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
		let keydownHandler: ((e: KeyboardEvent) => void) | null = null;

		const stopRecording = () => {
			recording = false;
			recordBtn.textContent = "Record";
			recordBtn.classList.remove("mod-warning");
			if (keydownHandler) {
				document.removeEventListener("keydown", keydownHandler, true);
				keydownHandler = null;
			}
		};

		// Record button
		const recordBtn = row.controlEl.createEl("button", { text: "Record" });
		recordBtn.style.marginLeft = "8px";
		recordBtn.onclick = () => {
			if (recording) { stopRecording(); return; }
			recording = true;
			recordBtn.textContent = "Press keys… (Esc to cancel)";
			recordBtn.classList.add("mod-warning");

			keydownHandler = (e: KeyboardEvent) => {
				e.preventDefault();
				e.stopPropagation();

				if (e.key === "Escape") {
					stopRecording();
					return;
				}

				const hk = eventToHotkey(e);
				if (!hk) return; // bare modifier, keep waiting

				stopRecording();
				this.plugin.settings[settingKey] = hk;
				this.plugin.saveSettings();
				display.textContent = hotkeyLabel(hk);

				// Re-register hotkeys so the new combo is live immediately
				// (requires plugin reload to cleanly remove old listener, but
				//  the new one is added immediately)
				new Notice(`✅ ${label} set to ${hotkeyLabel(hk)}\nRestart Obsidian to remove any old binding.`);
			};

			document.addEventListener("keydown", keydownHandler, true);
		};

		// Clear button
		const clearBtn = row.controlEl.createEl("button", { text: "Clear" });
		clearBtn.style.marginLeft = "6px";
		clearBtn.onclick = async () => {
			stopRecording();
			this.plugin.settings[settingKey] = null;
			await this.plugin.saveSettings();
			display.textContent = hotkeyLabel(null);
		};
	}
}
