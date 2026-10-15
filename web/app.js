const BANKS = "ABCDEFGHIJ";
// LED-bright hues for stem colours, spaced around the wheel.
const COLORS = ["#ff5a5f", "#ffa630", "#ffe14d", "#7ee36b", "#3fd6c6", "#45b3ff", "#7a7dff", "#c46bff", "#ff6bcf", "#b8e04a", "#ff8f6b", "#6be0ff"];
// Visual order of pads within a bank (index into the 16 pads), row by row from the top.
const PAD_ORDER = [...Array(16).keys()];

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = Object.assign(document.createElement(tag), props);
  n.append(...kids);
  return n;
};

const state = {
  root: "",
  outDir: "",
  project: null,
  groups: [], // {id, name, color, pads: Set<number>}
  active: null,
  selection: null, // {kind, number, label, sequence, pads}
  stems: [],
  timeline: null, // {seconds, segments, hits} for the current selection
  padNodes: new Map(),
};
let nextId = 1;

async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : undefined);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---- persistence of stem groups per project (a per-browser convenience) ----
const storeKey = () => `sp404-stems:${state.project.dir}`;
function saveGroups() {
  try {
    localStorage.setItem(storeKey(), JSON.stringify(state.groups.map((g) => ({ name: g.name, color: g.color, pads: [...g.pads] }))));
  } catch {}
}
function loadGroups() {
  try {
    const raw = localStorage.getItem(storeKey());
    if (raw) return JSON.parse(raw).map((g) => ({ ...g, id: nextId++, pads: new Set(g.pads) }));
  } catch {}
  return null;
}

function groupsByBank() {
  const groups = [];
  for (let b = 0; b < 10; b++) {
    const pads = state.project.pads.filter((p) => p.hasSample && Math.floor(p.index / 16) === b).map((p) => p.index);
    if (pads.length) groups.push({ id: nextId++, name: `Bank ${BANKS[b]}`, color: COLORS[b % COLORS.length], pads: new Set(pads) });
  }
  return groups;
}

const groupOf = (pad) => state.groups.find((g) => g.pads.has(pad));

// ---- projects ----
async function scan(root) {
  const data = await api(`/api/projects?root=${encodeURIComponent(root)}`);
  state.root = data.root;
  $("root").value = data.root;
  try { localStorage.setItem("sp404-stems:root", data.root); } catch {}
  const sel = $("project");
  sel.replaceChildren(...data.projects.map((p) => el("option", { value: p.dir, textContent: p.name })));
  if (!data.projects.length) {
    sel.append(el("option", { value: "", textContent: "No projects found here" }));
    $("wall").replaceChildren();
    $("hint").textContent = "No folders with a PADCONF.BIN were found. Point this at your SD card or a folder of exported projects.";
    return;
  }
  const last = localStorage.getItem("sp404-stems:last");
  if (last && data.projects.some((p) => p.dir === last)) sel.value = last;
  await openProject(sel.value);
}

async function openProject(dir) {
  if (!dir) return;
  try { localStorage.setItem("sp404-stems:last", dir); } catch {}
  state.project = await api(`/api/project?dir=${encodeURIComponent(dir)}`);
  state.groups = loadGroups() ?? groupsByBank();
  state.active = state.groups[0]?.id ?? null;
  state.selection = null;
  $("bpm").value = "";
  let continuation = "mk2";
  try { continuation = localStorage.getItem(`sp404-stems:continuation:${dir}`) || "mk2"; } catch {}
  $("continuation").value = continuation;
  $("hint").textContent = "Click or drag across pads to put them in the selected stem. Right-click a pad to hear it.";
  renderSequences();
  renderWall();
  renderGroups();
  renderRenderBox();
}

// ---- patterns and chains ----
function renderSequences() {
  const { patterns, chains } = state.project;
  const isSel = (kind, n) => state.selection?.kind === kind && state.selection.number === n;
  $("patterns").replaceChildren(
    ...(patterns.length
      ? patterns.map((p) =>
          el("li", {}, el("button", { ariaPressed: String(isSel("pattern", p.number)), onclick: () => select("pattern", p) },
            el("span", { textContent: `Pattern ${p.label}` }), el("span", { className: "meta", textContent: `${p.bars} bars${p.meter !== "4/4" ? ` in ${p.meter}` : ""}, ${p.bpm}` }))))
      : [el("li", { className: "empty", textContent: "No patterns in this project" })]),
  );
  $("chains").replaceChildren(
    ...(chains.length
      ? chains.map((c) =>
          el("li", {}, el("button", { ariaPressed: String(isSel("chain", c.number)), onclick: () => select("chain", c) },
            el("span", { textContent: `Chain ${c.number + 1}` }), el("span", { className: "meta", textContent: `${c.patterns.length} patterns` }))))
      : [el("li", { className: "empty", textContent: "No pattern chains" })]),
  );
}

function select(kind, item) {
  const byNumber = new Map(state.project.patterns.map((p) => [p.number, p]));
  const tempos = [...new Set((kind === "pattern" ? [item] : item.patterns.map((n) => byNumber.get(n)).filter(Boolean)).map((p) => p.bpm))];
  const source = state.project.useProjectTempo ? "project tempo" : "bank tempo";
  $("bpm").placeholder = tempos.length === 1 ? `${tempos[0]} (${source})` : `Each pattern's bank tempo`;
  if (kind === "pattern") {
    state.selection = { kind, number: item.number, label: `Pattern ${item.label}`, sequence: [item.number], pads: new Set(item.pads) };
  } else {
    const parts = item.patterns.map((n) => byNumber.get(n)).filter(Boolean);
    state.selection = {
      kind, number: item.number, sequence: item.patterns,
      label: `Chain ${item.number + 1}`,
      pads: new Set(parts.flatMap((p) => p.pads)),
      detail: parts.map((p) => p.label).join(" "),
    };
  }
  // A single pattern loops on the device, so its tails wrap around; a chain's last sounds ring out.
  $("tail").value = kind === "pattern" ? "wrap" : "extend";
  renderSequences();
  renderWall();
  renderRenderBox();
}

// ---- pad wall ----
let painting = null; // "add" | "remove" while the mouse is held

function renderWall() {
  const wall = $("wall");
  const used = state.selection?.pads;
  wall.classList.toggle("focused", !!used);
  state.padNodes = new Map();
  wall.replaceChildren(
    ...[...Array(10).keys()].map((b) =>
      el("div", { className: "bank" },
        el("h3", {}, `Bank ${BANKS[b]}`),
        el("div", { className: "pads" }, ...PAD_ORDER.map((i) => padEl(b * 16 + i, used))))),
  );
}

function padEl(index, used) {
  const pad = state.project.pads[index];
  const g = groupOf(index);
  const node = el("div", {
    className: `pad${pad.hasSample ? "" : " empty"}${g ? " grouped" : ""}${used?.has(index) ? " used" : ""}`,
    title: pad.hasSample ? `${pad.label} ${pad.name}${g ? ` (${g.name})` : ""}` : `${pad.label} (empty)`,
  });
  node.dataset.pad = index;
  state.padNodes.set(index, node);
  if (g) node.style.setProperty("--glow", g.color);
  node.append(el("span", { className: "num", textContent: (index % 16) + 1 }), el("span", { className: "name", textContent: pad.hasSample ? pad.name : "" }));
  if (!pad.hasSample) return node;
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.setAttribute("aria-label", `Pad ${pad.label}, ${pad.name}${g ? `, in ${g.name}` : ""}`);
  node.append(el("button", { className: "listen", textContent: "▶", ariaLabel: `Play pad ${pad.label}`, onmousedown: (e) => e.stopPropagation(), onclick: (e) => { e.stopPropagation(); playPad(index); } }));
  node.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    const active = state.groups.find((x) => x.id === state.active);
    if (!active) return;
    painting = active.pads.has(index) ? "remove" : "add";
    paint(index);
  });
  node.addEventListener("mouseenter", () => painting && paint(index));
  node.addEventListener("contextmenu", (e) => { e.preventDefault(); playPad(index); });
  node.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { painting = groupOf(index)?.id === state.active ? "remove" : "add"; paint(index); painting = null; }
    if (e.key === " ") { e.preventDefault(); playPad(index); }
  });
  return node;
}

function paint(index) {
  const active = state.groups.find((x) => x.id === state.active);
  if (!active) return;
  for (const g of state.groups) g.pads.delete(index);
  if (painting === "add") active.pads.add(index);
  const node = document.querySelector(`.pad[data-pad="${index}"]`);
  node.replaceWith(padEl(index, state.selection?.pads));
  groupsChanged();
}
window.addEventListener("mouseup", () => (painting = null));

// ---- stem groups ----
function renderGroups() {
  $("groups").replaceChildren(
    ...state.groups.map((g) => {
      const li = el("li", { className: "group", ariaSelected: String(g.id === state.active), onclick: () => { state.active = g.id; renderGroups(); } });
      li.style.setProperty("--group", g.color);
      const swatch = el("button", { className: "swatch", title: "Change colour", ariaLabel: `Change colour of ${g.name}` });
      swatch.onclick = (e) => {
        e.stopPropagation();
        g.color = COLORS[(COLORS.indexOf(g.color) + 1) % COLORS.length];
        groupsChanged(true);
      };
      const name = el("input", { className: "gname", value: g.name, ariaLabel: "Stem name" });
      name.onchange = () => { g.name = name.value.trim() || g.name; groupsChanged(true); };
      name.onclick = (e) => e.stopPropagation();
      const remove = el("button", { className: "remove", textContent: "✕", title: "Delete stem", ariaLabel: `Delete ${g.name}` });
      remove.onclick = (e) => {
        e.stopPropagation();
        state.groups = state.groups.filter((x) => x !== g);
        if (state.active === g.id) state.active = state.groups[0]?.id ?? null;
        groupsChanged(true);
      };
      li.append(swatch, name, el("span", { className: "count", textContent: `${g.pads.size} pads` }), remove);
      return li;
    }),
  );
  if (!state.groups.length) $("groups").append(el("li", { className: "hint", textContent: "No stems yet. Add one, then paint pads into it." }));
}

function groupsChanged(full = false) {
  saveGroups();
  renderGroups();
  if (full) renderWall();
  scheduleRender();
}

$("add-group").onclick = () => {
  const used = new Set(state.groups.map((g) => g.color));
  const color = COLORS.find((c) => !used.has(c)) ?? COLORS[state.groups.length % COLORS.length];
  const g = { id: nextId++, name: `Stem ${state.groups.length + 1}`, color, pads: new Set() };
  state.groups.push(g);
  state.active = g.id;
  groupsChanged(true);
};
$("group-banks").onclick = () => {
  state.groups = groupsByBank();
  state.active = state.groups[0]?.id ?? null;
  groupsChanged(true);
};

// ---- rendering, preview and export ----
function renderRequest() {
  const groups = {};
  const seen = new Map();
  for (const g of state.groups) {
    let name = g.name;
    const n = (seen.get(name) ?? 0) + 1;
    seen.set(g.name, n);
    if (n > 1) name = `${name} ${n}`;
    groups[name] = [...g.pads];
  }
  return { dir: state.project.dir, sequence: state.selection.sequence, groups, bpm: Number($("bpm").value) || undefined, tail: $("tail").value, continuation: $("continuation").value };
}

function renderRenderBox() {
  const box = $("render-box");
  box.hidden = !state.selection;
  $("transport").hidden = !state.selection;
  state.timeline = null;
  $("pick-hint").hidden = !!state.selection;
  if (!state.selection) return;
  $("render-title").textContent = state.selection.detail ? `${state.selection.label}: ${state.selection.detail}` : state.selection.label;
  $("status").textContent = "";
  $("refactor-status").textContent = "";
  $("refactor-title").textContent = `Make a new project from this ${state.selection.kind}`;
  const base = (state.project.name || "PROJECT").replace(/\s+/g, "_");
  $("refactor-name").value = `${base}_${state.selection.label.replace(/\s+/g, "").toUpperCase()}`;
  scheduleRender();
}

let renderTimer;
function scheduleRender() {
  if (!state.selection) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(() => { refreshStems(); refreshRefactorPlan(); }, 250);
}

async function refreshRefactorPlan() {
  const list = $("refactor-plan");
  try {
    const { dir, sequence, groups } = renderRequest();
    const plan = await api("/api/refactor/plan", { dir, sequence, groups });
    const colorOf = (name) => state.groups.find((g) => g.name === name)?.color ?? "#9aa0a6";
    const rows = [];
    for (const s of plan.stems) {
      const banks = [...new Set(s.moves.map((m) => m.toLabel.replace(/\d+$/, "")))];
      const stem = el("span", { className: "stem" }, el("span", { className: "dot" }), el("span", { textContent: `${s.stem} (${s.moves.length} pads)` }));
      stem.style.setProperty("--group", colorOf(s.stem));
      rows.push(el("li", {}, el("span", { className: "bank", textContent: `Bank ${banks.join("–")}` }), stem));
    }
    for (const w of plan.warnings) rows.push(el("li", {}, el("span", { className: "note", textContent: w })));
    for (const e of plan.errors) rows.push(el("li", {}, el("span", { className: "note error", textContent: e })));
    list.replaceChildren(...rows);
    $("refactor").disabled = plan.errors.length > 0;
  } catch (err) {
    list.replaceChildren(el("li", {}, el("span", { className: "note error", textContent: `Couldn't plan the new project: ${err.message}` })));
    $("refactor").disabled = true;
  }
}

$("refactor").onclick = async () => {
  const btn = $("refactor");
  const status = $("refactor-status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Creating project…";
  try {
    const { dir, sequence, groups } = renderRequest();
    const sel = state.selection;
    const name = $("refactor-name").value.trim();
    if (!name) throw new Error("Give the new project a name.");
    const data = await api("/api/refactor", { dir, sequence, groups, name, chainNumber: sel.kind === "chain" ? sel.number : undefined });
    // Carry the stem colours and names over to the new project, now one bank per stem.
    const carried = (await api("/api/refactor/plan", { dir, sequence, groups })).stems.map((s) => ({
      name: s.stem, color: state.groups.find((g) => g.name === s.stem)?.color ?? COLORS[0], pads: s.moves.map((m) => m.to),
    }));
    try { localStorage.setItem(`sp404-stems:${data.dest}`, JSON.stringify(carried)); } catch {}
    status.replaceChildren(
      `Created ${data.dest} with ${data.samples} samples and ${data.patterns} patterns.`,
      el("br"),
      el("button", { className: "quiet", textContent: "Open new project", onclick: async () => { await scan(state.root); $("project").value = data.dest; openProject(data.dest); } }),
      el("button", { className: "quiet", textContent: "Show in Finder", onclick: () => api(`/api/reveal?path=${encodeURIComponent(data.dest)}`) }),
    );
  } catch (err) {
    status.className = "status error";
    status.textContent = `Couldn't create the project: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

async function refreshStems() {
  const list = $("stem-previews");
  list.replaceChildren(el("li", { className: "hint", textContent: "Rendering…" }));
  try {
    const req = renderRequest();
    const data = await api("/api/render", req);
    state.stems = data.stems;
    state.timeline = data;
    renderTracker();
    const colorOf = (name) => state.groups.find((g) => g.name === name)?.color ?? "#9aa0a6";
    list.replaceChildren(
      ...data.stems.map((name) => {
        const b = el("button", {}, el("span", { className: "dot" }), el("span", { textContent: name === "ungrouped" ? "Pads in no stem" : name }));
        b.style.setProperty("--group", colorOf(name));
        b.dataset.key = `stem:${name}`;
        b.onclick = () => playUrl(`/api/render.wav?req=${encodeURIComponent(JSON.stringify(req))}&stem=${encodeURIComponent(name)}`, b.dataset.key);
        return el("li", {}, b);
      }),
    );
    $("preview-mix").textContent = `Play full mix (${data.seconds.toFixed(1)} s)`;
    if (!data.stems.length) list.replaceChildren(el("li", { className: "hint", textContent: "This pattern has no notes on pads with samples." }));
    markPlaying();
  } catch (err) {
    list.replaceChildren(el("li", { className: "status error", textContent: `Couldn't render: ${err.message}` }));
  }
}

$("bpm").onchange = scheduleRender;
$("tail").onchange = scheduleRender;
$("continuation").onchange = () => {
  try { localStorage.setItem(`sp404-stems:continuation:${state.project.dir}`, $("continuation").value); } catch {}
  scheduleRender();
};
$("preview-mix").dataset.key = "mix";
$("preview-mix").onclick = () => playUrl(`/api/render.wav?req=${encodeURIComponent(JSON.stringify(renderRequest()))}`, "mix");

$("export").onclick = async () => {
  const btn = $("export");
  const status = $("status");
  btn.disabled = true;
  status.className = "status";
  status.textContent = "Exporting…";
  try {
    const sel = state.selection;
    const label = sel.kind === "pattern" ? sel.label : `${sel.label} (${sel.detail})`;
    const data = await api("/api/export", { ...renderRequest(), outDir: $("out-dir").value, label, includeMix: $("include-mix").checked });
    status.replaceChildren(
      `Exported ${data.written.length} files to ${data.dest}`,
      el("br"),
      el("button", { className: "quiet", textContent: "Show in Finder", onclick: () => api(`/api/reveal?path=${encodeURIComponent(data.dest)}`) }),
    );
    try { localStorage.setItem("sp404-stems:out", $("out-dir").value); } catch {}
  } catch (err) {
    status.className = "status error";
    status.textContent = `Export failed: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

// ---- copying projects from the unit over USB ----
let deviceJob = null;
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function deviceStatus(text, error = false, ...extra) {
  const st = $("device-status");
  st.className = error ? "status error" : "status";
  st.replaceChildren(text, ...extra);
}

async function loadDeviceProjects() {
  const list = $("device-projects");
  list.replaceChildren();
  deviceStatus("Looking for the SP-404…");
  try {
    const data = await api("/api/device");
    if (!data.connected) {
      deviceStatus("No SP-404MKII found. Connect it with a USB cable, turn it on, then ", false,
        el("button", { className: "quiet", textContent: "look again", onclick: loadDeviceProjects }));
      return;
    }
    deviceStatus(`${data.projects.length} projects on the unit.`);
    list.replaceChildren(...data.projects.map((p) => el("li", {},
      el("span", { className: "slot", textContent: `P${p.slot}` }),
      el("span", p.name ? { textContent: p.name } : { className: "unnamed", textContent: "Unnamed project" }),
      el("button", { textContent: "Copy", onclick: () => copyFromDevice(p) }),
    )));
  } catch (err) {
    deviceStatus(`Couldn't read the SP-404: ${err.message} `, true,
      el("button", { className: "quiet", textContent: "Try again", onclick: loadDeviceProjects }));
  }
}

async function copyFromDevice(p) {
  const dest = $("device-dir").value;
  try { localStorage.setItem("sp404-stems:device-dir", dest); } catch {}
  for (const b of $("device-projects").querySelectorAll("button")) b.disabled = true;
  $("device-progress").hidden = false;
  $("device-bar").value = 0;
  $("device-progress-text").textContent = `Copying P${p.slot}…`;
  deviceStatus("");
  try {
    deviceJob = await api("/api/device/copy", { slot: p.slot, dest });
    for (;;) {
      await new Promise((r) => setTimeout(r, 300));
      const job = await api(`/api/device/job?id=${deviceJob.id}`);
      if (job.progress) {
        const { bytes, totalBytes, filesDone, files } = job.progress;
        $("device-bar").value = totalBytes ? bytes / totalBytes : 0;
        $("device-progress-text").textContent = `Copying P${p.slot}: ${mb(bytes)} of ${mb(totalBytes)} (${filesDone} of ${files} files)`;
      }
      if (job.state === "running") continue;
      if (job.state === "done") {
        deviceStatus(`Copied P${p.slot} to ${job.dest}. `, false,
          el("button", { className: "quiet", textContent: "Open it", onclick: () => openCopied(job.dest) }),
          el("button", { className: "quiet", textContent: "Show in Finder", onclick: () => api(`/api/reveal?path=${encodeURIComponent(job.dest)}`) }));
      } else if (job.state === "cancelled") {
        deviceStatus("Copy cancelled. Nothing was saved.");
      } else {
        deviceStatus(`Copy failed: ${job.error} Nothing was saved.`, true);
      }
      break;
    }
  } catch (err) {
    deviceStatus(`Copy failed: ${err.message}`, true);
  } finally {
    deviceJob = null;
    $("device-progress").hidden = true;
    for (const b of $("device-projects").querySelectorAll("button")) b.disabled = false;
  }
}

async function openCopied(dest) {
  $("device").close();
  const root = dest.replace(/[\\/][^\\/]+$/, "");
  await scan(root);
  $("project").value = dest;
  await openProject(dest);
}

$("device-open").onclick = () => { $("device").showModal(); loadDeviceProjects(); };
$("device-close").onclick = () => $("device").close();
$("device-cancel").onclick = () => deviceJob && api(`/api/device/cancel?id=${deviceJob.id}`);
$("choose-device-dir").onclick = () => chooseFolder($("device-dir"));

// ---- transport: metronome, position and tracker ----
function renderTracker() {
  const tl = state.timeline;
  if (!tl) return;
  $("segments").replaceChildren(
    ...tl.segments.map((s) => {
      const meter = `${s.beatsPerBar}/${s.beatUnit}`;
      const d = el("div", { textContent: meter === "4/4" ? s.label : `${s.label} ${meter}`, title: `Pattern ${s.label}, ${s.bars} bars of ${meter} at ${s.bpm} bpm` });
      d.style.flex = `${s.end - s.start} 0 0`;
      return d;
    }),
  );
  // Tails past the last pattern ("let ring out") take up the remaining width.
  const last = tl.segments[tl.segments.length - 1];
  if (last && tl.seconds > last.end + 0.01) {
    const d = el("div", { textContent: "tail" });
    d.style.flex = `${tl.seconds - last.end} 0 0`;
    $("segments").append(d);
  }
  showPosition(player.currentTime || 0);
}

function segmentAt(t) {
  const segs = state.timeline?.segments ?? [];
  return segs.find((s) => t >= s.start && t < s.end) ?? null;
}

let litPads = new Set();
function showPosition(t) {
  const tl = state.timeline;
  if (!tl) return;
  $("playhead").style.left = `${Math.min(100, (t / tl.seconds) * 100)}%`;
  const seg = segmentAt(t);
  // One metronome light per beat of the current pattern's bar.
  const want = seg?.beatsPerBar ?? 4;
  if ($("beats").children.length !== want) $("beats").replaceChildren(...Array.from({ length: want }, () => el("span")));
  const beats = [...$("beats").children];
  [...$("segments").children].forEach((d, i) => d.classList.toggle("current", tl.segments[i] === seg));
  if (seg) {
    // Tempo counts quarter notes; eighth-note meters tick twice per quarter.
    const beat = Math.floor(((t - seg.start) * seg.bpm * (seg.beatUnit / 4)) / 60);
    const inBar = beat % seg.beatsPerBar;
    const meter = `${seg.beatsPerBar}/${seg.beatUnit}`;
    $("now-pattern").textContent = `Pattern ${seg.label}, ${meter === "4/4" ? "" : `${meter}, `}${seg.bpm} bpm`;
    $("now-pos").textContent = `${Math.floor(beat / seg.beatsPerBar) + 1}.${inBar + 1}`;
    const playing = !player.paused && isSelectionAudio();
    beats.forEach((b, i) => {
      b.classList.toggle("on", playing && i === inBar);
      b.classList.toggle("down", i === 0);
    });
  } else {
    beats.forEach((b) => b.classList.remove("on"));
  }
}

const isSelectionAudio = () => playingKey === "mix" || playingKey?.startsWith("stem:");

// Light the pads that are sounding at time t (only the playing stem's pads when previewing a stem).
function lightPads(t) {
  const next = new Set();
  const struck = new Set();
  if (state.timeline && isSelectionAudio() && !player.paused) {
    const stem = playingKey.startsWith("stem:") ? playingKey.slice(5) : null;
    for (const h of state.timeline.hits) {
      if (h.start > t) break;
      if (t < h.end && (!stem || h.stem === stem)) {
        next.add(h.pad);
        if (t - h.start < 0.12) struck.add(h.pad);
      }
    }
  } else if (playingKey?.startsWith("pad:") && !player.paused) {
    next.add(Number(playingKey.slice(4)));
  }
  for (const pad of litPads) if (!next.has(pad)) state.padNodes.get(pad)?.classList.remove("lit", "struck");
  for (const pad of next) {
    const n = state.padNodes.get(pad);
    n?.classList.add("lit");
    n?.classList.toggle("struck", struck.has(pad));
  }
  litPads = next;
}

function tick() {
  const t = player.currentTime || 0;
  if (isSelectionAudio()) showPosition(t);
  lightPads(t);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

$("tracker").onclick = (e) => {
  const tl = state.timeline;
  if (!tl) return;
  const r = $("tracker").getBoundingClientRect();
  const t = ((e.clientX - r.left) / r.width) * tl.seconds;
  if (!isSelectionAudio()) {
    playUrl(`/api/render.wav?req=${encodeURIComponent(JSON.stringify(renderRequest()))}`, "mix");
    player.addEventListener("loadedmetadata", () => (player.currentTime = t), { once: true });
  } else {
    player.currentTime = t;
    if (player.paused) player.play();
  }
};

// ---- audio ----
const player = $("player");
let playingKey = null;
function playUrl(url, key) {
  if (playingKey === key && !player.paused) {
    player.pause();
    playingKey = null;
  } else {
    player.src = url;
    player.play();
    playingKey = key;
  }
  markPlaying();
}
function playPad(index) {
  playUrl(`/api/pad.wav?dir=${encodeURIComponent(state.project.dir)}&pad=${index}`, `pad:${index}`);
}
function markPlaying() {
  document.querySelectorAll(".playing").forEach((n) => n.classList.remove("playing"));
  if (!playingKey) return;
  if (playingKey.startsWith("pad:")) document.querySelector(`.pad[data-pad="${playingKey.slice(4)}"]`)?.classList.add("playing");
  else document.querySelector(`[data-key="${CSS.escape(playingKey)}"]`)?.classList.add("playing");
}
player.onended = () => { playingKey = null; markPlaying(); };

// ---- boot ----
$("root-form").onsubmit = (e) => { e.preventDefault(); scan($("root").value); };
$("project").onchange = (e) => openProject(e.target.value);

// Native folder pickers, when running as the desktop app.
async function chooseFolder(input) {
  const { path } = await api(`/api/choose-folder?start=${encodeURIComponent(input.value)}`);
  if (path) input.value = path;
  return path;
}
$("choose-root").onclick = async () => { if (await chooseFolder($("root"))) scan($("root").value); };
$("choose-out").onclick = async () => {
  const path = await chooseFolder($("out-dir"));
  if (path) try { localStorage.setItem("sp404-stems:out", path); } catch {}
};

(async () => {
  const cfg = await api("/api/config");
  $("choose-root").hidden = $("choose-out").hidden = $("choose-device-dir").hidden = !cfg.canChooseFolder;
  let deviceDir = cfg.deviceDir;
  try { deviceDir = localStorage.getItem("sp404-stems:device-dir") || deviceDir; } catch {}
  $("device-dir").value = deviceDir;
  let out = cfg.outDir;
  let root = cfg.root;
  try {
    out = localStorage.getItem("sp404-stems:out") || out;
    if (cfg.canChooseFolder) root = localStorage.getItem("sp404-stems:root") || root;
  } catch {}
  $("out-dir").value = out;
  await scan(root).catch(() => scan(cfg.root));
})();
