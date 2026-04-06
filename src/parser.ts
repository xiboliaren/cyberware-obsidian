/**
 * Parses Cyber Pilot cpt-* identifiers in markdown content.
 *
 * Architecture:
 * - All cpt-* mentions become simple [[cpt-xxx]] wikilinks to ID node pages.
 * - Each unique ID gets a separate node page that links back to its defining document.
 * - This creates a graph: Document A (defines) ←→ cpt-xxx node ←→ Document B (references).
 * - @cpt-* code markers and fenced code blocks are left untouched.
 */

import { normalizePath } from "obsidian";

// Matches `cpt-xxx` inside single backticks
const CPT_BACKTICK_REGEX = /`(cpt-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)`/g;

// Matches bare cpt-xxx in prose — excludes wikilink brackets, backticks, @markers
const CPT_BARE_REGEX =
	/(?<![`@\w[])(cpt-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?![`\w\]-])/g;

// Matches markdown links wrapping backtick cpt IDs: [`cpt-xxx`](url)
const CPT_MD_LINK_REGEX =
	/\[`(cpt-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)`\]\([^)]*\)/g;

// Matches definition sites: **ID**: `cpt-xxx`
const CPT_DEFINITION_REGEX =
	/\*\*ID\*\*:\s*`(cpt-[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)`/g;

/**
 * Scan markdown content and extract all cpt-* IDs (from backtick and bare occurrences).
 */
export function extractIds(content: string): string[] {
	const ids = new Set<string>();
	let m: RegExpExecArray | null;

	CPT_BACKTICK_REGEX.lastIndex = 0;
	while ((m = CPT_BACKTICK_REGEX.exec(content)) !== null) {
		if (m[1]) ids.add(m[1]);
	}

	CPT_BARE_REGEX.lastIndex = 0;
	while ((m = CPT_BARE_REGEX.exec(content)) !== null) {
		if (m[1]) ids.add(m[1]);
	}

	return [...ids];
}

/**
 * Extract IDs from explicit definition sites: **ID**: `cpt-xxx`
 */
export function extractDefinitions(content: string): string[] {
	const ids = new Set<string>();
	let m: RegExpExecArray | null;

	CPT_DEFINITION_REGEX.lastIndex = 0;
	while ((m = CPT_DEFINITION_REGEX.exec(content)) !== null) {
		if (m[1]) ids.add(m[1]);
	}

	return [...ids];
}

/**
 * Build a map of cpt ID → vault-relative file path where it is defined.
 * Only considers explicit **ID**: `cpt-xxx` patterns as definitions.
 */
export function buildDefinitionMap(
	allFiles: { vaultPath: string; content: string }[]
): Map<string, string> {
	const defMap = new Map<string, string>();
	for (const file of allFiles) {
		const defs = extractDefinitions(file.content);
		for (const id of defs) {
			if (!defMap.has(id)) {
				defMap.set(id, file.vaultPath);
			}
		}
	}
	return defMap;
}

/**
 * Transform markdown content: replace cpt-* identifiers with [[wikilinks]].
 *
 * - `cpt-xxx` (in backticks) → [[cpt-xxx]]
 * - cpt-xxx (bare in prose) → [[cpt-xxx]]
 * - Fenced code blocks and @cpt-* markers are left untouched.
 */
export function transformContent(content: string): string {
	// Split by fenced code blocks — protect them from transformation
	const parts = content.split(/(```[\s\S]*?```)/g);

	return parts
		.map((part, i) => {
			// Odd indices are fenced code blocks — leave untouched
			if (i % 2 === 1) return part;

			let result = part;

			// 1. Replace markdown links wrapping cpt IDs: [`cpt-xxx`](url) → [[cpt-xxx]]
			result = result.replace(
				CPT_MD_LINK_REGEX,
				(_m, id: string) => `[[${id}]]`
			);

			// 2. Replace backtick-wrapped cpt IDs: `cpt-xxx` → [[cpt-xxx]]
			result = result.replace(
				CPT_BACKTICK_REGEX,
				(_m, id: string) => `[[${id}]]`
			);

			// 3. Replace bare cpt IDs in prose: cpt-xxx → [[cpt-xxx]]
			result = result.replace(
				CPT_BARE_REGEX,
				(_m, id: string) => `[[${id}]]`
			);

			return result;
		})
		.join("");
}

export interface NodePage {
	id: string;
	vaultPath: string;
	content: string;
}

/**
 * Generate node page files for every unique cpt-* ID found across all documents.
 * - Defined IDs → "Artifacts" folder, tagged "artifact", with "Defined in [[file]]".
 * - Undefined IDs → "Undefined" folder, tagged "undefined", with static notice text.
 */
export function generateNodePages(
	allIds: Set<string>,
	definitionMap: Map<string, string>,
	artifactsFolder: string,
	undefinedFolder: string
): NodePage[] {
	const pages: NodePage[] = [];
	for (const id of allIds) {
		const definingFile = definitionMap.get(id);
		if (definingFile) {
			const basename = definingFile.replace(/\.md$/i, "");
			const vaultPath = normalizePath(`${artifactsFolder}/${id}.md`);
			const content = `---\ntags:\n  - artifact\n---\nDefined in [[${basename}]]\n`;
			pages.push({ id, vaultPath, content });
		} else {
			const vaultPath = normalizePath(`${undefinedFolder}/${id}.md`);
			const content =
				`---\ntags:\n  - undefined\n---\n` +
				`This artifact has been mentioned in one or more documents ` +
				`but it's not defined anywhere in visible documents.\n`;
			pages.push({ id, vaultPath, content });
		}
	}
	return pages;
}
