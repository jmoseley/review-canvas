// SSE hub: per-instance client registries and typed event writes. The single
// place that knows how to push an event to one panel or every panel.

import type { ServerResponse } from "node:http";
import type { SseEventMap, SseEventName } from "../shared/types.js";

const clients = new Map<string, Set<ServerResponse>>();

export function addClient(instanceId: string, res: ServerResponse): void {
	let set = clients.get(instanceId);
	if (!set) clients.set(instanceId, (set = new Set()));
	set.add(res);
	res.on("close", () => set?.delete(res));
}

export function dropInstance(instanceId: string): void {
	clients.delete(instanceId);
}

export function instanceIds(): string[] {
	return Array.from(clients.keys());
}

export function writeSse<E extends SseEventName>(
	res: ServerResponse,
	event: E,
	data: SseEventMap[E],
): void {
	try {
		res.write(`event: ${event}\n`);
		res.write(`data: ${JSON.stringify(data)}\n\n`);
	} catch {
		// client gone; cleanup happens on 'close'
	}
}

export function sendTo<E extends SseEventName>(
	instanceId: string,
	event: E,
	data: SseEventMap[E],
): void {
	const set = clients.get(instanceId);
	if (!set) return;
	for (const res of set) writeSse(res, event, data);
}

export function broadcast<E extends SseEventName>(
	event: E,
	data: SseEventMap[E],
): void {
	for (const set of clients.values()) {
		for (const res of set) writeSse(res, event, data);
	}
}
