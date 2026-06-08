// Inspector diff pane: unified diff for the selected file, with risk evidence,
// suspicion flags, stale-review note, and disposition controls.

import { useEffect, useState } from "react";
import type { FileDetail, Overview } from "../../shared/types.js";
import { api } from "../api.js";
import { DISP_MARK, DISP_STATES, riskClass } from "./ui.js";

export type InspectorContent =
	| { kind: "empty"; message?: string }
	| { kind: "file"; path: string }
	| { kind: "step-no-diff"; title: string };

function DiffText({ text }: { text: string }) {
	return (
		<div className="hunk">
			{text.split("\n").map((line, i) => {
				let cls = "";
				if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
				else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
				else if (line.startsWith("@@")) cls = "hdr";
				else if (/^(diff |index |--- |\+\+\+ |new file|deleted|rename|similarity)/.test(line))
					cls = "meta";
				return (
					<span className={`ln ${cls}`} key={i}>
						{line || " "}
					</span>
				);
			})}
		</div>
	);
}

function FileDiff({ path, overview }: { path: string; overview: Overview | null }) {
	const [detail, setDetail] = useState<FileDetail | null>(null);
	const [error, setError] = useState<string | null>(null);

	// Refetch when the path changes or fresh state arrives (dispositions and
	// shas in the snapshot move under us).
	const overviewStamp = overview
		? `${overview.mergeBase}:${overview.files.find((f) => f.path === path)?.disposition ?? ""}`
		: "";
	useEffect(() => {
		let alive = true;
		setError(null);
		api
			.file(path)
			.then((d) => {
				if (alive) setDetail(d);
			})
			.catch((e) => {
				if (alive) setError(e.message);
			});
		return () => {
			alive = false;
		};
	}, [path, overviewStamp]);

	if (error) return <div className="reasons">Error: {error}</div>;
	if (!detail || detail.path !== path) {
		return (
			<>
				<div className="diff-file-head">
					<span className="path">{path}</span> loading…
				</div>
			</>
		);
	}

	const { file, flags, diff } = detail;
	if (!file) {
		// Path isn't in the current diff (base → working tree). This is what a
		// stale tour step points at; say so plainly instead of "(no diff)".
		return (
			<>
				<div className="diff-file-head">
					<span className="path">{path}</span>
				</div>
				<div className="reasons">
					This file isn’t part of the current diff (base → working tree). The tour
					may have been built against an earlier diff — regenerate it.
				</div>
			</>
		);
	}

	const reasons = (file.risk?.reasons || []).join(" · ");
	return (
		<>
			<div className="diff-file-head">
				<span className={`risk-dot ${riskClass(file.risk?.score || 0)}`} />
				<span className="path">{path}</span>
				<span className="group-meta">
					+{file.additions}/-{file.deletions} · fan-in {file.fanIn}
				</span>
			</div>
			{flags.length > 0 && (
				<div className="flags">
					{flags.map((f, i) => (
						<span className={`flag flag-${f.severity || "low"}`} title={f.kind} key={i}>
							⚑ {f.message}
						</span>
					))}
				</div>
			)}
			{reasons && <div className="reasons">▸ {reasons}</div>}
			{file.reviewStale && file.disposition && (
				<div className="stale-note">
					● This file changed since you marked it{" "}
					{DISP_MARK[file.disposition]?.[1] || "reviewed"} — re-review.
				</div>
			)}
			<div className="disp-bar">
				<span className="group-meta">Disposition:</span>{" "}
				{DISP_STATES.map(([s, label]) => (
					<button
						key={s}
						className={`btn small disp ${file.disposition === s ? "primary" : "ghost"}`}
						onClick={() =>
							api
								.disposition({ key: path, state: file.disposition === s ? null : s })
								.catch(() => {})
						}
					>
						{label}
					</button>
				))}
			</div>
			<DiffText text={diff || "(no diff)"} />
		</>
	);
}

export function Inspector({
	content,
	overview,
}: {
	content: InspectorContent;
	overview: Overview | null;
}) {
	if (content.kind === "empty") {
		return (
			<div className="diff-pane">
				<div className="inspector-empty">
					{content.message || "Select a file or group, or start the guided tour."}
				</div>
			</div>
		);
	}
	if (content.kind === "step-no-diff") {
		// Explicit message when a tour step's files are all absent from the
		// current diff (the stale-tour blank-pane case).
		return (
			<div className="diff-pane">
				<div className="diff">
					<div className="diff-file-head">
						<span className="path">{content.title}</span>
					</div>
					<div className="reasons">
						None of this step’s files are part of the current diff (base → working
						tree). This tour was likely built against an earlier diff — regenerate it
						to re-walk the current changes.
					</div>
				</div>
			</div>
		);
	}
	return (
		<div className="diff-pane">
			<div className="diff">
				<FileDiff path={content.path} overview={overview} />
			</div>
		</div>
	);
}
