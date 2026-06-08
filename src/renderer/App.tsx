// Review Lens app shell. All durable state arrives as server snapshots (see
// store.ts); the only client-local state is UI ephemera: which file is open,
// whether the tour panel is shown, and inspector content.

import { useCallback, useEffect, useState } from "react";
import { ChatDock } from "./components/ChatDock.js";
import { Inspector, type InspectorContent } from "./components/Inspector.js";
import { IntentBar } from "./components/IntentBar.js";
import { Rail } from "./components/Rail.js";
import { TourPanel } from "./components/TourPanel.js";
import { useReviewState } from "./store.js";

export function App() {
	const [activePath, setActivePath] = useState<string | null>(null);
	const [tourPanelOpen, setTourPanelOpen] = useState(true);
	const [stepNoDiff, setStepNoDiff] = useState<string | null>(null);

	const openFile = useCallback((path: string) => {
		setActivePath(path);
		setStepNoDiff(null);
	}, []);

	// One-shot agent "focus" command: stash the request and resolve it against
	// the latest snapshot once available.
	const [focusRequest, setFocusRequest] = useState<string | null>(null);

	const { snapshot, streamText, error } = useReviewState(setFocusRequest);

	useEffect(() => {
		if (!focusRequest || !snapshot?.overview) return;
		const g = snapshot.overview.groups.find((x) => x.id === focusRequest);
		if (g?.files?.length) openFile(g.files[0]);
		setFocusRequest(null);
	}, [focusRequest, snapshot, openFile]);

	const overview = snapshot?.overview ?? null;
	const tour = overview?.tour ?? null;
	const hasTour = !!tour?.steps?.length;
	const showTourPanel = hasTour && tourPanelOpen;

	// A newly generated tour reopens the panel.
	const generatedAt = tour?.generatedAt ?? null;
	useEffect(() => {
		if (generatedAt) setTourPanelOpen(true);
	}, [generatedAt]);

	// Auto-focus the current step's first file that actually survives in the
	// diff. If none of this step's files are in the diff, show an explicit
	// message rather than a blank "(no diff)" pane.
	const stepIndex = tour?.current ?? -1;
	useEffect(() => {
		if (!showTourPanel || !tour || stepIndex < 0) return;
		const step = tour.steps[stepIndex];
		if (!step) return;
		const present = step.files.filter((f) => !step.missingFiles.includes(f));
		if (present.length) {
			setActivePath((prev) => (prev && present.includes(prev) ? prev : present[0]));
			setStepNoDiff(null);
		} else {
			setActivePath(null);
			setStepNoDiff(step.title);
		}
		// generatedAt in deps: a regenerated tour re-runs the auto-focus.
	}, [showTourPanel, stepIndex, generatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

	let inspectorContent: InspectorContent;
	if (activePath) inspectorContent = { kind: "file", path: activePath };
	else if (stepNoDiff) inspectorContent = { kind: "step-no-diff", title: stepNoDiff };
	else
		inspectorContent = {
			kind: "empty",
			message: error || snapshot?.error || undefined,
		};

	// Chat context: anchor prompts to the focused step or file.
	let chatPlaceholder = "Ask about the focused step…";
	let contextPrefix: string | null = null;
	if (showTourPanel && tour) {
		const step = tour.steps[tour.current || 0];
		if (step) {
			chatPlaceholder = `Ask about “${step.title}”…`;
			contextPrefix = `[Review Lens — reviewing "${step.title}" (${step.files.join(", ")})]`;
		}
	} else if (activePath) {
		contextPrefix = `[Review Lens — looking at ${activePath}]`;
	}

	return (
		<div className="app">
			<IntentBar
				overview={overview}
				tourPending={snapshot?.tourPending ?? false}
				tourPanelOpen={showTourPanel}
				onOpenTourPanel={() => setTourPanelOpen(true)}
			/>
			<main className="body">
				<Rail overview={overview} activePath={activePath} onOpenFile={openFile} />
				<section className="inspector">
					{showTourPanel && overview && (
						<TourPanel
							overview={overview}
							onOpenFile={openFile}
							onClose={() => setTourPanelOpen(false)}
						/>
					)}
					<Inspector content={inspectorContent} overview={overview} />
				</section>
			</main>
			<ChatDock
				chat={snapshot?.chat ?? []}
				streamText={streamText}
				placeholder={chatPlaceholder}
				contextPrefix={contextPrefix}
			/>
		</div>
	);
}
