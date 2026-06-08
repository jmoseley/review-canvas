// Wire contract shared by the extension server and the renderer. Every JSON
// payload that crosses the loopback HTTP/SSE boundary is typed here.

export type FileStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U";

export type Disposition = "reviewed" | "needs-work" | "skip";

/** Roll-up of per-file dispositions over a set of files. */
export type ReviewRollupState =
	| "stale"
	| "needs-work"
	| "reviewed"
	| "partial"
	| null;

export interface RiskScore {
	/** [0,1] heuristic attention score. */
	score: number;
	reasons: string[];
}

export interface FileEntry {
	path: string;
	oldPath: string | null;
	status: FileStatus;
	additions: number;
	deletions: number;
	noise: boolean;
	renameOnly: boolean;
	/** Working-tree blob sha ("deleted" sentinel for deletions, null unknown). */
	contentSha: string | null;
	risk: RiskScore;
	fanIn: number;
	disposition: Disposition | null;
	/** True when the file changed after its disposition was recorded. */
	reviewStale: boolean;
}

export interface Group {
	id: string;
	label: string;
	files: string[];
	additions: number;
	deletions: number;
	risk: { score: number };
	reviewState: ReviewRollupState;
	reviewedCount: number;
	fileCount: number;
}

export interface Affinity {
	a: string;
	b: string;
	count: number;
}

export interface TourStep {
	index: number;
	title: string;
	groupId: string | null;
	files: string[];
	purpose: string;
	whereItSits: string;
	scrutinize: string[];
	reviewState: ReviewRollupState;
	reviewedCount: number;
	fileCount: number;
	/** Step files that are no longer in the current diff. */
	missingFiles: string[];
}

export interface Tour {
	steps: TourStep[];
	current: number;
	generatedAt: string;
	mergeBase: string | null;
	/** Fingerprints of the diff the tour was built against. */
	files: { path: string; sha: string | null }[];
	/** Derived: the comparison window moved since the tour was generated. */
	stale: boolean;
}

export interface Totals {
	files: number;
	additions: number;
	deletions: number;
}

export interface Overview {
	root: string;
	baseRef: string;
	baseOverride: string | null;
	mergeBase: string;
	headSha: string;
	headShort: string;
	domain: string;
	totals: Totals;
	files: FileEntry[];
	groups: Group[];
	affinity: Affinity[];
	tour: Tour | null;
}

export interface ChatTurn {
	role: "user" | "assistant";
	text: string;
}

/**
 * The single canonical state snapshot. Every mutation ends with the server
 * pushing one of these over SSE; the renderer is a pure function of the last
 * snapshot (plus the in-flight chat-delta stream).
 */
export interface Snapshot {
	overview: Overview | null;
	/** Set while a requested tour has not yet been submitted by the agent. */
	tourPending: boolean;
	chat: ChatTurn[];
	/** True while the agent is mid-turn (streaming deltas may follow). */
	chatBusy: boolean;
	/** Set when overview computation failed; overview may be null/stale. */
	error: string | null;
}

export interface SuspicionFlag {
	kind: string;
	message: string;
	severity: "low" | "medium" | "high";
}

// --- HTTP API ------------------------------------------------------------

/** GET /api/file?path= */
export interface FileDetail {
	path: string;
	diff: string;
	file: FileEntry | null;
	flags: SuspicionFlag[];
}

/** GET /api/bases */
export interface BasesResponse {
	bases: string[];
}

/** POST /api/set-base */
export interface SetBaseRequest {
	base: string | null;
}

/** POST /api/disposition — key: file path, `group:<id>` or `step:<index>` */
export interface DispositionRequest {
	key: string;
	state: Disposition | null;
}

/** POST /api/tour/start */
export interface TourStartRequest {
	regenerate?: boolean;
}

/** POST /api/tour/step */
export interface TourStepRequest {
	current?: number;
	disposition?: { index: number; state: Disposition | null };
}

/** POST /api/chat */
export interface ChatRequest {
	prompt: string;
}

export interface ApiError {
	error: string;
	message: string;
}

// --- SSE events ----------------------------------------------------------

export interface SseEventMap {
	/** Full canonical snapshot. */
	state: Snapshot;
	/** Streaming token(s) for the in-flight assistant turn. */
	"chat-delta": { text: string };
	/** One-shot UI command: focus a concern group's first file. */
	focus: { groupId: string };
	/** Server-side failure the renderer should surface. */
	error: { message: string };
}

export type SseEventName = keyof SseEventMap;
