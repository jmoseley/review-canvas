// Deterministic, explainable heuristics layered on top of the git facts.
// These are *attention hints*, never gates. Every score ships with the
// evidence that produced it so the UI can show the "why", not just a number.

import { fileDiff, type CoChangeMap, type DiffFile, runGit } from "./git.js";
import type { Affinity, RiskScore, SuspicionFlag } from "../shared/types.js";

const SECURITY_KEYWORDS =
	/\b(password|secret|token|auth|crypto|jwt|hmac|sql|exec|eval|child_process|innerHTML|dangerouslySetInnerHTML|cors|cookie|session|privilege|sudo|chmod|deserialize)\b/i;

const TEST_PATH = /(\.(test|spec)\.[jt]sx?$|(^|\/)(tests?|__tests__)\/)/i;

export interface RawGroup {
	id: string;
	label: string;
	files: string[];
	additions: number;
	deletions: number;
}

function topDir(path: string): string {
	const parts = path.split("/");
	if (parts.length <= 1) return "(root)";
	// Group by up to two leading segments for a useful granularity.
	return parts.slice(0, Math.min(2, parts.length - 1)).join("/");
}

// Partition the changed files into concern groups. Heuristics, in order:
//   - directory/module proximity (primary)
//   - rename/move-only files split into their own "moves" group
//   - co-change cohesion can later merge dirs (data available, applied softly)
export function decompose(
	files: DiffFile[],
	coChange: CoChangeMap | null,
): { groups: RawGroup[]; affinity: Affinity[] } {
	const groups = new Map<string, RawGroup>();

	const ensure = (key: string, label: string): RawGroup => {
		let g = groups.get(key);
		if (!g) {
			g = { id: key, label, files: [], additions: 0, deletions: 0 };
			groups.set(key, g);
		}
		return g;
	};

	for (const f of files) {
		let key: string;
		let label: string;
		if (f.renameOnly) {
			key = "moves";
			label = "Moves & renames";
		} else if (f.noise) {
			key = "generated";
			label = "Generated / lockfiles";
		} else if (TEST_PATH.test(f.path)) {
			key = `tests:${topDir(f.path)}`;
			label = `Tests · ${topDir(f.path)}`;
		} else {
			key = `dir:${topDir(f.path)}`;
			label = topDir(f.path);
		}
		const g = ensure(key, label);
		g.files.push(f.path);
		g.additions += f.additions;
		g.deletions += f.deletions;
	}

	// Soft co-change merge: if two dir-groups share many co-changing files,
	// note the affinity (used as evidence, not auto-merged to stay transparent).
	const affinity: Affinity[] = [];
	if (coChange) {
		for (const [key, count] of coChange.entries()) {
			if (count >= 2) {
				const [a, b] = key.split("\u0000");
				affinity.push({ a, b, count });
			}
		}
	}

	return {
		groups: Array.from(groups.values()),
		affinity: affinity.sort((x, y) => y.count - x.count).slice(0, 20),
	};
}

// Lightweight JS/TS fan-in: how many *unchanged* files import a changed module.
// Best-effort regex scan; degrades gracefully for other languages.
export async function fanIn(
	git: typeof runGit,
	cwd: string,
	changedPaths: string[],
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	const jsish = changedPaths.filter((p) => /\.[jt]sx?$/.test(p));
	if (jsish.length === 0) return result;

	// Without parsing every importer, approximate by basename references.
	for (const path of jsish) {
		const base = path.replace(/\.[jt]sx?$/, "").split("/").pop();
		if (!base) continue;
		let count = 0;
		try {
			const hits = await git(cwd, [
				"grep",
				"-I",
				"-l",
				"-E",
				`(from ['\"].*${escapeRe(base)}['\"]|require\\(['\"].*${escapeRe(base)})`,
			]).catch(() => "");
			count = hits
				.split("\n")
				.map((s) => s.trim())
				.filter((s) => s && !changedPaths.includes(s)).length;
		} catch {
			count = 0;
		}
		result.set(path, count);
	}
	return result;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per-file risk score in [0,1] with the evidence behind it.
export function scoreFile(file: DiffFile, fanInCount: number): RiskScore {
	const reasons: string[] = [];
	let score = 0;

	const churn = file.additions + file.deletions;
	if (churn > 400) {
		score += 0.25;
		reasons.push(`Large change (${churn} lines)`);
	} else if (churn > 150) {
		score += 0.15;
		reasons.push(`Sizable change (${churn} lines)`);
	}

	if (file.status === "A" && file.additions > 80) {
		score += 0.15;
		reasons.push("Large net-new file");
	}

	if (fanInCount > 0) {
		const bump = Math.min(0.3, 0.06 * fanInCount);
		score += bump;
		reasons.push(`${fanInCount} file(s) may depend on this (fan-in)`);
	}

	if (SECURITY_KEYWORDS.test(file.path)) {
		score += 0.1;
		reasons.push("Security-sensitive path");
	}

	if (file.noise) {
		score = Math.min(score, 0.1);
		reasons.length = 0;
		reasons.push("Generated/lockfile — low signal");
	}

	return { score: Math.min(1, score), reasons };
}

// Per-file suspicion flags mined from the actual diff text. These fight
// rubber-stamping: each flag costs the reviewer an explicit disposition.
export async function suspicionFlags(
	cwd: string,
	mergeBase: string,
	file: DiffFile,
): Promise<SuspicionFlag[]> {
	if (file.noise || file.renameOnly) return [];
	const flags: SuspicionFlag[] = [];
	const text = await fileDiff(cwd, mergeBase, file.path).catch(() => "");
	if (!text) return flags;

	const added = text
		.split("\n")
		.filter((l) => l.startsWith("+") && !l.startsWith("+++"))
		.map((l) => l.slice(1));

	if (TEST_PATH.test(file.path)) {
		const hasAssertion = added.some((l) =>
			/\b(expect|assert|should|toBe|toEqual|toThrow|assertEquals|require\(.assert)/.test(
				l,
			),
		);
		const hasTestCase = added.some((l) => /\b(it|test|describe)\s*\(/.test(l));
		if (hasTestCase && !hasAssertion) {
			flags.push({
				kind: "assertion-free-test",
				message: "New test cases with no visible assertions",
				severity: "high",
			});
		}
	}

	if (file.status === "A" && SECURITY_KEYWORDS.test(text)) {
		flags.push({
			kind: "security-net-new",
			message: "Net-new file touches security-sensitive APIs",
			severity: "high",
		});
	}

	const todoCount = added.filter((l) => /\b(TODO|FIXME|XXX|HACK)\b/.test(l)).length;
	if (todoCount > 0) {
		flags.push({
			kind: "todo-markers",
			message: `${todoCount} TODO/FIXME marker(s) added`,
			severity: "low",
		});
	}

	const emptyCatch = /catch\s*\([^)]*\)\s*\{\s*\}/;
	if (added.some((l) => emptyCatch.test(l)) || emptyCatch.test(text)) {
		flags.push({
			kind: "swallowed-error",
			message: "Possible swallowed error (empty catch block)",
			severity: "medium",
		});
	}

	return flags;
}
