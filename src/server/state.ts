// Server-authoritative state for Review Lens. Owns instance metadata, the
// per-domain overview cache, the global chat transcript, and snapshot
// assembly. Every mutation in http.ts / extension.ts funnels through
// `pushSnapshot` so the renderer is always a pure render of the last snapshot.

import { CanvasError } from "@github/copilot-sdk/extension";

import type {
	ChatTurn,
	Disposition,
	Group,
	Overview,
	ReviewRollupState,
	Snapshot,
	TourStep,
} from "../shared/types.js";
import {
	coChangeGroups,
	computeDiff,
	repoRoot,
	resolveBaseRef,
	resolveRepoCwd,
	runGit,
} from "./git.js";
import { decompose, fanIn, scoreFile } from "./analysis.js";
import { broadcast, instanceIds, sendTo } from "./hub.js";
import { normalizeSteps } from "./prompts.js";
import {
	domainId,
	loadLedger,
	loadRecord,
	patchRecord,
	renameLedgerEntry,
	saveLedger,
	saveRecord,
	setFileReview,
	type StoredTour,
} from "./storage.js";

export interface InstanceMeta {
	cwd: string;
	repoPath: string | null;
	baseOverride: string | null;
	/** Pinned resolved base ref so repeat calls stay on one domain. */
	baseRef: string | null;
	domainId: string | null;
	/** Last overview failure, surfaced in the snapshot. */
	error: string | null;
}

export const instances = new Map<string, InstanceMeta>();
const overviewCache = new Map<string, Overview>();

// The submit_* tools run without an instanceId, so we track where a
// just-dispatched review request should land. lastReviewTarget is set the
// moment we ask the agent; activeInstanceId is the last panel we touched
// (open / getOverview) as a fallback.
let activeInstanceId: string | null = null;
let lastReviewTarget: { instanceId: string; domainId: string } | null = null;

// Tour requests in flight (asked the agent, no submit yet).
const pendingTours = new Set<string>();

// Global chat transcript mirrored into every panel.
const chat: ChatTurn[] = [];
let chatBusy = false;
let streamingText: string | null = null;

// --- Roll-ups -----------------------------------------------------------------

interface RollUp {
	state: ReviewRollupState;
	reviewed: number;
	total: number;
}

// Roll a set of file paths up into a single review state. `skip` counts as
// complete. Priority: stale (a reviewed file changed) > needs-work > reviewed
// (all complete, none stale) > partial (some dispositioned) > null (none).
function rollUpReview(
	paths: string[],
	byPath: Map<string, Overview["files"][number]>,
): RollUp {
	const files = (paths || []).map((p) => byPath.get(p)).filter((f) => !!f);
	const total = files.length;
	if (!total) return { state: null, reviewed: 0, total: 0 };
	let complete = 0;
	let anyStale = false;
	let anyNeedsWork = false;
	let anyDisposition = false;
	for (const f of files) {
		if (f.disposition) anyDisposition = true;
		if (f.disposition && f.reviewStale) anyStale = true;
		if (f.disposition === "needs-work") anyNeedsWork = true;
		if (f.disposition === "reviewed" || f.disposition === "skip") complete += 1;
	}
	let state: ReviewRollupState;
	if (anyStale) state = "stale";
	else if (anyNeedsWork) state = "needs-work";
	else if (complete === total) state = "reviewed";
	else if (anyDisposition) state = "partial";
	else state = null;
	return { state, reviewed: complete, total };
}

// --- Overview computation -------------------------------------------------------

async function computeOverview(
	cwd: string,
	baseOverride: string | null,
	pinnedDomain: string | null,
): Promise<Overview> {
	const root = await repoRoot(cwd);
	const baseRef = await resolveBaseRef(cwd, baseOverride);
	const diff = await computeDiff(cwd, baseRef);
	// The git layer is unreliable when the extension lacks a worktree handle
	// (baseRef/headSha can wobble across calls), which would otherwise make the
	// storage key drift so writes and reads land on different records. Once an
	// instance has pinned its domain we reuse it verbatim so they always agree.
	const domain = pinnedDomain || domainId(root, baseRef, diff.headSha);
	const record = await loadRecord(domain);

	const changedPaths = diff.files.map((f) => f.path);
	const coChange = await coChangeGroups(cwd, changedPaths).catch(() => new Map());
	const fanInMap = await fanIn(runGit, cwd, changedPaths).catch(() => new Map());

	// Head-independent review ledger: review state survives new commits and is
	// only flagged stale when a file's own content (or the merge-base) moves.
	const ledger = await loadLedger(root, baseRef);
	let ledgerDirty = false;

	const files: Overview["files"] = diff.files.map((f) => ({
		...f,
		risk: scoreFile(f, fanInMap.get(f.path) || 0),
		fanIn: fanInMap.get(f.path) || 0,
		disposition: null,
		reviewStale: false,
	}));

	for (const f of files) {
		// Rename migration: carry a reviewed entry from old path to new when the
		// content is unchanged, so a pure rename doesn't drop review state.
		if (
			(f.status === "R" || f.status === "C") &&
			f.oldPath &&
			!ledger.files[f.path] &&
			ledger.files[f.oldPath]?.sha === f.contentSha
		) {
			if (renameLedgerEntry(ledger, f.oldPath, f.path)) ledgerDirty = true;
		}

		// One-time seed from the legacy per-snapshot dispositions so in-progress
		// review state isn't lost on upgrade. Stamp the current fingerprint.
		if (!ledger.files[f.path] && record.dispositions?.[f.path]?.state) {
			ledger.files[f.path] = {
				state: record.dispositions[f.path].state,
				sha: f.contentSha,
				mergeBase: diff.mergeBase,
				at: record.dispositions[f.path].at || new Date().toISOString(),
			};
			ledgerDirty = true;
		}

		const entry = ledger.files[f.path] || null;
		f.disposition = entry?.state || null;
		f.reviewStale =
			!!entry && (entry.sha !== f.contentSha || entry.mergeBase !== diff.mergeBase);
	}

	const { groups: rawGroups, affinity } = decompose(diff.files, coChange);
	const byPath = new Map(files.map((f) => [f.path, f]));
	const groups: Group[] = rawGroups.map((g) => {
		const scores = g.files.map((p) => byPath.get(p)?.risk?.score || 0);
		const max = scores.length ? Math.max(...scores) : 0;
		const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
		const roll = rollUpReview(g.files, byPath);
		return {
			...g,
			risk: { score: max * 0.7 + avg * 0.3 },
			reviewState: roll.state,
			reviewedCount: roll.reviewed,
			fileCount: roll.total,
		};
	});
	groups.sort((a, b) => b.risk.score - a.risk.score);

	// Derive per-tour-step review state from the same ledger roll-up so the tour
	// reflects file-level reviewed-ness rather than a stored step disposition.
	let tour: Overview["tour"] = null;
	if (record.tour?.steps?.length) {
		const groupById = new Map(groups.map((g) => [g.id, g]));
		let anyPresent = false;
		const steps: TourStep[] = record.tour.steps.map((step) => {
			let stepFiles = Array.isArray(step.files) ? step.files : [];
			if (!stepFiles.length && step.groupId && groupById.has(step.groupId)) {
				stepFiles = groupById.get(step.groupId)?.files ?? [];
			}
			const roll = rollUpReview(stepFiles, byPath);
			return {
				...step,
				reviewState: roll.state,
				reviewedCount: roll.reviewed,
				fileCount: roll.total,
				// Files this step references that are no longer in the current diff —
				// the root cause of a step rendering a blank diff pane.
				missingFiles: stepFiles.filter((p) => !byPath.has(p)),
			};
		});
		for (const step of steps) {
			if (step.files.length && step.missingFiles.length < step.files.length)
				anyPresent = true;
		}
		// The whole tour is stale when the comparison window moved (merge-base
		// changed since the tour was stamped) or none of its files survive in the
		// current diff. The all-files-missing fallback also covers older tours
		// stamped before mergeBase/fingerprints were recorded.
		const baseMoved =
			!!record.tour.mergeBase && record.tour.mergeBase !== diff.mergeBase;
		tour = {
			steps,
			current: record.tour.current || 0,
			generatedAt: record.tour.generatedAt,
			mergeBase: record.tour.mergeBase ?? null,
			files: record.tour.files || [],
			stale: baseMoved || !anyPresent,
		};
	}

	if (ledgerDirty) await saveLedger(root, baseRef);

	const overview: Overview = {
		root,
		baseRef,
		baseOverride: record.base || null,
		mergeBase: diff.mergeBase,
		headSha: diff.headSha,
		headShort: diff.headShort,
		domain,
		totals: diff.totals,
		files,
		groups,
		affinity,
		tour,
	};
	overviewCache.set(domain, overview);
	return overview;
}

export async function getOverview(
	instanceId: string,
	{ force }: { force?: boolean } = {},
): Promise<Overview> {
	const meta = instances.get(instanceId);
	if (!meta) throw new CanvasError("no_instance", "Unknown canvas instance");
	activeInstanceId = instanceId;
	if (!force && meta.domainId) {
		const cached = overviewCache.get(meta.domainId);
		if (cached) return cached;
	}
	// Re-feed the previously resolved baseRef (not the raw override) so the git
	// layer resolves to the same ref every time, and pin the domain so the read
	// path matches whatever applyTour wrote.
	const overview = await computeOverview(
		meta.cwd,
		meta.baseRef ?? meta.baseOverride,
		meta.domainId,
	);
	meta.domainId = overview.domain;
	if (!meta.baseRef) meta.baseRef = overview.baseRef;
	meta.error = null;
	return overview;
}

// --- Snapshot assembly + push ---------------------------------------------------

export function assembleSnapshot(instanceId: string): Snapshot {
	const meta = instances.get(instanceId);
	const overview = meta?.domainId ? (overviewCache.get(meta.domainId) ?? null) : null;
	return {
		overview,
		tourPending: pendingTours.has(instanceId),
		chat: [...chat],
		chatBusy,
		error: meta?.error ?? null,
	};
}

/** Push the current snapshot to one panel. */
export function pushSnapshot(instanceId: string): void {
	sendTo(instanceId, "state", assembleSnapshot(instanceId));
}

/** Push each panel its own snapshot (chat/tour flags are shared, overview isn't). */
export function pushAllSnapshots(): void {
	for (const id of instanceIds()) pushSnapshot(id);
	// Panels that exist but have no SSE client yet are primed on connect.
}

/** Recompute the overview for a panel, then push. Marks errors in the snapshot. */
export async function refreshAndPush(
	instanceId: string,
	{ force = true }: { force?: boolean } = {},
): Promise<Overview | null> {
	try {
		const o = await getOverview(instanceId, { force });
		pushSnapshot(instanceId);
		return o;
	} catch (e) {
		const meta = instances.get(instanceId);
		if (meta) meta.error = String((e as Error)?.message || e);
		pushSnapshot(instanceId);
		return null;
	}
}

// --- Chat transcript ------------------------------------------------------------

export function chatUser(text: string): void {
	chat.push({ role: "user", text });
	chatBusy = true;
	streamingText = null;
	pushAllSnapshots();
}

export function chatDelta(text: string): void {
	// Token stream is the one non-snapshot event: cheap, high-frequency.
	streamingText = (streamingText ?? "") + text;
	broadcast("chat-delta", { text });
}

export function chatFinal(text: string): void {
	chat.push({ role: "assistant", text: text || streamingText || "" });
	streamingText = null;
	pushAllSnapshots();
}

export function chatErrorTurn(message: string): void {
	chat.push({ role: "assistant", text: `⚠ ${message}` });
	streamingText = null;
	chatBusy = false;
	pushAllSnapshots();
}

export function chatIdle(): void {
	chatBusy = false;
	streamingText = null;
	// Watchdog: if a tour request errored out in the agent without ever
	// producing a submit, un-stick the pending state when the turn ends.
	pendingTours.clear();
	pushAllSnapshots();
}

// --- Review writes ----------------------------------------------------------------

// Resolve a review key into the concrete file paths it covers.
//   "group:<id>" -> that group's files
//   "step:<index>" -> that tour step's files (or its group's files)
//   anything else  -> a single file path
export function resolveReviewPaths(overview: Overview, key: string): string[] {
	if (typeof key !== "string" || !key) return [];
	if (key.startsWith("group:")) {
		const id = key.slice("group:".length);
		const g = overview.groups?.find((x) => x.id === id);
		return g ? [...g.files] : [];
	}
	if (key.startsWith("step:")) {
		const idx = Number.parseInt(key.slice("step:".length), 10);
		const step = overview.tour?.steps?.[idx];
		if (!step) return [];
		if (Array.isArray(step.files) && step.files.length) return [...step.files];
		if (step.groupId) {
			const g = overview.groups?.find((x) => x.id === step.groupId);
			return g ? [...g.files] : [];
		}
		return [];
	}
	return [key];
}

// Write a review state for every path, stamping each with its CURRENT content
// fingerprint so staleness is measured from this moment.
export async function applyReview(
	overview: Overview,
	paths: string[],
	state: Disposition | null,
): Promise<void> {
	const byPath = new Map(overview.files.map((f) => [f.path, f]));
	for (const p of paths) {
		const f = byPath.get(p);
		const fingerprint = { sha: f?.contentSha ?? null, mergeBase: overview.mergeBase };
		await setFileReview(overview.root, overview.baseRef, p, state ?? null, fingerprint);
	}
}

// --- Tour lifecycle ----------------------------------------------------------------

export type SendPrompt = (prompt: string) => Promise<unknown>;

let sendPrompt: SendPrompt = async () => {
	throw new Error("session not ready");
};

export function bindSession(fn: SendPrompt): void {
	sendPrompt = fn;
}

/** Fire a prompt into the live session (errors become chat turns). */
export function dispatchPrompt(prompt: string): void {
	sendPrompt(prompt).catch((e) => chatErrorTurn(String((e as Error)?.message || e)));
}

export async function requestTour(
	instanceId: string,
	{ regenerate, buildPrompt }: { regenerate?: boolean; buildPrompt: (o: Overview) => string },
): Promise<void> {
	const overview = await getOverview(instanceId, { force: true });
	lastReviewTarget = { instanceId, domainId: overview.domain };
	pendingTours.add(instanceId);
	const note = regenerate
		? "Regenerate the guided review tour from scratch."
		: "Start the guided review tour.";
	chatUser(note);
	dispatchPrompt(buildPrompt(overview));
	pushSnapshot(instanceId);
}

// Pick the panel a tool result should land on: the panel we last dispatched a
// request from, else the last-touched panel, else any instance with a domain.
function resolveReviewTarget(): { instanceId: string; domainId: string } | null {
	if (lastReviewTarget && instances.has(lastReviewTarget.instanceId)) {
		return lastReviewTarget;
	}
	if (activeInstanceId && instances.has(activeInstanceId)) {
		const meta = instances.get(activeInstanceId);
		if (meta?.domainId)
			return { instanceId: activeInstanceId, domainId: meta.domainId };
	}
	for (const [instanceId, meta] of instances) {
		if (meta?.domainId) return { instanceId, domainId: meta.domainId };
	}
	return null;
}

// Called by the submit_review_tour tool when the agent returns the steps.
// The agent ran `git diff` inside the real worktree, so it also reports back the
// worktree path + base ref it used. The extension's own cwd is unreliable (a
// user-scope provider process is shared across sessions and does not chdir into
// the session's worktree), so we re-pin the target panel to the agent's worktree
// + base here — that is what makes the canvas's own diff line up with the tour's
// steps instead of computing an empty diff against the wrong directory.
export async function applyTour(
	rawSteps: unknown,
	{ repoPath, base }: { repoPath?: string; base?: string } = {},
): Promise<StoredTour> {
	const steps = normalizeSteps(rawSteps);
	if (!steps) throw new CanvasError("tour_invalid", "No usable tour steps");
	const target = resolveReviewTarget();
	if (!target) throw new CanvasError("no_target", "No open review panel");

	const meta = instances.get(target.instanceId);
	if (meta) {
		let repinned = false;
		if (repoPath) {
			const cwd = await resolveRepoCwd([repoPath]);
			if (cwd && cwd !== meta.cwd) {
				meta.cwd = cwd;
				meta.repoPath = repoPath;
				repinned = true;
			}
		}
		if (base && base !== meta.baseOverride) {
			meta.baseOverride = base;
			repinned = true;
		}
		// A new worktree or base invalidates the pinned domain + resolved ref so
		// the next getOverview recomputes against the agent's window.
		if (repinned) {
			meta.baseRef = null;
			meta.domainId = null;
		}
	}

	// Stamp the tour with the diff window it was built against (merge-base + the
	// changed files and their content fingerprints) so we can later detect when
	// the diff has moved out from under it and the steps point at files that are
	// no longer in the changeset.
	const overviewBefore = await getOverview(target.instanceId, { force: true });
	const tour: StoredTour = {
		steps,
		current: 0,
		generatedAt: new Date().toISOString(),
		mergeBase: overviewBefore.mergeBase,
		files: overviewBefore.files.map((f) => ({ path: f.path, sha: f.contentSha })),
	};
	// Re-pinning can move the domain, so persist against the freshly resolved one.
	await patchRecord(overviewBefore.domain, { tour });
	pendingTours.delete(target.instanceId);
	await refreshAndPush(target.instanceId);
	return tour;
}

// --- Misc accessors --------------------------------------------------------------

export function setActiveInstance(instanceId: string): void {
	activeInstanceId = instanceId;
}

export function dropInstanceState(instanceId: string): void {
	instances.delete(instanceId);
	pendingTours.delete(instanceId);
}

export { loadRecord, patchRecord, saveRecord };
