export interface RepoConfig {
	url: string;
	enabled: boolean;
}

export interface CyberwareSettings {
	repos: RepoConfig[];
	githubToken: string;
	syncFolder: string;
	autoSyncOnStart: boolean;
}

export const DEFAULT_SETTINGS: CyberwareSettings = {
	repos: [],
	githubToken: "",
	syncFolder: "Cyberware repos",
	autoSyncOnStart: false,
};

export interface SyncState {
	repos: Record<string, RepoSyncState>;
	nodePages?: string[];
}

export interface RepoSyncState {
	lastSha: string;
	lastSync: number;
	files: string[];
}

export interface GitHubTreeItem {
	path: string;
	type: string;
	sha: string;
	url: string;
}

export interface ParsedRepo {
	owner: string;
	repo: string;
	branch: string;
}
