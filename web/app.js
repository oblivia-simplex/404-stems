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
            el("span", { textContent: `Pattern ${p.label}` }), el("span", { className: "meta", textContent: `${p.bars} bars, ${p.bpm} bpm` }))))
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
  const tempos = new Set((kind === "pattern" ? [item] : item.patterns.map((n) => byNumber.get(n)).filter(Boolean)).map((p) => p.bpm));
  $("bpm").placeholder = tempos.size === 1 ? `${[...tempos][0]} (bank tempo)` : "Each pattern's bank tempo";
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
  wall.replaceChildren(
    ...[...Array(10).keys()].map((b) =>
      el("div", { className: "bank" },
        el("h3", {}, el("span", { textContent: `Bank ${BANKS[b]}` }), el("span", { className: "bpm", textContent: `${state.project.bankBpm[b]} bpm` })),
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
  return { dir: state.project.dir, sequence: state.selection.sequence, groups, bpm: Number($("bpm").value) || undefined, tail: $("tail").value };
}

function renderRenderBox() {
  const box = $("render-box");
  box.hidden = !state.selection;
  $("pick-hint").hidden = !!state.selection;
  if (!state.selection) return;
  $("render-title").textContent = state.selection.detail ? `${state.selection.label}: ${state.selection.detail}` : state.selection.label;
  $("status").textContent = "";
  scheduleRender();
}

let renderTimer;
function scheduleRender() {
  if (!state.selection) return;
  clearTimeout(renderTimer);
  renderTimer = setTimeout(refreshStems, 250);
}

async function refreshStems() {
  const list = $("stem-previews");
  list.replaceChildren(el("li", { className: "hint", textContent: "Rendering…" }));
  try {
    const req = renderRequest();
    const data = await api("/api/render", req);
    state.stems = data.stems;
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

(async () => {
  const cfg = await api("/api/config");
  let out = cfg.outDir;
  try { out = localStorage.getItem("sp404-stems:out") || out; } catch {}
  $("out-dir").value = out;
  await scan(cfg.root);
})();
