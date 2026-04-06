import { Notice, Vault, normalizePath, FileManager } from "obsidian";
import { CyberwareSettings, RepoConfig, SyncState, RepoSyncState, GitHubTreeItem } from "./types";
import { parseRepoUrl, fetchRepoTree, fetchFileContent } from "./github";
import { extractIds, buildDefinitionMap, transformContent, generateNodePages } from "./parser";
import { findArtifactsToml, parseArtifactPaths, filterTreeByArtifacts } from "./artifacts";

export type ProgressCallback = (message: string) => void;

export class SyncEngine {
	private vault: Vault;
	private fileManager: FileManager;
	private settings: CyberwareSettings;
	private state: SyncState;
	private loadPluginData: () => Promise<Record<string, unknown> | null>;
	private savePluginData: (data: Record<string, unknown>) => Promise<void>;
	private onProgress: ProgressCallback = () => {};

	constructor(
		vault: Vault,
		fileManager: FileManager,
		settings: CyberwareSettings,
		loadData: () => Promise<Record<string, unknown> | null>,
		saveData: (data: Record<string, unknown>) => Promise<void>
	) {
		this.vault = vault;
		this.fileManager = fileManager;
		this.settings = settings;
		this.state = { repos: {} };
		this.loadPluginData = loadData;
		this.savePluginData = saveData;
	}

	async loadState(): Promise<void> {
		const data = await this.loadPluginData();
		if (data && data["syncState"]) {
			this.state = data["syncState"] as SyncState;
		}
	}

	async saveState(): Promise<void> {
		const data = (await this.loadPluginData()) ?? {};
		data["syncState"] = this.state;
		await this.savePluginData(data);
	}

	updateSettings(settings: CyberwareSettings): void {
		this.settings = settings;
	}

	setProgressCallback(cb: ProgressCallback): void {
		this.onProgress = cb;
	}

	async syncAll(): Promise<void> {
		const enabledRepos = this.settings.repos.filter((r) => r.enabled && r.url.trim());
		if (enabledRepos.length === 0) {
			new Notice("Cyberware: no repositories configured.");
			return;
		}

		const total = enabledRepos.length;
		this.onProgress(`Syncing 0/${total} repos...`);
		new Notice(`Cyberware: syncing ${total} repo(s)...`);

		// Phase 1: Fetch all files from all repos
		const allFiles: { vaultPath: string; content: string; repoKey: string }[] = [];
		const repoMeta: { repo: RepoConfig; key: string; sha: string; filePaths: string[] }[] = [];

		let repoIndex = 0;
		for (const repo of enabledRepos) {
			repoIndex++;
			const parsed = parseRepoUrl(repo.url);
			const label = parsed ? `${parsed.owner}/${parsed.repo}` : repo.url;
			this.onProgress(`Fetching ${label} (${repoIndex}/${total})...`);
			try {
				const files = await this.syncRepo(repo);
				allFiles.push(...files.files);
				repoMeta.push({
					repo,
					key: files.key,
					sha: files.sha,
					filePaths: files.files.map((f) => f.vaultPath),
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				if (msg.includes("403") || msg.includes("401")) {
					/* eslint-disable obsidianmd/ui/sentence-case -- brand names */
					new Notice(
						"Cyberware: GitHub denied access. Add a personal access token in Settings → Cyberware.",
						8000
					);
					/* eslint-enable obsidianmd/ui/sentence-case */
				} else {
					new Notice(`Cyberware: failed to sync ${repo.url} — ${msg}`);
				}
				console.error("Cyberware sync error:", e);
			}
		}

		if (allFiles.length === 0) {
			new Notice("No Markdown files found.");
			return;
		}

		// Phase 2: Build definition map and collect all unique IDs
		this.onProgress(`Building links across ${allFiles.length} files...`);
		const definitionMap = buildDefinitionMap(allFiles);
		const allIds = new Set<string>();
		for (const file of allFiles) {
			for (const id of extractIds(file.content)) {
				allIds.add(id);
			}
		}

		// Phase 3: Transform content and write files
		await this.ensureFolder(this.settings.syncFolder);

		for (let i = 0; i < allFiles.length; i++) {
			const file = allFiles[i]!;
			this.onProgress(`Writing file ${i + 1}/${allFiles.length}...`);
			const transformed = transformContent(file.content);
			await this.writeFile(file.vaultPath, transformed);
		}

		// Phase 4: Generate node pages for ALL referenced IDs
		const artifactsFolder = normalizePath(`${this.settings.syncFolder}/Artifacts`);
		const undefinedFolder = normalizePath(`${this.settings.syncFolder}/Undefined`);
		const nodePages = generateNodePages(allIds, definitionMap, artifactsFolder, undefinedFolder);
		this.onProgress(`Writing ${nodePages.length} ID node page(s)...`);
		for (const page of nodePages) {
			await this.writeFile(page.vaultPath, page.content);
		}
		const newNodePaths = new Set(nodePages.map((p) => p.vaultPath));

		// Phase 5: Clean up deleted files and old node pages
		this.onProgress("Cleaning up...");
		for (const meta of repoMeta) {
			const prevState = this.state.repos[meta.key];
			if (prevState) {
				const newFileSet = new Set(meta.filePaths);
				for (const oldFile of prevState.files) {
					if (!newFileSet.has(oldFile)) {
						await this.deleteFile(oldFile);
					}
				}
			}
			this.state.repos[meta.key] = {
				lastSha: meta.sha,
				lastSync: Date.now(),
				files: meta.filePaths,
			};
		}

		// Clean up old node pages that no longer exist
		const oldNodePages = this.state.nodePages ?? [];
		for (const oldPage of oldNodePages) {
			if (!newNodePaths.has(oldPage)) {
				await this.deleteFile(oldPage);
			}
		}
		this.state.nodePages = [...newNodePaths];

		await this.saveState();
		const totalFiles = allFiles.length + nodePages.length;
		this.onProgress(`Done — ${totalFiles} file(s) synced`);
		new Notice(`Cyberware: synced ${allFiles.length} artifact(s) + ${nodePages.length} ID node(s).`);
	}

	private async syncRepo(
		repo: RepoConfig
	): Promise<{
		key: string;
		sha: string;
		files: { vaultPath: string; content: string; repoKey: string }[];
	}> {
		const parsed = parseRepoUrl(repo.url);
		if (!parsed) {
			throw new Error(`Invalid GitHub URL: ${repo.url}`);
		}

		const repoKey = `${parsed.owner}/${parsed.repo}/${parsed.branch}`;
		const { sha, tree } = await fetchRepoTree(parsed, this.settings.githubToken);

		// Check if we already have this exact commit AND local files still exist
		const prevState = this.state.repos[repoKey];
		if (prevState && prevState.lastSha === sha) {
			const existing = await this.readExistingFiles(prevState);
			if (existing.length > 0) {
				this.onProgress(`${parsed.owner}/${parsed.repo} is up to date`);
				new Notice(`Cyberware: ${parsed.owner}/${parsed.repo} is up to date.`);
				return { key: repoKey, sha, files: existing };
			}
			// Local files missing — re-download below
			console.debug(`Cyberware: ${parsed.owner}/${parsed.repo} — local files missing, re-downloading`);
		}

		// Determine scope via artifacts.toml
		const artifactsItem = findArtifactsToml(tree);
		let scopedFiles: GitHubTreeItem[];

		if (artifactsItem) {
			this.onProgress(`Reading artifacts.toml from ${parsed.owner}/${parsed.repo}...`);
			const tomlContent = await fetchFileContent(parsed, artifactsItem.path, this.settings.githubToken);
			const artifactPaths = parseArtifactPaths(tomlContent);
			scopedFiles = filterTreeByArtifacts(tree, artifactPaths);
			console.debug(
				`Cyberware: ${parsed.owner}/${parsed.repo} — artifacts.toml found at ${artifactsItem.path}, ` +
				`${artifactPaths.length} artifact(s) declared, ${scopedFiles.length} found in tree`
			);
		} else {
			// No artifacts.toml — scope is empty, nothing to sync
			console.debug(`Cyberware: ${parsed.owner}/${parsed.repo} — no artifacts.toml found, nothing to sync`);
			return { key: repoKey, sha, files: [] };
		}

		const files: { vaultPath: string; content: string; repoKey: string }[] = [];
		for (let i = 0; i < scopedFiles.length; i++) {
			const mdFile = scopedFiles[i]!;
			this.onProgress(
				`Downloading ${parsed.owner}/${parsed.repo}: ${i + 1}/${scopedFiles.length}...`
			);
			const content = await fetchFileContent(parsed, mdFile.path, this.settings.githubToken);
			const vaultPath = normalizePath(
				`${this.settings.syncFolder}/${parsed.owner}-${parsed.repo}/${mdFile.path}`
			);
			files.push({ vaultPath, content, repoKey });
		}

		return { key: repoKey, sha, files };
	}

	private async readExistingFiles(
		state: RepoSyncState
	): Promise<{ vaultPath: string; content: string; repoKey: string }[]> {
		const files: { vaultPath: string; content: string; repoKey: string }[] = [];
		for (const filePath of state.files) {
			const abstractFile = this.vault.getAbstractFileByPath(filePath);
			if (abstractFile && "path" in abstractFile) {
				try {
					const content = await this.vault.read(abstractFile as import("obsidian").TFile);
					files.push({ vaultPath: filePath, content, repoKey: "" });
				} catch {
					// File might have been deleted manually
				}
			}
		}
		return files;
	}

	private async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!this.vault.getAbstractFileByPath(normalized)) {
			await this.vault.createFolder(normalized);
		}
	}

	private async writeFile(vaultPath: string, content: string): Promise<void> {
		// Ensure parent folders exist
		const parts = vaultPath.split("/");
		for (let i = 1; i < parts.length; i++) {
			const folderPath = normalizePath(parts.slice(0, i).join("/"));
			if (!this.vault.getAbstractFileByPath(folderPath)) {
				try {
					await this.vault.createFolder(folderPath);
				} catch {
					// Folder may already exist
				}
			}
		}

		const existing = this.vault.getAbstractFileByPath(vaultPath);
		if (existing && "path" in existing) {
			await this.vault.modify(existing as import("obsidian").TFile, content);
		} else {
			try {
				await this.vault.create(vaultPath, content);
			} catch {
				// Vault cache may be stale — retry as modify
				const file = this.vault.getAbstractFileByPath(vaultPath);
				if (file && "path" in file) {
					await this.vault.modify(file as import("obsidian").TFile, content);
				}
			}
		}
	}

	private async deleteFile(vaultPath: string): Promise<void> {
		const file = this.vault.getAbstractFileByPath(vaultPath);
		if (file) {
			try {
				await this.fileManager.trashFile(file);
			} catch {
				// Ignore deletion errors
			}
		}
	}
}
