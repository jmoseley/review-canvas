// Loopback HTTP server: static renderer, JSON API, and the SSE endpoint.
// Mutating routes return 204 — the server answers by pushing a fresh snapshot
// over SSE (see state.ts), so the renderer has exactly one update path.

import { readFile } from "node:fs/promises";
import {
	createServer,
	type IncomingMessage,
	type Server,
	type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CanvasError } from "@github/copilot-sdk/extension";

import type {
	ChatRequest,
	DispositionRequest,
	SetBaseRequest,
	TourStartRequest,
	TourStepRequest,
} from "../shared/types.js";
import { suspicionFlags } from "./analysis.js";
import { fileDiff, listBaseCandidates } from "./git.js";
import { addClient, writeSse } from "./hub.js";
import { buildTourPrompt } from "./prompts.js";
import {
	applyReview,
	assembleSnapshot,
	chatUser,
	dispatchPrompt,
	getOverview,
	instances,
	loadRecord,
	patchRecord,
	pushSnapshot,
	refreshAndPush,
	requestTour,
	resolveReviewPaths,
	saveRecord,
} from "./state.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function readBody<T>(req: IncomingMessage): Promise<T> {
	const chunks: Buffer[] = [];
	for await (const c of req) chunks.push(c as Buffer);
	if (!chunks.length) return {} as T;
	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
	} catch {
		return {} as T;
	}
}

function sendJson(res: ServerResponse, status: number, obj: unknown): void {
	const body = JSON.stringify(obj);
	res.writeHead(status, {
		"Content-Type": "application/json; charset=utf-8",
		"Cache-Control": "no-store",
	});
	res.end(body);
}

function sendNoContent(res: ServerResponse): void {
	res.writeHead(204, { "Cache-Control": "no-store" }).end();
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const path = url.pathname;
	const instanceId = url.searchParams.get("instanceId") || "";

	// Static: the production renderer is one self-contained index.html built by
	// Vite (singlefile), sitting next to the bundled server in the installed dir.
	if (path === "/" && req.method === "GET") {
		try {
			const buf = await readFile(join(__dirname, "index.html"));
			res.writeHead(200, {
				"Content-Type": "text/html; charset=utf-8",
				"Cache-Control": "no-store",
			});
			res.end(buf);
		} catch {
			res.writeHead(404).end("renderer not built — run `npm run build`");
		}
		return;
	}

	// SSE stream for one panel. Primes with the current snapshot.
	if (path === "/events" && req.method === "GET") {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});
		res.write(": connected\n\n");
		addClient(instanceId, res);
		getOverview(instanceId)
			.then(() => writeSse(res, "state", assembleSnapshot(instanceId)))
			.catch((e) =>
				writeSse(res, "error", { message: String((e as Error)?.message || e) }),
			);
		return;
	}

	try {
		if (path === "/api/snapshot" && req.method === "GET") {
			const force = url.searchParams.get("force") === "1";
			await getOverview(instanceId, { force });
			return sendJson(res, 200, assembleSnapshot(instanceId));
		}

		if (path === "/api/refresh" && req.method === "POST") {
			await refreshAndPush(instanceId);
			return sendNoContent(res);
		}

		if (path === "/api/file" && req.method === "GET") {
			const meta = instances.get(instanceId);
			if (!meta) throw new CanvasError("no_instance", "Unknown canvas instance");
			const overview = await getOverview(instanceId);
			const filePath = url.searchParams.get("path") || "";
			const text = await fileDiff(meta.cwd, overview.mergeBase, filePath);
			const file = overview.files.find((f) => f.path === filePath) || null;
			const flags = file ? await suspicionFlags(meta.cwd, overview.mergeBase, file) : [];
			return sendJson(res, 200, { path: filePath, diff: text, file, flags });
		}

		if (path === "/api/bases" && req.method === "GET") {
			const meta = instances.get(instanceId);
			if (!meta) throw new CanvasError("no_instance", "Unknown canvas instance");
			return sendJson(res, 200, { bases: await listBaseCandidates(meta.cwd) });
		}

		if (path === "/api/set-base" && req.method === "POST") {
			const { base } = await readBody<SetBaseRequest>(req);
			const overview = await getOverview(instanceId);
			await patchRecord(overview.domain, { base: base || null, tour: null });
			// Clear the pin so the new base re-resolves a fresh domain + ref.
			const meta = instances.get(instanceId);
			if (meta) {
				meta.baseOverride = base || null;
				meta.baseRef = null;
				meta.domainId = null;
			}
			await refreshAndPush(instanceId);
			return sendNoContent(res);
		}

		if (path === "/api/disposition" && req.method === "POST") {
			const { key, state } = await readBody<DispositionRequest>(req);
			// Force-recompute so we stamp each file with its current content sha.
			const overview = await getOverview(instanceId, { force: true });
			const paths = resolveReviewPaths(overview, key);
			await applyReview(overview, paths, state ?? null);
			await refreshAndPush(instanceId);
			return sendNoContent(res);
		}

		if (path === "/api/tour/start" && req.method === "POST") {
			const { regenerate } = await readBody<TourStartRequest>(req);
			await requestTour(instanceId, { regenerate, buildPrompt: buildTourPrompt });
			return sendNoContent(res);
		}

		if (path === "/api/tour/step" && req.method === "POST") {
			const { current, disposition } = await readBody<TourStepRequest>(req);
			// Force-recompute so step disposition writes stamp current shas.
			const overview = await getOverview(instanceId, { force: true });
			const record = await loadRecord(overview.domain);
			if (!record.tour) throw new CanvasError("no_tour", "No tour started");
			if (Number.isInteger(current)) {
				record.tour.current = Math.max(
					0,
					Math.min(current as number, record.tour.steps.length - 1),
				);
				await saveRecord(overview.domain);
			}
			if (disposition && Number.isInteger(disposition.index)) {
				const paths = resolveReviewPaths(overview, `step:${disposition.index}`);
				await applyReview(overview, paths, disposition.state || null);
			}
			await refreshAndPush(instanceId);
			return sendNoContent(res);
		}

		if (path === "/api/chat" && req.method === "POST") {
			const { prompt } = await readBody<ChatRequest>(req);
			if (!prompt) throw new CanvasError("no_prompt", "Empty prompt");
			// Fire into the live session; tokens stream back over SSE via the
			// session handlers in extension.ts. Do not await the full turn here.
			chatUser(prompt);
			dispatchPrompt(prompt);
			return sendNoContent(res);
		}

		res.writeHead(404).end("not found");
	} catch (err) {
		const code = err instanceof CanvasError ? err.code : "error";
		sendJson(res, 400, { error: code, message: String((err as Error)?.message || err) });
	}
}

let shared: { server: Server; url: string } | null = null;

/**
 * Start (or return) the shared loopback server. `fixedPort` comes from the
 * dev marker so the Vite proxy knows where to find us; in prod we take any
 * free port.
 */
export async function ensureServer(fixedPort?: number | null): Promise<{ url: string }> {
	if (shared) return shared;
	const server = createServer((req, res) => {
		handleRequest(req, res).catch((err) => {
			try {
				res.writeHead(500).end(String((err as Error)?.message || err));
			} catch {
				/* noop */
			}
		});
	});
	await new Promise<void>((r) => server.listen(fixedPort || 0, "127.0.0.1", r));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : fixedPort;
	shared = { server, url: `http://127.0.0.1:${port}/` };
	return shared;
}

export { pushSnapshot };
