// Guided tour: docked step panel above the diff. Navigation, per-step
// dispositions, stale-tour banner, and regenerate (with inline confirm —
// window.confirm is unreliable in the canvas webview).

import { useState } from "react";
import type { Disposition, Overview, TourStep } from "../../shared/types.js";
import { api } from "../api.js";
import { ReviewMark, RollupBadge } from "./ui.js";

const STEP_DISPOSITIONS: [Disposition, string][] = [
	["reviewed", "✓ Reviewed"],
	["needs-work", "⚠ Needs work"],
	["skip", "» Skip"],
];

export function TourPanel({
	overview,
	onOpenFile,
	onClose,
}: {
	overview: Overview;
	onOpenFile: (path: string) => void;
	onClose: () => void;
}) {
	const tour = overview.tour;
	const [confirmRegen, setConfirmRegen] = useState(false);
	if (!tour?.steps?.length) return null;

	const i = tour.current || 0;
	const step: TourStep = tour.steps[i];
	const byPath = new Map(overview.files.map((f) => [f.path, f]));

	const regenerate = () => {
		setConfirmRegen(false);
		api.tourStart({ regenerate: true }).catch(() => {});
	};

	return (
		<div className="tour">
			<div className="tour-head">
				<span className="tour-progress">
					Step {i + 1} of {tour.steps.length}
				</span>
				<div className="tour-nav">
					<button
						className="btn ghost"
						disabled={i === 0}
						onClick={() => api.tourStep({ current: i - 1 }).catch(() => {})}
					>
						‹ Prev
					</button>
					<button
						className="btn"
						disabled={i >= tour.steps.length - 1}
						onClick={() => api.tourStep({ current: i + 1 }).catch(() => {})}
					>
						Next ›
					</button>
					{confirmRegen ? (
						<span className="confirm-inline">
							<button className="btn small primary" onClick={regenerate}>
								Regenerate?
							</button>
							<button className="btn small ghost" onClick={() => setConfirmRegen(false)}>
								Cancel
							</button>
						</span>
					) : (
						<button
							className="btn ghost"
							title="Rebuild the tour from the current diff"
							onClick={() => setConfirmRegen(true)}
						>
							⟳ Regenerate
						</button>
					)}
					<button className="btn ghost" onClick={onClose}>
						Exit tour
					</button>
				</div>
			</div>
			<div className="tour-body">
				{tour.stale && (
					<div className="tour-stale">
						⟳ This tour was built against an earlier diff — some steps may point at
						files that have changed or are no longer in the changeset.{" "}
						<button className="btn small primary" onClick={regenerate}>
							Regenerate tour
						</button>
					</div>
				)}
				<div className="tour-title">{step.title}</div>
				<div className="tour-section">
					<h4>What this chunk is</h4>
					<div>{step.purpose}</div>
				</div>
				<div className="tour-section">
					<h4>Where it sits in the whole app</h4>
					<div>{step.whereItSits}</div>
				</div>
				{step.scrutinize.length > 0 && (
					<div className="tour-section scrutinize">
						<h4>Scrutinize</h4>
						<ul>
							{step.scrutinize.map((s, idx) => (
								<li key={idx}>{s}</li>
							))}
						</ul>
					</div>
				)}
				{step.files.length > 0 && (
					<div className="tour-section">
						<h4>
							Files{" "}
							<RollupBadge
								state={step.reviewState}
								reviewed={step.reviewedCount}
								total={step.fileCount}
							/>
						</h4>
						{step.files.map((f) => {
							const ff = byPath.get(f);
							return (
								<a
									href="#"
									key={f}
									className={`file-chip${ff ? "" : " missing"}`}
									onClick={(e) => {
										e.preventDefault();
										onOpenFile(f);
									}}
								>
									{f}
									{ff ? (
										<ReviewMark file={ff} />
									) : (
										<span className="file-gone"> · not in diff</span>
									)}
								</a>
							);
						})}
					</div>
				)}
			</div>
			<div className="tour-disposition">
				<span className="group-meta">Disposition this step:</span>{" "}
				{STEP_DISPOSITIONS.map(([s, label]) => (
					<button
						key={s}
						className={`btn small ${step.reviewState === s ? "primary" : "ghost"}`}
						onClick={() =>
							api
								.tourStep({
									disposition: { index: i, state: step.reviewState === s ? null : s },
								})
								.catch(() => {})
						}
					>
						{label}
					</button>
				))}
			</div>
		</div>
	);
}
