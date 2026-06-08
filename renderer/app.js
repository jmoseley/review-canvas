// Review Lens iframe app. Talks to the extension's loopback server over fetch +
// SSE. Renders the intent band, risk-routed rail, inspector diff, guided tour,
// and chat dock. Deterministic git facts and model hints are styled distinctly.

const instanceId = new URLSearchParams(location.search).get("instanceId") || "";
const q = (s) => `${s}${s.includes("?") ? "&" : "?"}instanceId=${encodeURIComponent(instanceId)}`;

const el = (id) => document.getElementById(id);
let overview = null;
let activePath = null;
// Pending UX: the tour POST now returns immediately ({pending:true}); the
// real result lands later via an SSE "state" event. We track the generatedAt we
// saw at click time and clear the pending button once a newer one arrives.
let tourPending = false;
let tourPendingPrev = null;

async function api(path, opts) {
	const res = await fetch(q(path), opts);
	const json = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(json.message || json.error || res.statusText);
	return json;
}

function riskClass(score) {
	if (score >= 6) return "risk-hi";
	if (score >= 3) return "risk-mid";
	return "risk-lo";
}

function esc(s) {
	return String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

// --- Intent band -------------------------------------------------------------

function renderIntent() {
	if (!overview) return;
	el("base-badge").textContent = `${overview.baseRef} → ${overview.headShort}`;
	const t = overview.totals || {};
	el("totals").innerHTML =
		`${t.files || 0} files · <span class="add">+${t.additions || 0}</span> ` +
		`<span class="del">-${t.deletions || 0}</span>`;
}

// --- Rail --------------------------------------------------------------------

function dispChip(key, current) {
	const states = [
		["reviewed", "✓"],
		["needs-work", "⚠"],
		["skip", "»"],
	];
	return states
		.map(
			([s, label]) =>
				`<button class="btn small disp ${current === s ? "primary" : "ghost"}" ` +
				`data-disp-key="${esc(key)}" data-disp-state="${s}">${label}</button>`,
		)
		.join("");
}

// Small inline marker for a file's review disposition, shown in the rail.
const DISP_MARK = {
	reviewed: ["✓", "reviewed"],
	"needs-work": ["⚠", "needs work"],
	skip: ["»", "skipped"],
};

function reviewMark(f) {
	const m = DISP_MARK[f.disposition];
	if (!m) return "";
	const stale = f.reviewStale
		? ` <span class="stale-dot" title="changed since you marked it ${m[1]}">●</span>`
		: "";
	return `<span class="file-disp disp-${f.disposition}" title="${m[1]}">${m[0]}</span>${stale}`;
}

// Roll-up badge for a group / tour step: "n/m" reviewed, tinted by state.
function rollupBadge(state, reviewed, total) {
	if (!total) return "";
	const cls = state ? `roll-${state}` : "roll-none";
	return `<span class="rollup ${cls}" title="${esc(state || "unreviewed")}">${reviewed || 0}/${total}</span>`;
}

function renderRail() {
	const list = el("rail-list");
	if (!overview) {
		list.innerHTML = "";
		return;
	}
	const byPath = new Map(overview.files.map((f) => [f.path, f]));
	if (!overview.groups.length) {
		list.innerHTML =
			`<div class="rail-empty">No changes between <strong>${esc(overview.baseRef || "base")}</strong> and the working tree. ` +
			`Use <strong>Base…</strong> to pick a different comparison point.</div>`;
		return;
	}
	list.innerHTML = overview.groups
		.map((g) => {
			const score = g.risk?.score || 0;
			const files = g.files
				.map((p) => {
					const f = byPath.get(p);
					if (!f) return "";
					const fr = f.risk?.score || 0;
					return (
						`<div class="file-row${activePath === p ? " active" : ""}" data-path="${esc(p)}">` +
						`<span class="risk-dot ${riskClass(fr)}"></span>` +
						`<span class="file-path">${esc(p)}</span>` +
						reviewMark(f) +
						`<span class="file-churn">+${f.additions}/-${f.deletions}</span>` +
						`</div>`
					);
				})
				.join("");
			const groupKey = `group:${g.id}`;
			const allReviewed = g.reviewState === "reviewed";
			return (
				`<div class="group">` +
				`<div class="group-head" data-group="${esc(g.id)}">` +
				`<span class="risk-dot ${riskClass(score)}"></span>` +
				`<span class="group-label">${esc(g.label)}</span>` +
				rollupBadge(g.reviewState, g.reviewedCount, g.fileCount) +
				`<button class="btn small group-review ${allReviewed ? "primary" : "ghost"}" ` +
				`data-disp-key="${esc(groupKey)}" data-disp-state="reviewed" ` +
				`title="Mark every file in this group reviewed">✓</button>` +
				`</div>` +
				`<div class="group-files">${files}</div>` +
				`</div>`
			);
		})
		.join("");
}

// --- Inspector ---------------------------------------------------------------

function renderDiffText(text) {
	return esc(text)
		.split("\n")
		.map((line) => {
			let cls = "";
			if (line.startsWith("+") && !line.startsWith("+++")) cls = "add";
			else if (line.startsWith("-") && !line.startsWith("---")) cls = "del";
			else if (line.startsWith("@@")) cls = "hdr";
			else if (/^(diff |index |--- |\+\+\+ |new file|deleted|rename|similarity)/.test(line))
				cls = "meta";
			return `<span class="ln ${cls}">${line || " "}</span>`;
		})
		.join("");
}

async function openFile(path) {
	activePath = path;
	renderRail();
	el("inspector-empty").hidden = true;
	const diffEl = el("diff");
	diffEl.hidden = false;
	diffEl.innerHTML = `<div class="diff-file-head"><span class="path">${esc(path)}</span> loading…</div>`;
	try {
		const { diff, file, flags } = await api(`/api/file?path=${encodeURIComponent(path)}`);
		if (!file) {
			// Path isn't in the current diff (base → working tree). This is what a
			// stale tour step points at; say so plainly instead of "(no diff)".
			diffEl.innerHTML =
				`<div class="diff-file-head"><span class="path">${esc(path)}</span></div>` +
				`<div class="reasons">This file isn’t part of the current diff (base → working tree). The tour may have been built against an earlier diff — regenerate it.</div>`;
			return;
		}
		const reasons = (file?.risk?.reasons || []).join(" · ");
		diffEl.innerHTML =
			`<div class="diff-file-head">` +
			`<span class="risk-dot ${riskClass(file?.risk?.score || 0)}"></span>` +
			`<span class="path">${esc(path)}</span>` +
			`<span class="group-meta">+${file?.additions || 0}/-${file?.deletions || 0} · fan-in ${file?.fanIn || 0}</span>` +
			`</div>` +
			(flags && flags.length
				? `<div class="flags">${flags.map((f) => `<span class="flag flag-${esc(f.severity || "low")}" title="${esc(f.kind || "")}">⚑ ${esc(f.message || f)}</span>`).join("")}</div>`
				: "") +
			(reasons ? `<div class="reasons">▸ ${esc(reasons)}</div>` : "") +
			(file?.reviewStale
				? `<div class="stale-note">● This file changed since you marked it ${esc(DISP_MARK[file.disposition]?.[1] || "reviewed")} — re-review.</div>`
				: "") +
			`<div class="disp-bar"><span class="group-meta">Disposition:</span> ${dispChip(path, file?.disposition)}</div>` +
			`<div class="hunk">${renderDiffText(diff || "(no diff)")}</div>`;
	} catch (e) {
		diffEl.innerHTML = `<div class="reasons">Error: ${esc(e.message)}</div>`;
	}
}

// --- Tour --------------------------------------------------------------------

function renderTour() {
	const tour = overview && overview.tour;
	const panel = el("tour");
	if (!tour || !tour.steps?.length) {
		panel.hidden = true;
		updateTourButton();
		return;
	}
	panel.hidden = false;
	const i = tour.current || 0;
	const step = tour.steps[i];
	const byPath = new Map((overview.files || []).map((f) => [f.path, f]));
	el("tour-progress").textContent = `Step ${i + 1} of ${tour.steps.length}`;
	el("tour-prev").disabled = i === 0;
	el("tour-next").disabled = i >= tour.steps.length - 1;
	const presentFiles = (step.files || []).filter((f) => byPath.has(f));
	el("tour-body").innerHTML =
		(tour.stale
			? `<div class="tour-stale">⟳ This tour was built against an earlier diff — some steps may point at files that have changed or are no longer in the changeset. <button class="btn small primary" data-tour-regen>Regenerate tour</button></div>`
			: "") +
		`<div class="tour-title">${esc(step.title)}</div>` +
		`<div class="tour-section"><h4>What this chunk is</h4><div>${esc(step.purpose)}</div></div>` +
		`<div class="tour-section"><h4>Where it sits in the whole app</h4><div>${esc(step.whereItSits)}</div></div>` +
		(step.scrutinize?.length
			? `<div class="tour-section scrutinize"><h4>Scrutinize</h4><ul>${step.scrutinize.map((s) => `<li>${esc(s)}</li>`).join("")}</ul></div>`
			: "") +
		(step.files?.length
			? `<div class="tour-section"><h4>Files ${rollupBadge(step.reviewState, step.reviewedCount, step.fileCount)}</h4>${step.files
					.map((f) => {
						const ff = byPath.get(f);
						const mark = ff ? reviewMark(ff) : ` <span class="file-gone">· not in diff</span>`;
						return `<a href="#" class="file-chip${ff ? "" : " missing"}" data-tour-file="${esc(f)}">${esc(f)}${mark}</a>`;
					})
					.join(" ")}</div>`
			: "");
	el("tour-disposition").innerHTML =
		`<span class="group-meta">Disposition this step:</span> ` +
		[
			["reviewed", "✓ Reviewed"],
			["needs-work", "⚠ Needs work"],
			["skip", "» Skip"],
		]
			.map(
				([s, label]) =>
					`<button class="btn small ${step.reviewState === s ? "primary" : "ghost"}" data-step-disp="${s}">${label}</button>`,
			)
			.join("");
	// Auto-focus the first file that actually survives in the current diff. If none
	// of this step's files are in the diff, show an explicit message rather than a
	// blank "(no diff)" pane.
	if (presentFiles.length) {
		if (presentFiles[0] !== activePath) openFile(presentFiles[0]);
	} else {
		showStepNoDiff(step);
	}
	// Pre-fill chat context.
	el("chat-input").placeholder = `Ask about “${step.title}”…`;
	updateTourButton();
}

// Render an explicit message in the diff pane when a tour step's files are all
// absent from the current diff (the stale-tour blank-pane case).
function showStepNoDiff(step) {
	activePath = null;
	renderRail();
	el("inspector-empty").hidden = true;
	const diffEl = el("diff");
	diffEl.hidden = false;
	diffEl.innerHTML =
		`<div class="diff-file-head"><span class="path">${esc(step.title)}</span></div>` +
		`<div class="reasons">None of this step’s files are part of the current diff (base → working tree). This tour was likely built against an earlier diff — regenerate it to re-walk the current changes.</div>`;
}

async function tourStep(current, disposition) {
	const body = {};
	if (current != null) body.current = current;
	if (disposition) body.disposition = disposition;
	const { tour } = await api("/api/tour/step", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (overview) overview.tour = tour;
	renderTour();
}

// --- Chat --------------------------------------------------------------------

let streamingMsg = null;

function addMsg(role, text) {
	const div = document.createElement("div");
	div.className = `msg ${role}`;
	div.textContent = text;
	el("chat-log").appendChild(div);
	el("chat-log").scrollTop = el("chat-log").scrollHeight;
	return div;
}

// --- SSE ---------------------------------------------------------------------

function connectSse() {
	const es = new EventSource(q("/events"));
	es.addEventListener("state", (e) => {
		overview = JSON.parse(e.data);
		resolvePending();
		renderAll();
	});
	es.addEventListener("error", (e) => {
		try {
			const d = JSON.parse(e.data);
			if (d.message) el("inspector-empty").textContent = `Error: ${d.message}`;
		} catch {}
	});
	es.addEventListener("focus", (e) => {
		const { groupId } = JSON.parse(e.data);
		const g = overview?.groups.find((x) => x.id === groupId);
		if (g?.files?.length) openFile(g.files[0]);
	});
	es.addEventListener("chat-user", (e) => addMsg("user", JSON.parse(e.data).text));
	es.addEventListener("chat-delta", (e) => {
		const { text } = JSON.parse(e.data);
		if (!streamingMsg) streamingMsg = addMsg("assistant", "");
		streamingMsg.textContent += text;
		el("chat-log").scrollTop = el("chat-log").scrollHeight;
	});
	es.addEventListener("chat-final", (e) => {
		const { text } = JSON.parse(e.data);
		if (streamingMsg) streamingMsg.textContent = text;
		else if (text) addMsg("assistant", text);
		streamingMsg = null;
	});
	es.addEventListener("chat-idle", () => {
		streamingMsg = null;
		// Watchdog: if a tour request errored out in the agent without ever
		// producing fresh state, un-stick the button when the turn ends.
		resolvePending(true);
	});
	es.addEventListener("chat-error", (e) =>
		addMsg("assistant", `⚠ ${JSON.parse(e.data).message}`),
	);
}

// --- Pending button UX -------------------------------------------------------

function setTourPendingUi(on) {
	tourPending = on;
	const b = el("btn-tour");
	if (on) {
		b.hidden = false;
		b.disabled = true;
		b.className = "btn primary";
		b.textContent = "Building tour…";
	} else {
		b.disabled = false;
		updateTourButton();
	}
}

// Adapt the toolbar tour button to the current state so a generated tour can't be
// accidentally restarted. No tour → prominent "Start". Tour exists but panel
// closed → low-key "Resume" (reopens, never regenerates). Panel open → hide it
// entirely; the docked panel owns Prev/Next/Regenerate/Exit.
function updateTourButton() {
	if (tourPending) return;
	const b = el("btn-tour");
	const hasTour = !!overview?.tour?.steps?.length;
	const panelOpen = hasTour && !el("tour").hidden;
	if (!hasTour) {
		b.hidden = false;
		b.className = "btn primary";
		b.textContent = "▶ Start guided tour";
		b.title = "";
		return;
	}
	if (panelOpen) {
		b.hidden = true;
		return;
	}
	b.hidden = false;
	b.className = "btn ghost";
	b.textContent = "▶ Resume tour";
	b.title = "Reopen the guided tour where you left off";
}

// Clear a pending button when fresh state arrives (generatedAt advanced past the
// value captured at click time). force=true (chat-idle watchdog) clears anyway.
function resolvePending(force) {
	if (tourPending) {
		const now = overview?.tour?.generatedAt || null;
		if (force || (now && now !== tourPendingPrev)) setTourPendingUi(false);
	}
}

// Kick off (or regenerate) the guided tour. Shared by the toolbar button and the
// stale-banner "Regenerate" affordance.
async function triggerTour(regenerate) {
	tourPendingPrev = overview?.tour?.generatedAt || null;
	setTourPendingUi(true);
	try {
		await api("/api/tour/start", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ regenerate: !!regenerate }),
		});
	} catch (e) {
		alert(`Tour failed: ${e.message}`);
		setTourPendingUi(false);
	}
}

// --- Render orchestration ----------------------------------------------------

function renderAll() {
	renderIntent();
	renderRail();
	renderTour();
}

// --- Events ------------------------------------------------------------------

function wireEvents() {
	el("btn-refresh").onclick = () => api("/api/overview?force=1").then((o) => {
		overview = o;
		renderAll();
	});

	el("btn-base").onclick = async () => {
		const { bases } = await api("/api/bases");
		const choice = prompt(
			`Base ref (current: ${overview?.baseRef}). Candidates:\n` +
				(bases || []).join("\n"),
			overview?.baseRef || "",
		);
		if (choice == null) return;
		overview = await api("/api/set-base", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ base: choice.trim() || null }),
		});
		renderAll();
	};

	el("btn-tour").onclick = () => {
		// Resume an existing (but closed) tour without regenerating; only start
		// fresh when no tour exists. Regeneration lives inside the tour panel.
		if (overview?.tour?.steps?.length) {
			el("tour").hidden = false;
			renderTour();
			return;
		}
		triggerTour(false);
	};

	el("tour-prev").onclick = () => tourStep((overview.tour.current || 0) - 1);
	el("tour-next").onclick = () => tourStep((overview.tour.current || 0) + 1);
	el("tour-regen").onclick = () => {
		if (confirm("Regenerate the tour from scratch?")) triggerTour(true);
	};
	el("tour-close").onclick = () => {
		el("tour").hidden = true;
		updateTourButton();
	};

	// Delegated clicks across rail, diff dispositions, tour controls.
	document.body.addEventListener("click", (e) => {
		// Disposition buttons first — some live inside group heads / rows.
		const disp = e.target.closest("[data-disp-key]");
		if (disp) {
			const cur = disp.classList.contains("primary");
			api("/api/disposition", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: disp.dataset.dispKey,
					state: cur ? null : disp.dataset.dispState,
				}),
			});
			return;
		}

		const stepDisp = e.target.closest("[data-step-disp]");
		if (stepDisp && overview?.tour) {
			const i = overview.tour.current || 0;
			const cur = overview.tour.steps[i]?.reviewState === stepDisp.dataset.stepDisp;
			tourStep(null, { index: i, state: cur ? null : stepDisp.dataset.stepDisp });
			return;
		}

		const fileRow = e.target.closest("[data-path]");
		if (fileRow) return openFile(fileRow.dataset.path);

		const groupHead = e.target.closest("[data-group]");
		if (groupHead) {
			const g = overview?.groups.find((x) => x.id === groupHead.dataset.group);
			if (g?.files?.length) openFile(g.files[0]);
			return;
		}

		const tourFile = e.target.closest("[data-tour-file]");
		if (tourFile) {
			e.preventDefault();
			openFile(tourFile.dataset.tourFile);
			return;
		}

		const tourRegen = e.target.closest("[data-tour-regen]");
		if (tourRegen) {
			e.preventDefault();
			// Explicit user click on the stale banner — no confirm needed.
			triggerTour(true);
		}
	});

	// Chat dock. Collapses into the bottom-corner circle; the whole top bar hides it.
	const setChatOpen = (open) => {
		el("chat").classList.toggle("hidden", !open);
		el("chat-toggle").classList.toggle("hidden", open);
		el("chat-head").setAttribute("aria-expanded", String(open));
		if (open) el("chat-input").focus();
	};
	el("chat-toggle").onclick = () => setChatOpen(true);
	el("chat-head").onclick = () => setChatOpen(false);
	el("chat-form").onsubmit = (e) => {
		e.preventDefault();
		const text = el("chat-input").value.trim();
		if (!text) return;
		el("chat-input").value = "";
		let prompt = text;
		const tour = overview?.tour;
		if (tour?.steps?.length) {
			const step = tour.steps[tour.current || 0];
			prompt = `[Review Lens — reviewing "${step.title}" (${(step.files || []).join(", ")})]\n${text}`;
		} else if (activePath) {
			prompt = `[Review Lens — looking at ${activePath}]\n${text}`;
		}
		api("/api/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ prompt }),
		}).catch((err) => addMsg("assistant", `⚠ ${err.message}`));
	};
}

// --- Boot --------------------------------------------------------------------

wireEvents();
connectSse();
api("/api/overview")
	.then((o) => {
		overview = o;
		renderAll();
	})
	.catch((e) => {
		el("inspector-empty").textContent = `Error: ${e.message}`;
	});
