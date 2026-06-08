// SSE-fed store. The server pushes a canonical Snapshot after every mutation;
// this hook holds the last snapshot plus the in-flight chat-delta stream and a
// one-shot "focus" command. The whole UI is a pure render of this state.

import { useEffect, useRef, useState } from "react";
import type { Snapshot } from "../shared/types.js";
import { api, withInstance } from "./api.js";

export interface ReviewState {
	snapshot: Snapshot | null;
	/** Accumulated assistant tokens for the in-flight turn (null = no stream). */
	streamText: string | null;
	/** Connection / server error surfaced to the UI. */
	error: string | null;
}

export function useReviewState(onFocusGroup: (groupId: string) => void): ReviewState {
	const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
	const [streamText, setStreamText] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const focusRef = useRef(onFocusGroup);
	focusRef.current = onFocusGroup;

	useEffect(() => {
		const es = new EventSource(withInstance("/events"));
		es.addEventListener("state", (e) => {
			setSnapshot(JSON.parse((e as MessageEvent).data) as Snapshot);
			// A new snapshot closes out any in-flight delta stream (the final
			// transcript turn is in the snapshot itself).
			setStreamText(null);
			setError(null);
		});
		es.addEventListener("chat-delta", (e) => {
			const { text } = JSON.parse((e as MessageEvent).data) as { text: string };
			setStreamText((prev) => (prev ?? "") + text);
		});
		es.addEventListener("focus", (e) => {
			const { groupId } = JSON.parse((e as MessageEvent).data) as {
				groupId: string;
			};
			focusRef.current(groupId);
		});
		es.addEventListener("error", (e) => {
			const data = (e as MessageEvent).data;
			if (!data) return; // transport-level error event has no payload
			try {
				const d = JSON.parse(data) as { message?: string };
				if (d.message) setError(d.message);
			} catch {
				// ignore malformed payloads
			}
		});

		// Initial load fallback in case the SSE prime races the first paint.
		api.snapshot().then(setSnapshot).catch((e) => setError(e.message));

		return () => es.close();
	}, []);

	return { snapshot, streamText, error };
}
