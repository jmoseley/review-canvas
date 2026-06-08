// Review Lens — a canvas for understanding large, AI-generated change slices.
//
// Wiring only: the deterministic git layer (git.mjs), heuristics (analysis.mjs),
// durable state (storage.mjs), and agent-delegation prompts (prompts.mjs) live
// in sibling modules. This file runs one shared loopback server (instanceId in
// the query string), computes/caches the review overview per domain, serves the
// iframe + SSE, and bridges the chat dock to the live session.

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, CanvasError, joinSession } from "@github/copilot-sdk/extension";

import {
	coChangeGroups,
	computeDiff,
	fileDiff,
	listBaseCandidates,
	repoRoot,
	resolveBaseRef,
	resolveRepoCwd,
	runGit,
} from "./git.mjs";
import {
	decompose,
	fanIn,
	scoreFile,
	suspicionFlags,
} from "./analysis.mjs";
import {
	buildTourPrompt,
	normalizeSteps,
} from "./prompts.mjs";
import {
	domainId,
	loadLedger,
	loadRecord,
	patchRecord,
	renameLedgerEntry,
	saveLedger,
	saveRecord,
	setFileReview,
} from "./storage.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let session;
let shared = null; // { server, url }
const instances = new Map(); // instanceId -> { cwd, domainId }
const sseClients = new Map(); // instanceId -> Set<res>
const overviewCache = new Map(); // domainId -> overview

// The submit_* tools run without an instanceId, so we track where a just-dispatched
// review request should land. lastReviewTarget is set the moment we ask the agent;
// activeInstanceId is the last panel we touched (open / getOverview) as a fallback.
let activeInstanceId = null;
let lastReviewTarget = null; // { instanceId, domainId }

// --- Live-session chat relay state -------------------------------------------
// The chat dock POSTs a prompt; we session.send and stream assistant tokens
// back to every panel in this (single) session over SSE.
function relayChat(event, payload) {
	for (const set of sseClients.values()) {
		for (const res of set) writeSse(res, event, payload);
	}
}

// --- Overview computation -----------------------------------------------------

// Roll a set of file paths up into a single review state. `skip` counts as
// complete. Priority: stale (a reviewed file changed) > needs-work > reviewed
// (all complete, none stale) > partial (some dispositioned) > null (none).
function rollUpReview(paths, byPath) {
	const files = (paths || []).map((p) => byPath.get(p)).filter(Boolean);
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
	let state;
	if (anyStale) state = "stale";
	else if (anyNeedsWork) state = "needs-work";
	else if (complete === total) state = "reviewed";
	else if (anyDisposition) state = "partial";
	else state = null;
	return { state, reviewed: complete, total };
}

async function computeOverview(cwd, baseOverride, pinnedDomain) {
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

	for (const f of diff.files) {
		f.risk = scoreFile(f, fanInMap.get(f.path) || 0);
		f.fanIn = fanInMap.get(f.path) || 0;

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
		f.reviewStale = !!entry && (entry.sha !== f.contentSha || entry.mergeBase !== diff.mergeBase);
	}

	const { groups, affinity } = decompose(diff.files, coChange);
	const byPath = new Map(diff.files.map((f) => [f.path, f]));
	for (const g of groups) {
		const scores = g.files.map((p) => byPath.get(p)?.risk?.score || 0);
		const max = scores.length ? Math.max(...scores) : 0;
		const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
		g.risk = { score: max * 0.7 + avg * 0.3 };
		const roll = rollUpReview(g.files, byPath);
		g.reviewState = roll.state;
		g.reviewedCount = roll.reviewed;
		g.fileCount = roll.total;
	}
	groups.sort((a, b) => b.risk.score - a.risk.score);

	// Derive per-tour-step review state from the same ledger roll-up so the tour
	// reflects file-level reviewed-ness rather than a stored step disposition.
	if (record.tour?.steps?.length) {
		const groupById = new Map(groups.map((g) => [g.id, g]));
		let anyPresent = false;
		for (const step of record.tour.steps) {
			let files = Array.isArray(step.files) ? step.files : [];
			if (!files.length && step.groupId && groupById.has(step.groupId)) {
				files = groupById.get(step.groupId).files;
			}
			const roll = rollUpReview(files, byPath);
			step.reviewState = roll.state;
			step.reviewedCount = roll.reviewed;
			step.fileCount = roll.total;
			// Files this step references that are no longer in the current diff —
			// the root cause of a step rendering a blank diff pane.
			step.missingFiles = files.filter((p) => !byPath.has(p));
			if (files.length && step.missingFiles.length < files.length) anyPresent = true;
		}
		// The whole tour is stale when the comparison window moved (merge-base
		// changed since the tour was stamped) or none of its files survive in the
		// current diff. The all-files-missing fallback also covers older tours
		// stamped before mergeBase/fingerprints were recorded.
		const baseMoved = !!record.tour.mergeBase && record.tour.mergeBase !== diff.mergeBase;
		record.tour.stale = baseMoved || !anyPresent;
	}

	if (ledgerDirty) await saveLedger(root, baseRef);

	const overview = {
		root,
		baseRef,
		baseOverride: record.base || null,
		mergeBase: diff.mergeBase,
		headSha: diff.headSha,
		headShort: diff.headShort,
		domain,
		totals: diff.totals,
		files: diff.files,
		groups,
		affinity,
		tour: record.tour || null,
		generatedTourAt: record.tour?.generatedAt || null,
	};
	overviewCache.set(domain, overview);
	return overview;
}

async function getOverview(instanceId, { force } = {}) {
	const meta = instances.get(instanceId);
	if (!meta) throw new CanvasError("no_instance", "Unknown canvas instance");
	activeInstanceId = instanceId;
	if (!force && meta.domainId && overviewCache.has(meta.domainId)) {
		return overviewCache.get(meta.domainId);
	}
	// Re-feed the previously resolved baseRef (not the raw override) so the git
	// layer resolves to the same ref every time, and pin the domain so the read
	// path matches whatever applyTour wrote.
	const overview = await computeOverview(meta.cwd, meta.baseRef ?? meta.baseOverride, meta.domainId);
	meta.domainId = overview.domain;
	if (!meta.baseRef) meta.baseRef = overview.baseRef;
	return overview;
}

function pushState(instanceId, overview) {
	const set = sseClients.get(instanceId);
	if (!set) return;
	for (const res of set) writeSse(res, "state", overview);
}

// --- Agent delegation ---------------------------------------------------------
//
// The extension process has no reliable handle to the git worktree, so it cannot
// compute the diff itself — only the agent (running inside the worktree) can. So
// instead of sendAndWait + parse, we fire a prompt into the live session and let
// the agent call the submit_review_tour tool when ready. The tool handler
// (applyTour) routes the result back to the right
// panel and push fresh state over SSE.

// Pick the panel a tool result should land on: the panel we last dispatched a
// request from, else the last-touched panel, else any instance with a domain.
function resolveReviewTarget() {
	if (lastReviewTarget && instances.has(lastReviewTarget.instanceId)) {
		return lastReviewTarget;
	}
	if (activeInstanceId && instances.has(activeInstanceId)) {
		const meta = instances.get(activeInstanceId);
		if (meta?.domainId) return { instanceId: activeInstanceId, domainId: meta.domainId };
	}
	for (const [instanceId, meta] of instances) {
		if (meta?.domainId) return { instanceId, domainId: meta.domainId };
	}
	return null;
}

async function requestTour(instanceId, { regenerate } = {}) {
	const overview = await getOverview(instanceId, { force: true });
	lastReviewTarget = { instanceId, domainId: overview.domain };
	const note = regenerate
		? "Regenerate the guided review tour from scratch."
		: "Start the guided review tour.";
	relayChat("chat-user", { text: note });
	session
		.send({ prompt: buildTourPrompt(overview) })
		.catch((e) => relayChat("chat-error", { message: String(e?.message || e) }));
	return overview;
}

// Called by the submit_review_tour tool when the agent returns the steps.
// The agent ran `git diff` inside the real worktree, so it also reports back the
// worktree path + base ref it used. The extension's own cwd is unreliable (a
// user-scope provider process is shared across sessions and does not chdir into
// the session's worktree), so we re-pin the target panel to the agent's worktree
// + base here — that is what makes the canvas's own diff line up with the tour's
// steps instead of computing an empty diff against the wrong directory.
async function applyTour(rawSteps, { repoPath, base } = {}) {
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
	const tour = {
		steps,
		current: 0,
		generatedAt: new Date().toISOString(),
		mergeBase: overviewBefore.mergeBase,
		files: overviewBefore.files.map((f) => ({ path: f.path, sha: f.contentSha })),
	};
	// Re-pinning can move the domain, so persist against the freshly resolved one.
	await patchRecord(overviewBefore.domain, { tour });
	const overview = await getOverview(target.instanceId, { force: true });
	pushState(target.instanceId, overview);
	return tour;
}

// --- HTTP server --------------------------------------------------------------

const STATIC = {
	"/": { file: "renderer/index.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "renderer/app.js", type: "text/javascript; charset=utf-8" },
	"/style.css": { file: "renderer/style.css", type: "text/css; charset=utf-8" },
};

function writeSse(res, event, data) {
	try {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	} catch {
		// client gone; cleanup happens on 'close'
	}
}

async function readBody(req) {
	const chunks = [];
	for await (const c of req) chunks.push(c);
	if (!chunks.length) return {};
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		return {};
	}
}

function sendJson(res, status, obj) {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(body);
}

// Resolve a review key into the concrete file paths it covers.
//   "group:<id>" -> that group's files
//   "step:<index>" -> that tour step's files (or its group's files)
//   anything else  -> a single file path
function resolveReviewPaths(overview, key) {
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
async function applyReview(overview, paths, state) {
	const byPath = new Map(overview.files.map((f) => [f.path, f]));
	for (const p of paths) {
		const f = byPath.get(p);
		const fingerprint = { sha: f?.contentSha ?? null, mergeBase: overview.mergeBase };
		await setFileReview(overview.root, overview.baseRef, p, state ?? null, fingerprint);
	}
}

async function handleRequest(req, res) {
	const url = new URL(req.url, "http://127.0.0.1");
	const path = url.pathname;
	const instanceId = url.searchParams.get("instanceId") || "";

	// Static assets.
	const stat = STATIC[path];
	if (stat && req.method === "GET") {
		try {
			const buf = await readFile(join(__dirname, stat.file));
			res.writeHead(200, { "Content-Type": stat.type, "Cache-Control": "no-store" });
			res.end(buf);
		} catch {
			res.writeHead(404).end("not found");
		}
		return;
	}

	// SSE stream for one panel.
	if (path === "/events" && req.method === "GET") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");
		let set = sseClients.get(instanceId);
		if (!set) sseClients.set(instanceId, (set = new Set()));
		set.add(res);
		req.on("close", () => set.delete(res));
		// Prime with current state (best-effort).
		getOverview(instanceId)
			.then((o) => writeSse(res, "state", o))
			.catch((e) => writeSse(res, "error", { message: String(e?.message || e) }));
		return;
	}

	try {
		if (path === "/api/overview" && req.method === "GET") {
			const force = url.searchParams.get("force") === "1";
			return sendJson(res, 200, await getOverview(instanceId, { force }));
		}

		if (path === "/api/file" && req.method === "GET") {
			const meta = instances.get(instanceId);
			const overview = await getOverview(instanceId);
			const filePath = url.searchParams.get("path") || "";
			const text = await fileDiff(meta.cwd, overview.mergeBase, filePath);
			const file = overview.files.find((f) => f.path === filePath) || null;
			let flags = [];
			if (file) flags = await suspicionFlags(meta.cwd, overview.mergeBase, file);
			return sendJson(res, 200, { path: filePath, diff: text, file, flags });
		}

		if (path === "/api/bases" && req.method === "GET") {
			const meta = instances.get(instanceId);
			return sendJson(res, 200, { bases: await listBaseCandidates(meta.cwd) });
		}

		if (path === "/api/set-base" && req.method === "POST") {
			const { base } = await readBody(req);
			const overview = await getOverview(instanceId);
			await patchRecord(overview.domain, { base: base || null, tour: null });
			const fresh = await getOverview(instanceId, { force: true });
			pushState(instanceId, fresh);
			return sendJson(res, 200, fresh);
		}

		if (path === "/api/disposition" && req.method === "POST") {
			const { key, state } = await readBody(req);
			// Force-recompute so we stamp each file with its current content sha.
			const overview = await getOverview(instanceId, { force: true });
			const paths = resolveReviewPaths(overview, key);
			await applyReview(overview, paths, state ?? null);
			const fresh = await getOverview(instanceId, { force: true });
			pushState(instanceId, fresh);
			return sendJson(res, 200, { ok: true });
		}

		if (path === "/api/tour/start" && req.method === "POST") {
			const { regenerate } = await readBody(req);
			await requestTour(instanceId, { regenerate });
			return sendJson(res, 200, { ok: true, pending: true });
		}

		if (path === "/api/tour" && req.method === "GET") {
			const overview = await getOverview(instanceId);
			return sendJson(res, 200, { tour: overview.tour || null });
		}

		if (path === "/api/tour/step" && req.method === "POST") {
			const { current, disposition } = await readBody(req);
			// Force-recompute so step disposition writes stamp current shas.
			const overview = await getOverview(instanceId, { force: true });
			const record = await loadRecord(overview.domain);
			if (!record.tour) throw new CanvasError("no_tour", "No tour started");
			if (Number.isInteger(current)) {
				record.tour.current = Math.max(
					0,
					Math.min(current, record.tour.steps.length - 1),
				);
				await saveRecord(overview.domain);
			}
			if (disposition && Number.isInteger(disposition.index)) {
				const paths = resolveReviewPaths(overview, `step:${disposition.index}`);
				await applyReview(overview, paths, disposition.state || null);
			}
			const fresh = await getOverview(instanceId, { force: true });
			pushState(instanceId, fresh);
			return sendJson(res, 200, { tour: fresh.tour });
		}

		if (path === "/api/chat" && req.method === "POST") {
			const { prompt } = await readBody(req);
			if (!prompt) throw new CanvasError("no_prompt", "Empty prompt");
			// Fire into the live session; tokens stream back over SSE via the
			// global handlers below. Do not await the full turn here.
			relayChat("chat-user", { text: prompt });
			session.send({ prompt }).catch((e) =>
				relayChat("chat-error", { message: String(e?.message || e) }),
			);
			return sendJson(res, 200, { ok: true });
		}

		res.writeHead(404).end("not found");
	} catch (err) {
		const code = err instanceof CanvasError ? err.code : "error";
		sendJson(res, 400, { error: code, message: String(err?.message || err) });
	}
}

async function ensureServer() {
	if (shared) return shared;
	const server = createServer((req, res) => {
		handleRequest(req, res).catch((err) => {
			try {
				res.writeHead(500).end(String(err?.message || err));
			} catch {
				/* noop */
			}
		});
	});
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	const port = server.address().port;
	shared = { server, url: `http://127.0.0.1:${port}/` };
	return shared;
}

// --- Canvas + session ---------------------------------------------------------

function instanceUrl(instanceId) {
	return `${shared.url}?instanceId=${encodeURIComponent(instanceId)}`;
}

// --- Agent tools --------------------------------------------------------------
//
// The agent computes the diff inside the real worktree and submits results here.
// Schema uses `parameters` (tool contract), not `inputSchema` (canvas actions).

const submitTourTool = {
	name: "submit_review_tour",
	description:
		"Submit the ordered guided-review-tour steps for the Review Lens canvas. Call this after analyzing the workspace diff instead of printing JSON.",
	parameters: {
		type: "object",
		properties: {
			repoPath: {
				type: "string",
				description:
					"Absolute path to the git worktree you ran `git diff` in (the output of `git rev-parse --show-toplevel`). REQUIRED — the canvas re-targets its own diff to this worktree so its view matches your tour. Without it the canvas may compute an empty diff against the wrong directory.",
			},
			base: {
				type: "string",
				description:
					"The base ref you diffed against (e.g. 'origin/main' or the PR base branch name), so the canvas computes the same merge-base. Pass the symbolic ref, not a commit sha.",
			},
			steps: {
				type: "array",
				items: {
					type: "object",
					properties: {
						title: { type: "string" },
						groupId: { type: ["string", "null"] },
						files: { type: "array", items: { type: "string" } },
						purpose: { type: "string" },
						whereItSits: { type: "string" },
						scrutinize: { type: "array", items: { type: "string" } },
					},
					required: ["title"],
				},
			},
		},
		required: ["steps", "repoPath"],
	},
	handler: async (args) => {
		const tour = await applyTour(args?.steps, {
			repoPath: args?.repoPath,
			base: args?.base,
		});
		return `Captured ${tour.steps.length} review steps in Review Lens.`;
	},
};

const canvas = createCanvas({
	id: "review-lens",
	displayName: "Review Lens",
	description:
		"Review large AI-generated change slices: decomposition, risk-routed map, and a guided review tour over the workspace diff.",
	inputSchema: {
		type: "object",
		properties: {
			base: {
				type: "string",
				description:
					"Base ref to review against (e.g. 'origin/main' or a base branch name). Pass the workspace's known base branch when opening; if omitted, the extension auto-detects via the PR base (gh), then origin/HEAD.",
			},
			repoPath: {
				type: "string",
				description:
					"Absolute path to the git worktree the review should target. Pass this when the session's cwd is not the worktree (e.g. a chat session). If omitted, the extension falls back to session.workspacePath then process.cwd().",
			},
		},
		additionalProperties: true,
	},
	actions: [
		{
			name: "refresh",
			description: "Recompute the diff, decomposition, and risk map.",
			handler: async (ctx) => {
				const o = await getOverview(ctx.instanceId, { force: true });
				pushState(ctx.instanceId, o);
				return { totals: o.totals, groups: o.groups.length };
			},
		},
		{
			name: "set_base",
			description: "Change the base ref the workspace is reviewed against.",
			inputSchema: {
				type: "object",
				properties: { base: { type: "string" } },
				required: ["base"],
			},
			handler: async (ctx) => {
				const o = await getOverview(ctx.instanceId);
				await patchRecord(o.domain, { base: ctx.input.base || null, tour: null });
				// Clear the pin so the new base re-resolves a fresh domain + ref.
				const meta = instances.get(ctx.instanceId);
				if (meta) {
					meta.baseOverride = ctx.input.base || null;
					meta.baseRef = null;
					meta.domainId = null;
				}
				const fresh = await getOverview(ctx.instanceId, { force: true });
				pushState(ctx.instanceId, fresh);
				return { baseRef: fresh.baseRef, totals: fresh.totals };
			},
		},
		{
			name: "summarize_risk",
			description:
				"Return the structured risk ranking and suspicion flags so the agent can ground its review in the same analysis the user sees.",
			handler: async (ctx) => {
				const o = await getOverview(ctx.instanceId);
				return {
					baseRef: o.baseRef,
					totals: o.totals,
					groups: o.groups.map((g) => ({
						id: g.id,
						label: g.label,
						files: g.files,
						risk: g.risk.score,
						disposition: g.disposition,
					})),
					topFiles: o.files
						.slice()
						.sort((a, b) => (b.risk?.score || 0) - (a.risk?.score || 0))
						.slice(0, 15)
						.map((f) => ({
							path: f.path,
							status: f.status,
							additions: f.additions,
							deletions: f.deletions,
							risk: f.risk?.score,
							reasons: f.risk?.reasons,
							fanIn: f.fanIn,
						})),
				};
			},
		},
		{
			name: "focus_group",
			description: "Focus the inspector on a concern group.",
			inputSchema: {
				type: "object",
				properties: { groupId: { type: "string" } },
				required: ["groupId"],
			},
			handler: async (ctx) => {
				relayChat("focus", { groupId: ctx.input.groupId });
				return { ok: true };
			},
		},
		{
			name: "start_tour",
			description: "Generate (or resume) the guided review tour.",
			inputSchema: {
				type: "object",
				properties: { regenerate: { type: "boolean" } },
			},
			handler: async (ctx) => {
				await requestTour(ctx.instanceId, { regenerate: ctx.input?.regenerate });
				return { requested: true, pending: true };
			},
		},
		{
			name: "goto_step",
			description: "Advance or jump the guided tour to a step (0-based).",
			inputSchema: {
				type: "object",
				properties: { index: { type: "number" } },
				required: ["index"],
			},
			handler: async (ctx) => {
				const o = await getOverview(ctx.instanceId);
				const record = await loadRecord(o.domain);
				if (!record.tour) throw new CanvasError("no_tour", "No tour started");
				record.tour.current = Math.max(
					0,
					Math.min(ctx.input.index, record.tour.steps.length - 1),
				);
				await saveRecord(o.domain);
				o.tour = record.tour;
				pushState(ctx.instanceId, o);
				return { current: record.tour.current };
			},
		},
	],
	open: async (ctx) => {
		await ensureServer();
		const inputRepoPath = ctx.input?.repoPath || null;
		const prevMeta = instances.get(ctx.instanceId);
		// An explicit repoPath in the open input re-pins which worktree we target.
		const repoPath = inputRepoPath ?? prevMeta?.repoPath ?? null;
		const cwd = await resolveRepoCwd([repoPath, session.workspacePath, process.cwd()]);
		const inputBase = ctx.input?.base || null;
		const meta = prevMeta || { cwd };
		meta.cwd = cwd;
		// If the worktree changed, the resolved domain is no longer valid.
		if (repoPath !== prevMeta?.repoPath) {
			meta.baseRef = null;
			meta.domainId = null;
		}
		meta.repoPath = repoPath;
		// An explicit base in the open input re-pins the review domain.
		if (inputBase && inputBase !== meta.baseOverride) {
			meta.baseOverride = inputBase;
			meta.baseRef = null;
			meta.domainId = null;
		}
		if (!meta.baseOverride) meta.baseOverride = inputBase;
		instances.set(ctx.instanceId, meta);
		activeInstanceId = ctx.instanceId;
		// Resolve the domain eagerly so the SSE prime + state are ready, and pin
		// the resolved baseRef so subsequent calls stay on the same domain.
		try {
			const o = await computeOverview(cwd, meta.baseRef ?? meta.baseOverride, meta.domainId);
			meta.domainId = o.domain;
			meta.baseRef = o.baseRef;
		} catch (e) {
			session.log(`review-lens: overview failed: ${e?.message || e}`, {
				level: "warn",
			});
		}
		return { title: "Review Lens", url: instanceUrl(ctx.instanceId) };
	},
	onClose: async (ctx) => {
		instances.delete(ctx.instanceId);
		sseClients.delete(ctx.instanceId);
	},
});

session = await joinSession({
	canvases: [canvas],
	tools: [submitTourTool],
});

// Global chat relay: mirror live assistant tokens into every open panel.
session.on("assistant.message_delta", (event) => {
	const delta = event?.data?.deltaContent ?? "";
	if (delta) relayChat("chat-delta", { text: delta, messageId: event?.data?.messageId });
});
session.on("assistant.message", (event) => {
	relayChat("chat-final", {
		text: event?.data?.content ?? "",
		messageId: event?.data?.messageId,
	});
});
session.on("session.idle", () => relayChat("chat-idle", {}));
