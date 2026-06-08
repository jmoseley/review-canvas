// Intent band: base badge, totals, and the toolbar (tour / refresh / base).
// The tour button adapts to snapshot state so a generated tour can't be
// accidentally restarted: no tour → "Start"; tour exists but panel closed →
// low-key "Resume"; panel open → hidden (the docked panel owns navigation);
// pending → disabled "Building…".

import { useEffect, useRef, useState } from "react";
import type { Overview } from "../../shared/types.js";
import { api } from "../api.js";

export function IntentBar({
	overview,
	tourPending,
	tourPanelOpen,
	onOpenTourPanel,
}: {
	overview: Overview | null;
	tourPending: boolean;
	tourPanelOpen: boolean;
	onOpenTourPanel: () => void;
}) {
	const [pickerOpen, setPickerOpen] = useState(false);

	const hasTour = !!overview?.tour?.steps?.length;
	const showTourButton = tourPending || !hasTour || !tourPanelOpen;

	const onTourClick = () => {
		// Resume an existing (but closed) tour without regenerating; only start
		// fresh when no tour exists. Regeneration lives inside the tour panel.
		if (hasTour) {
			onOpenTourPanel();
			return;
		}
		api.tourStart({ regenerate: false }).catch(() => {});
	};

	return (
		<header className="intent">
			<div className="intent-main">
				<div className="intent-title">
					<span className="badge">
						{overview ? `${overview.baseRef} → ${overview.headShort}` : "base…"}
					</span>
					<span className="totals">
						{overview && (
							<>
								{overview.totals.files} files ·{" "}
								<span className="add">+{overview.totals.additions}</span>{" "}
								<span className="del">-{overview.totals.deletions}</span>
							</>
						)}
					</span>
				</div>
				<div className="intent-actions">
					{showTourButton && (
						<button
							className={`btn ${!hasTour || tourPending ? "primary" : "ghost"}`}
							disabled={tourPending}
							title={hasTour ? "Reopen the guided tour where you left off" : ""}
							onClick={onTourClick}
						>
							{tourPending
								? "Building tour…"
								: hasTour
									? "▶ Resume tour"
									: "▶ Start guided tour"}
						</button>
					)}
					<button className="btn ghost" onClick={() => api.refresh().catch(() => {})}>
						Refresh
					</button>
					<button className="btn ghost" onClick={() => setPickerOpen((v) => !v)}>
						Base…
					</button>
				</div>
			</div>
			{pickerOpen && (
				<BasePicker current={overview?.baseRef} onClose={() => setPickerOpen(false)} />
			)}
		</header>
	);
}

// In-UI base ref picker (window.prompt is unreliable inside the canvas webview).
function BasePicker({
	current,
	onClose,
}: {
	current: string | undefined;
	onClose: () => void;
}) {
	const [bases, setBases] = useState<string[] | null>(null);
	const [filter, setFilter] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		api.bases().then(({ bases }) => setBases(bases)).catch(() => setBases([]));
		inputRef.current?.focus();
	}, []);

	const choose = (base: string | null) => {
		onClose();
		api.setBase({ base }).catch(() => {});
	};

	const shown = (bases ?? []).filter((b) => b.includes(filter));

	return (
		<div className="base-picker">
			<input
				ref={inputRef}
				placeholder={`Filter refs… (current: ${current ?? "?"})`}
				value={filter}
				onChange={(e) => setFilter(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape") onClose();
					// Enter with a non-empty filter sets it directly (custom refs).
					if (e.key === "Enter" && filter.trim()) choose(filter.trim());
				}}
			/>
			<div className="base-picker-list">
				{bases === null && <div className="base-picker-empty">Loading refs…</div>}
				{bases !== null && shown.length === 0 && (
					<div className="base-picker-empty">
						No matching refs — press Enter to use “{filter}”.
					</div>
				)}
				{shown.map((b) => (
					<button
						key={b}
						className={`base-picker-item${b === current ? " current" : ""}`}
						onClick={() => choose(b)}
					>
						{b}
					</button>
				))}
			</div>
		</div>
	);
}
