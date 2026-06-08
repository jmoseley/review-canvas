// Deterministic git facts for Review Lens. Everything here is a hard fact
// (no model judgment): merge-base detection, diff computation, per-file hunks,
// and lightweight co-change history used to seed decomposition.

import { execFile } from "node:child_process";
import type { FileEntry, FileStatus, Totals } from "../shared/types.js";

const EXEC_OPTS = {
	maxBuffer: 32 * 1024 * 1024,
	timeout: 30_000,
	env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat", NO_COLOR: "1" },
};

/** A diff file before risk/disposition decoration (see state.ts). */
export type DiffFile = Pick<
	FileEntry,
	| "path"
	| "oldPath"
	| "status"
	| "additions"
	| "deletions"
	| "noise"
	| "renameOnly"
	| "contentSha"
>;

export interface DiffResult {
	baseRef: string;
	mergeBase: string;
	headSha: string;
	headShort: string;
	files: DiffFile[];
	totals: Totals;
}

export function runGit(cwd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile("git", ["-C", cwd, ...args], EXEC_OPTS, (err, stdout, stderr) => {
			if (err) {
				(err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
				reject(err);
				return;
			}
			resolve(stdout);
		});
	});
}

// Like runGit, but feeds `input` to the child's stdin. Used for
// `hash-object --stdin-paths`, which avoids argv length limits on huge diffs.
function runGitStdin(cwd: string, args: string[], input: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["-C", cwd, ...args],
			EXEC_OPTS,
			(err, stdout, stderr) => {
				if (err) {
					(err as NodeJS.ErrnoException & { stderr?: string }).stderr = stderr;
					reject(err);
					return;
				}
				resolve(stdout);
			},
		);
		child.stdin?.end(input);
	});
}

// Content fingerprint per file: the working-tree blob sha (what the reviewer
// actually sees, including uncommitted edits). Lets review state be
// content-addressed so it survives new commits when a file's content is
// unchanged. Deleted files get a sentinel. Paths are repo-relative; cwd is the
// repo toplevel, so `--stdin-paths` resolves them correctly.
async function attachContentShas(cwd: string, files: DiffFile[]): Promise<void> {
	for (const f of files) f.contentSha = f.status === "D" ? "deleted" : null;
	const hashable = files.filter((f) => f.status !== "D");
	if (!hashable.length) return;
	try {
		const input = `${hashable.map((f) => f.path).join("\n")}\n`;
		const out = await runGitStdin(cwd, ["hash-object", "--stdin-paths"], input);
		const shas = out.split("\n").map((s) => s.trim());
		hashable.forEach((f, i) => {
			f.contentSha = shas[i] || null;
		});
	} catch {
		// Leave contentSha null; such files are treated as always-changed.
	}
}

async function tryGit(cwd: string, args: string[], fallback = ""): Promise<string> {
	try {
		return (await runGit(cwd, args)).trim();
	} catch {
		return fallback;
	}
}

// Ask `gh` for the base branch of the PR associated with the current worktree
// branch. This mirrors the app's top-priority `source_pr_base_ref` signal and
// is the most authoritative auto-detected base. Returns "" when gh is missing,
// unauthenticated, or the branch has no PR.
function tryGhPrBase(cwd: string): Promise<string> {
	return new Promise((resolve) => {
		execFile(
			"gh",
			["pr", "view", "--json", "baseRefName", "-q", ".baseRefName"],
			{ ...EXEC_OPTS, cwd, timeout: 8_000 },
			(err, stdout) => resolve(err ? "" : stdout.trim()),
		);
	});
}

export async function repoRoot(cwd: string): Promise<string> {
	const root = await tryGit(cwd, ["rev-parse", "--show-toplevel"]);
	return root || cwd;
}

// Pick the git worktree the review should target. The SDK's
// `session.workspacePath` is, in this app, the per-session *attachments*
// directory (not a git repo), while the CLI's cwd is the actual worktree that
// holds the changes. Walk the candidates in order and return the toplevel of
// the first one that is inside a git repository, honoring an explicit
// workspace path when it happens to be a repo. Falls back to the first
// truthy candidate (or process.cwd()) when none are git-backed.
export async function resolveRepoCwd(
	candidates: (string | null | undefined)[],
): Promise<string> {
	for (const candidate of candidates) {
		if (!candidate) continue;
		const root = await tryGit(candidate, ["rev-parse", "--show-toplevel"]);
		if (root) return root;
	}
	return candidates.find(Boolean) || process.cwd();
}

// Resolve the base ref the workspace should be reviewed against. Preference:
//   1. an explicit base (canvas `input.base` from the agent, or user `set_base`)
//   2. the PR base branch via `gh` (≈ the app's source_pr_base_ref)
//   3. the remote default branch (origin/HEAD ≈ the project default branch)
//   4. a local main/master
//   5. HEAD~1 (last resort)
// We deliberately do NOT use the branch's own upstream (@{u}): for a pushed
// feature branch @{u} is its own remote tracking ref, so merge-base @{u} HEAD
// collapses to ~HEAD and yields a near-empty review diff.
export async function resolveBaseRef(
	cwd: string,
	explicitBase?: string | null,
): Promise<string> {
	if (explicitBase) return explicitBase;

	const prBase = await tryGhPrBase(cwd);
	if (prBase) return prBase;

	const originHead = await tryGit(cwd, [
		"symbolic-ref",
		"--short",
		"refs/remotes/origin/HEAD",
	]);
	if (originHead) return originHead;

	for (const candidate of ["origin/main", "origin/master", "main", "master"]) {
		const ok = await tryGit(cwd, ["rev-parse", "--verify", "--quiet", candidate]);
		if (ok) return candidate;
	}
	return "HEAD~1";
}

export async function listBaseCandidates(cwd: string): Promise<string[]> {
	const out = await tryGit(cwd, [
		"for-each-ref",
		"--format=%(refname:short)",
		"refs/heads",
		"refs/remotes",
	]);
	const refs = out
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean)
		.filter((r) => !r.endsWith("/HEAD"));
	return Array.from(new Set(refs)).slice(0, 200);
}

const NOISE_PATTERNS = [
	/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|composer\.lock)$/,
	/(^|\/)(dist|build|out|coverage|node_modules|vendor)\//,
	/\.(min\.js|min\.css|map|snap)$/,
	/(^|\/)__snapshots__\//,
];

export function isNoiseFile(path: string): boolean {
	return NOISE_PATTERNS.some((re) => re.test(path));
}

// Compute the structural diff between the merge-base and the working tree.
export async function computeDiff(cwd: string, baseRef: string): Promise<DiffResult> {
	const headSha = (await tryGit(cwd, ["rev-parse", "HEAD"])) || "WORKTREE";
	const headShort = headSha.slice(0, 12);
	let mergeBase = await tryGit(cwd, ["merge-base", baseRef, "HEAD"]);
	if (!mergeBase) mergeBase = baseRef;

	// name-status + numstat against the merge-base, including uncommitted work.
	const nameStatus = await tryGit(cwd, [
		"diff",
		"--no-color",
		"--find-renames",
		"--name-status",
		mergeBase,
	]);
	const numstat = await tryGit(cwd, [
		"diff",
		"--no-color",
		"--find-renames",
		"--numstat",
		mergeBase,
	]);

	const churn = new Map<string, { additions: number; deletions: number }>();
	for (const line of numstat.split("\n")) {
		if (!line.trim()) continue;
		const [add, del, ...rest] = line.split("\t");
		const path = rest.join("\t");
		const realPath = path.includes(" => ")
			? path.replace(/.*\{.*=> (.*)\}.*/, "$1").replace(/.* => /, "")
			: path;
		churn.set(realPath, {
			additions: add === "-" ? 0 : Number(add) || 0,
			deletions: del === "-" ? 0 : Number(del) || 0,
		});
	}

	const files: DiffFile[] = [];
	for (const line of nameStatus.split("\n")) {
		if (!line.trim()) continue;
		const parts = line.split("\t");
		const code = parts[0];
		const status = code[0] as FileStatus;
		let path = parts[1];
		let oldPath: string | null = null;
		if (status === "R" || status === "C") {
			oldPath = parts[1];
			path = parts[2];
		}
		const c = churn.get(path) || { additions: 0, deletions: 0 };
		files.push({
			path,
			oldPath,
			status,
			additions: c.additions,
			deletions: c.deletions,
			noise: isNoiseFile(path),
			renameOnly:
				(status === "R" || status === "C") &&
				c.additions === 0 &&
				c.deletions === 0,
			contentSha: null,
		});
	}

	files.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));

	await attachContentShas(cwd, files);

	return {
		baseRef,
		mergeBase,
		headSha,
		headShort,
		files,
		totals: {
			files: files.length,
			additions: files.reduce((n, f) => n + f.additions, 0),
			deletions: files.reduce((n, f) => n + f.deletions, 0),
		},
	};
}

// Full unified diff text for one file (used by the inspector pane).
export async function fileDiff(
	cwd: string,
	mergeBase: string,
	path: string,
): Promise<string> {
	return tryGit(cwd, ["diff", "--no-color", "--find-renames", mergeBase, "--", path]);
}

/** "a\u0000b" pair key -> co-change count. */
export type CoChangeMap = Map<string, number>;

// Files that historically change together with the changed set, mined from
// recent history. Used as a decomposition signal (co-change cohesion).
export async function coChangeGroups(
	cwd: string,
	changedPaths: string[],
	limit = 150,
): Promise<CoChangeMap> {
	const changed = new Set(changedPaths);
	const out = await tryGit(cwd, [
		"log",
		`-n${limit}`,
		"--no-color",
		"--name-only",
		"--pretty=format:%x00",
	]);
	const commits = out.split("\u0000");
	const pairCounts: CoChangeMap = new Map();
	for (const commit of commits) {
		const paths = commit
			.split("\n")
			.map((s) => s.trim())
			.filter((s) => s && changed.has(s));
		const uniq = Array.from(new Set(paths));
		for (let i = 0; i < uniq.length; i++) {
			for (let j = i + 1; j < uniq.length; j++) {
				const key = [uniq[i], uniq[j]].sort().join("\u0000");
				pairCounts.set(key, (pairCounts.get(key) || 0) + 1);
			}
		}
	}
	return pairCounts;
}
