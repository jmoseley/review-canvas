// Small shared presentational helpers used across the rail, inspector and tour.

import type { Disposition, FileEntry, ReviewRollupState } from "../../shared/types.js";

export function riskClass(score: number): string {
	if (score >= 6) return "risk-hi";
	if (score >= 3) return "risk-mid";
	return "risk-lo";
}

export const DISP_MARK: Record<Disposition, [string, string]> = {
	reviewed: ["✓", "reviewed"],
	"needs-work": ["⚠", "needs work"],
	skip: ["»", "skipped"],
};

export const DISP_STATES: [Disposition, string][] = [
	["reviewed", "✓"],
	["needs-work", "⚠"],
	["skip", "»"],
];

/** Small inline marker for a file's review disposition, shown in the rail. */
export function ReviewMark({ file }: { file: FileEntry }) {
	if (!file.disposition) return null;
	const m = DISP_MARK[file.disposition];
	return (
		<>
			<span className={`file-disp disp-${file.disposition}`} title={m[1]}>
				{m[0]}
			</span>
			{file.reviewStale && (
				<span className="stale-dot" title={`changed since you marked it ${m[1]}`}>
					●
				</span>
			)}
		</>
	);
}

/** Roll-up badge for a group / tour step: "n/m" reviewed, tinted by state. */
export function RollupBadge({
	state,
	reviewed,
	total,
}: {
	state: ReviewRollupState;
	reviewed: number;
	total: number;
}) {
	if (!total) return null;
	return (
		<span className={`rollup ${state ? `roll-${state}` : "roll-none"}`} title={state || "unreviewed"}>
			{reviewed || 0}/{total}
		</span>
	);
}
