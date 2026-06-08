// Typed fetch wrapper for the extension's loopback API. Appends the panel's
// instanceId to every request. Mutations return 204 — fresh state arrives via
// the SSE snapshot, never the POST response.

import type {
	ApiError,
	BasesResponse,
	ChatRequest,
	DispositionRequest,
	FileDetail,
	SetBaseRequest,
	Snapshot,
	TourStartRequest,
	TourStepRequest,
} from "../shared/types.js";

export const instanceId =
	new URLSearchParams(location.search).get("instanceId") || "";

export function withInstance(path: string): string {
	return `${path}${path.includes("?") ? "&" : "?"}instanceId=${encodeURIComponent(instanceId)}`;
}

async function request<T>(path: string, opts?: RequestInit): Promise<T> {
	const res = await fetch(withInstance(path), opts);
	if (res.status === 204) return undefined as T;
	const json = await res.json().catch(() => ({}));
	if (!res.ok) {
		const err = json as Partial<ApiError>;
		throw new Error(err.message || err.error || res.statusText);
	}
	return json as T;
}

function post(path: string, body: unknown): Promise<void> {
	return request<void>(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
}

export const api = {
	snapshot: (force = false): Promise<Snapshot> =>
		request<Snapshot>(`/api/snapshot${force ? "?force=1" : ""}`),
	refresh: (): Promise<void> => post("/api/refresh", {}),
	file: (path: string): Promise<FileDetail> =>
		request<FileDetail>(`/api/file?path=${encodeURIComponent(path)}`),
	bases: (): Promise<BasesResponse> => request<BasesResponse>("/api/bases"),
	setBase: (body: SetBaseRequest): Promise<void> => post("/api/set-base", body),
	disposition: (body: DispositionRequest): Promise<void> =>
		post("/api/disposition", body),
	tourStart: (body: TourStartRequest): Promise<void> =>
		post("/api/tour/start", body),
	tourStep: (body: TourStepRequest): Promise<void> => post("/api/tour/step", body),
	chat: (body: ChatRequest): Promise<void> => post("/api/chat", body),
};
