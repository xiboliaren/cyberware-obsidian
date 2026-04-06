import { Plugin } from "obsidian";
import { CyberwareSettings, DEFAULT_SETTINGS } from "./types";
import { CyberwareSettingTab } from "./settings";
import { SyncEngine } from "./sync";

export default class CyberwarePlugin extends Plugin {
	settings: CyberwareSettings = DEFAULT_SETTINGS;
	private syncEngine: SyncEngine | null = null;
	private statusBarEl: HTMLElement | null = null;
	private statusClearTimer: number | null = null;

	async onload() {
		await this.loadSettings();

		this.syncEngine = new SyncEngine(
			this.app.vault,
			this.app.fileManager,
			this.settings,
			async () => (await this.loadData()) as Record<string, unknown> | null,
			async (data) => { await this.saveData(data); }
		);
		await this.syncEngine.loadState();

		this.statusBarEl = this.addStatusBarItem();
		this.syncEngine.setProgressCallback((msg) => {
			this.setStatus(msg);
		});

		// eslint-disable-next-line obsidianmd/ui/sentence-case -- brand name
		this.addRibbonIcon("folder-sync", "Sync Cyberware repos", () => {
			void this.runSync();
		});

		this.addCommand({
			id: "sync-repos",
			name: "Sync all repositories",
			callback: async () => {
				await this.runSync();
			},
		});

		this.addSettingTab(new CyberwareSettingTab(this.app, this));

		if (this.settings.autoSyncOnStart) {
			// Defer auto-sync so Obsidian finishes loading first
			this.registerInterval(
				window.setTimeout(() => {
					void this.runSync();
				}, 3000) as unknown as number
			);
		}
	}

	onunload() {
		this.syncEngine = null;
		if (this.statusClearTimer !== null) {
			window.clearTimeout(this.statusClearTimer);
		}
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData() as Partial<CyberwareSettings>
		);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.syncEngine?.updateSettings(this.settings);
	}

	private setStatus(text: string): void {
		if (!this.statusBarEl) return;
		if (this.statusClearTimer !== null) {
			window.clearTimeout(this.statusClearTimer);
			this.statusClearTimer = null;
		}
		this.statusBarEl.setText(`Cyberware: ${text}`);
		if (text.startsWith("Done") || text.startsWith("Failed")) {
			this.statusClearTimer = window.setTimeout(() => {
				this.statusBarEl?.setText("");
				this.statusClearTimer = null;
			}, 5000);
		}
	}

	private async runSync(): Promise<void> {
		if (!this.syncEngine) return;
		try {
			await this.syncEngine.syncAll();
		} catch (e) {
			this.setStatus("Failed — check console for details");
			console.error("Cyberware: sync failed", e);
		}
	}
}
