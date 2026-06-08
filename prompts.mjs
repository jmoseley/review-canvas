// Prompt builders + response parsers for the Canvas → agent delegation.
// Every model call asks for strict JSON we can render with its evidence.
// The model produces *hints*; deterministic git facts stay authoritative.

function fileLines(overview, max = 60) {
	return overview.files
		.slice(0, max)
		.map(
			(f) =>
				`- ${f.path} (${f.status}, +${f.additions}/-${f.deletions}${
					f.risk ? `, risk ${f.risk.score.toFixed(2)}` : ""
				})`,
		)
		.join("\n");
}

// Lists every concern group WITH its file paths (no truncation) so the model
// can map each tour step onto a real group + real files. Cheap metadata only —
// the actual diff content is fetched by the agent itself (see buildTourPrompt).
function groupBlocks(overview) {
	if (!overview.groups.length) {
		return "(no precomputed groups — inspect the diff and choose your own grouping)";
	}
	return overview.groups
		.map((g) => {
			const head = `- [${g.id}] ${g.label}: ${g.files.length} file(s), +${g.additions}/-${g.deletions}, risk ${
				g.risk?.score?.toFixed(2) ?? "?"
			}`;
			const files = g.files.map((p) => `    • ${p}`).join("\n");
			return files ? `${head}\n${files}` : head;
		})
		.join("\n");
}

export function buildTourPrompt(overview) {
	const canvasResolved = overview.totals.files > 0;
	const canvasSummary = canvasResolved
		? `The canvas's own heuristics see this diff (use as a hint; re-verify against your own diff):
Base: ${overview.baseRef} (merge-base ${overview.mergeBase?.slice(0, 12)})
Head: ${overview.headShort} (working tree)
Totals: ${overview.totals.files} files, +${overview.totals.additions}/-${overview.totals.deletions}

Concern groups (risk-scored, higher = review sooner) — map each step onto one group when it fits:
${groupBlocks(overview)}`
		: `The canvas could NOT resolve the diff on its own (it does not know which worktree you are in). Do not trust any file/line counts from the canvas — discover everything yourself below, then report the worktree back so the canvas can re-target.`;

	return `You are helping a human review a large, AI-generated change slice. Assume the reviewer is reviewing ALL of the changes in this workspace — the entire diff between the base and the current working tree. Produce an ordered "guided review tour": a sequence of bite-sized steps that walks the reviewer through the change most-important-first, so they can understand each piece within the scope of the whole.

GROUND EVERYTHING IN THE REAL DIFF — do not reuse any earlier tour and do not guess from file names. Discover the worktree and base yourself, in your own shell, from your current working directory:
  1. Worktree root:   root=$(git rev-parse --show-toplevel)
  2. Base ref (first that works):
       - the PR base:        gh pr view --json baseRefName -q .baseRefName  (prefix with origin/ if it is a remote branch)
       - the default branch: git -C "$root" symbolic-ref --short refs/remotes/origin/HEAD
       - fallback:           origin/main  or  origin/master
  3. Full change (committed + uncommitted):  git -C "$root" diff --find-renames "$base"
Open the changed files as needed so every step is grounded in the actual code. If \`git rev-parse --show-toplevel\` fails, you are not in a git worktree — say so and stop rather than inventing a tour.

${canvasSummary}

For each step return:
- "title": short human label for the chunk
- "groupId": the concern-group id this step focuses (from the list above, if any), or null
- "files": array of file paths the step covers (must be real changed files from YOUR diff)
- "purpose": 1-2 sentences, plain English, what this chunk does
- "whereItSits": 1-2 sentences on how it connects to the rest of the app/other steps (callers, callees, dependents)
- "scrutinize": array of 1-4 specific things the reviewer should verify or be suspicious of

Order steps by review priority (highest-risk / most-foundational first). Aim for 4-12 steps.

When you have the ordered steps, call the \`submit_review_tour\` tool — do NOT print the JSON in chat; the canvas renders the tour the moment you call the tool. Pass:
- "repoPath": the absolute "$root" you ran \`git\` in (REQUIRED — the canvas re-targets its diff to this worktree so its view matches your tour)
- "base": the "$base" ref you diffed against (so the canvas computes the same merge-base)
- "steps": [{"title","groupId","files","purpose","whereItSits","scrutinize"}]`;
}

export function parseTourResponse(text) {
	const obj = extractJson(text);
	return obj ? normalizeSteps(obj.steps) : null;
}

// Coerce already-parsed tour steps (from the tool args or a parsed reply) into
// the canonical, indexed shape the renderer + storage expect.
export function normalizeSteps(rawSteps) {
	if (!Array.isArray(rawSteps)) return null;
	const steps = rawSteps
		.map((s, i) => ({
			index: i,
			title: String(s?.title || `Step ${i + 1}`),
			groupId: s?.groupId ?? null,
			files: Array.isArray(s?.files) ? s.files.map(String) : [],
			purpose: String(s?.purpose || ""),
			whereItSits: String(s?.whereItSits || ""),
			scrutinize: Array.isArray(s?.scrutinize) ? s.scrutinize.map(String) : [],
		}))
		.filter((s) => s.title);
	return steps.length ? steps : null;
}

// Tolerant JSON extraction: handles accidental ```json fences or surrounding prose.
function extractJson(text) {
	if (!text) return null;
	let s = String(text).trim();
	const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) s = fence[1].trim();
	try {
		return JSON.parse(s);
	} catch {
		// fall through to brace scanning
	}
	const start = s.indexOf("{");
	const end = s.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(s.slice(start, end + 1));
		} catch {
			return null;
		}
	}
	return null;
}
