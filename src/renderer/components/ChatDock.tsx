// Chat dock: collapsible bottom-corner panel that fires prompts into the live
// session. The transcript comes from the snapshot; the in-flight assistant
// turn streams in via chat-delta.

import { useEffect, useRef, useState } from "react";
import type { ChatTurn } from "../../shared/types.js";
import { api } from "../api.js";

export function ChatDock({
	chat,
	streamText,
	placeholder,
	contextPrefix,
}: {
	chat: ChatTurn[];
	streamText: string | null;
	placeholder: string;
	/** Prepended to outgoing prompts to anchor them to the focused step/file. */
	contextPrefix: string | null;
}) {
	const [open, setOpen] = useState(false);
	const [input, setInput] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const logRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		const log = logRef.current;
		if (log) log.scrollTop = log.scrollHeight;
	}, [chat, streamText, open]);

	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	const send = (e: React.FormEvent) => {
		e.preventDefault();
		const text = input.trim();
		if (!text) return;
		setInput("");
		setLocalError(null);
		const prompt = contextPrefix ? `${contextPrefix}\n${text}` : text;
		api.chat({ prompt }).catch((err) => setLocalError(err.message));
	};

	if (!open) {
		return (
			<button className="chat-toggle" aria-label="Open chat" onClick={() => setOpen(true)}>
				💬
			</button>
		);
	}

	return (
		<div className="chat">
			<button
				type="button"
				className="chat-head"
				aria-label="Hide chat"
				aria-expanded="true"
				title="Click to hide"
				onClick={() => setOpen(false)}
			>
				<span>Ask the agent</span>
				<span className="chat-min" aria-hidden="true">
					▾
				</span>
			</button>
			<div className="chat-log" ref={logRef}>
				{chat.map((turn, i) => (
					<div className={`msg ${turn.role}`} key={i}>
						{turn.text}
					</div>
				))}
				{streamText !== null && <div className="msg assistant">{streamText}</div>}
				{localError && <div className="msg assistant">⚠ {localError}</div>}
			</div>
			<form className="chat-form" onSubmit={send}>
				<input
					ref={inputRef}
					placeholder={placeholder}
					autoComplete="off"
					value={input}
					onChange={(e) => setInput(e.target.value)}
				/>
				<button className="btn" type="submit">
					Send
				</button>
			</form>
		</div>
	);
}
