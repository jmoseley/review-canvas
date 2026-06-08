// Risk-routed rail: concern groups with their files, dispositions, and
// review roll-ups.

import type { Overview } from "../../shared/types.js";
import { api } from "../api.js";
import { ReviewMark, riskClass, RollupBadge } from "./ui.js";

export function Rail({
	overview,
	activePath,
	onOpenFile,
}: {
	overview: Overview | null;
	activePath: string | null;
	onOpenFile: (path: string) => void;
}) {
	if (!overview) return <aside className="rail" />;
	const byPath = new Map(overview.files.map((f) => [f.path, f]));

	if (!overview.groups.length) {
		return (
			<aside className="rail">
				<div className="rail-scroll">
					<div className="rail-empty">
						No changes between <strong>{overview.baseRef || "base"}</strong> and the
						working tree. Use <strong>Base…</strong> to pick a different comparison
						point.
					</div>
				</div>
			</aside>
		);
	}

	return (
		<aside className="rail">
			<div className="rail-scroll">
				{overview.groups.map((g) => {
					const allReviewed = g.reviewState === "reviewed";
					return (
						<div className="group" key={g.id}>
							<div
								className="group-head"
								onClick={() => {
									if (g.files.length) onOpenFile(g.files[0]);
								}}
							>
								<span className={`risk-dot ${riskClass(g.risk?.score || 0)}`} />
								<span className="group-label">{g.label}</span>
								<RollupBadge
									state={g.reviewState}
									reviewed={g.reviewedCount}
									total={g.fileCount}
								/>
								<button
									className={`btn small group-review ${allReviewed ? "primary" : "ghost"}`}
									title="Mark every file in this group reviewed"
									onClick={(e) => {
										e.stopPropagation();
										api
											.disposition({
												key: `group:${g.id}`,
												state: allReviewed ? null : "reviewed",
											})
											.catch(() => {});
									}}
								>
									✓
								</button>
							</div>
							<div className="group-files">
								{g.files.map((p) => {
									const f = byPath.get(p);
									if (!f) return null;
									return (
										<div
											key={p}
											className={`file-row${activePath === p ? " active" : ""}`}
											onClick={() => onOpenFile(p)}
										>
											<span className={`risk-dot ${riskClass(f.risk?.score || 0)}`} />
											<span className="file-path">{p}</span>
											<ReviewMark file={f} />
											<span className="file-churn">
												+{f.additions}/-{f.deletions}
											</span>
										</div>
									);
								})}
							</div>
						</div>
					);
				})}
			</div>
		</aside>
	);
}
