// Review Lens — a canvas for understanding large, AI-generated change slices.
//
// Thin wiring only: deterministic git facts (git.ts), heuristics (analysis.ts),
// durable state (storage.ts), prompts (prompts.ts), server-authoritative state +
// snapshot push (state.ts), and the loopback HTTP/SSE server (http.ts) live in
// sibling modules. This file declares the canvas + agent tool and joins the
// session.
//
// Dev mode: scripts/dev.mjs installs this extension user-scoped along with a
// `.dev.json` marker ({ apiPort, rendererUrl }). When the marker is present we
// listen on the fixed apiPort (so the Vite proxy can find us) and `open()`
// returns the Vite dev-server URL for HMR. Without the marker (production) we
// serve the built single-file renderer from our own random port.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError, createCanvas, joinSession } from "@github/copilot-sdk/extension";

import { resolveRepoCwd } from "./git.js";
import { broadcast } from "./hub.js";
import { ensureServer } from "./http.js";
import { buildTourPrompt } from "./prompts.js";
import {
	applyTour,
	bindSession,
	chatDelta,
	chatFinal,
	chatIdle,
	dropInstanceState,
	getOverview,
	instances,
	loadRecord,
	patchRecord,
	pushSnapshot,
	refreshAndPush,
	requestTour,
	saveRecord,
	setActiveInstance,
} from "./state.js";
import { dropInstance } from "./hub.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface DevMarker {
	apiPort: number;
	rendererUrl: string;
}

async function readDevMarker(): Promise<DevMarker | null> {
	try {
		const raw = JSON.parse(await readFile(join(__dirname, ".dev.json"), "utf8"));
		if (raw?.apiPort && raw?.rendererUrl) return raw as DevMarker;
	} catch {
		// no marker — production mode
	}
	return null;
}

const devMarker = await readDevMarker();

function instanceUrl(serverUrl: string, instanceId: string): string {
	const base = devMarker ? devMarker.rendererUrl : serverUrl;
	const sep = base.includes("?") ? "&" : "?";
	return `${base}${sep}instanceId=${encodeURIComponent(instanceId)}`;
}

// --- Agent tool -----------------------------------------------------------------
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
	handler: async (args: { steps?: unknown; repoPath?: string; base?: string }) => {
		const tour = await applyTour(args?.steps, {
			repoPath: args?.repoPath,
			base: args?.base,
		});
		return `Captured ${tour.steps.length} review steps in Review Lens.`;
	},
};

// --- Canvas -----------------------------------------------------------------------

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
				const o = await refreshAndPush(ctx.instanceId);
				return o ? { totals: o.totals, groups: o.groups.length } : { error: "refresh failed" };
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
				const input = ctx.input as { base?: string };
				const o = await getOverview(ctx.instanceId);
				await patchRecord(o.domain, { base: input.base || null, tour: null });
				// Clear the pin so the new base re-resolves a fresh domain + ref.
				const meta = instances.get(ctx.instanceId);
				if (meta) {
					meta.baseOverride = input.base || null;
					meta.baseRef = null;
					meta.domainId = null;
				}
				const fresh = await refreshAndPush(ctx.instanceId);
				return fresh
					? { baseRef: fresh.baseRef, totals: fresh.totals }
					: { error: "refresh failed" };
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
						reviewState: g.reviewState,
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
				const input = ctx.input as { groupId: string };
				broadcast("focus", { groupId: input.groupId });
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
				const input = (ctx.input ?? {}) as { regenerate?: boolean };
				await requestTour(ctx.instanceId, {
					regenerate: input.regenerate,
					buildPrompt: buildTourPrompt,
				});
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
				const input = ctx.input as { index: number };
				const o = await getOverview(ctx.instanceId);
				const record = await loadRecord(o.domain);
				if (!record.tour) throw new CanvasError("no_tour", "No tour started");
				record.tour.current = Math.max(
					0,
					Math.min(input.index, record.tour.steps.length - 1),
				);
				await saveRecord(o.domain);
				await refreshAndPush(ctx.instanceId);
				return { current: record.tour.current };
			},
		},
	],
	open: async (ctx) => {
		const { url } = await ensureServer(devMarker?.apiPort ?? null);
		const input = (ctx.input ?? {}) as { repoPath?: string; base?: string };
		const inputRepoPath = input.repoPath || null;
		const prevMeta = instances.get(ctx.instanceId);
		// An explicit repoPath in the open input re-pins which worktree we target.
		const repoPath = inputRepoPath ?? prevMeta?.repoPath ?? null;
		const cwd = await resolveRepoCwd([repoPath, session.workspacePath, process.cwd()]);
		const inputBase = input.base || null;
		const meta = prevMeta || {
			cwd,
			repoPath: null,
			baseOverride: null,
			baseRef: null,
			domainId: null,
			error: null,
		};
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
		setActiveInstance(ctx.instanceId);
		// Resolve the domain eagerly so the SSE prime + snapshot are ready, and
		// pin the resolved baseRef so subsequent calls stay on the same domain.
		try {
			await getOverview(ctx.instanceId, { force: true });
			pushSnapshot(ctx.instanceId);
		} catch (e) {
			meta.error = String((e as Error)?.message || e);
			session.log(`review-lens: overview failed: ${meta.error}`, { level: "warning" });
		}
		return { title: "Review Lens", url: instanceUrl(url, ctx.instanceId) };
	},
	onClose: async (ctx) => {
		dropInstanceState(ctx.instanceId);
		dropInstance(ctx.instanceId);
	},
});

const session = await joinSession({
	canvases: [canvas],
	tools: [submitTourTool],
});

bindSession((prompt) => session.send({ prompt }));

// Global chat relay: mirror live assistant tokens into every open panel.
session.on("assistant.message_delta", (event) => {
	const delta = event?.data?.deltaContent ?? "";
	if (delta) chatDelta(delta);
});
session.on("assistant.message", (event) => {
	chatFinal(event?.data?.content ?? "");
});
session.on("session.idle", () => chatIdle());
