// ==========================================================================
// SkillGrid frontend logic
// ==========================================================================

const state = {
  tree: null,
  skills: [],        // flat list from /api/skills
  activeFolder: "",   // "" = root / all
  currentView: "browse",
  editorPath: null,
  editorEditing: false,
  network: null,      // vis-network instance
};

const el = (id) => document.getElementById(id);

// -- boot sequence ----------------------------------------------------------

async function boot() {
  const bootText = el("boot-text");
  const lines = [
    "> initializing skillgrid...",
    "> mounting filesystem...",
    "> indexing skill definitions...",
    "> ready.",
  ];
  let i = 0;
  const interval = setInterval(() => {
    if (i < lines.length) {
      bootText.textContent += (i > 0 ? "\n" : "") + lines[i];
      i++;
    } else {
      clearInterval(interval);
      setTimeout(async () => {
        el("boot-scan").classList.add("hidden");
        el("app").classList.remove("hidden");
        await init();
      }, 180);
    }
  }, 90);
}

// -- init ---------------------------------------------------------------

async function init() {
  const rootInfo = await fetchJSON("/api/root");
  el("root-path").textContent = rootInfo.root;

  marked.setOptions({ breaks: false, gfm: true });

  await loadTree();
  await loadSkills();
  renderBreadcrumb();
  renderCards();

  wireTopbar();
  wireEditor();
  wireConfirm();
}

async function fetchJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.description || res.statusText);
  }
  return res.json();
}

// -- tree sidebar ---------------------------------------------------------

async function loadTree() {
  state.tree = await fetchJSON("/api/tree");
  renderTree();
}

function renderTree() {
  const root = el("tree-root");
  root.innerHTML = "";
  if (!state.tree) return;

  // Render root's children directly (skip wrapping root folder itself)
  const container = buildTreeChildren(state.tree.children || [], true);
  root.appendChild(container);

  // "All skills" row at top
  const allRow = document.createElement("div");
  allRow.className = "tree-row active";
  allRow.dataset.path = "";
  allRow.innerHTML = `<span class="tree-caret"></span><span class="tree-icon">◆</span><span class="tree-name">all skills</span><span class="tree-count">${state.skills.length || ""}</span>`;
  allRow.addEventListener("click", () => selectFolder(""));
  root.insertBefore(allRow, root.firstChild);
}

function buildTreeChildren(children, topLevel) {
  const wrap = document.createElement("div");
  wrap.className = topLevel ? "" : "tree-children";

  children.forEach((node) => {
    if (node.type === "dir") {
      const dirEl = document.createElement("div");
      dirEl.className = "tree-dir";

      const row = document.createElement("div");
      row.className = "tree-row";
      row.dataset.path = node.path;
      row.innerHTML = `
        <span class="tree-caret">▸</span>
        <span class="tree-icon">▣</span>
        <span class="tree-name">${escapeHtml(node.name)}</span>
        <span class="tree-count">${node.count}</span>
      `;

      const childWrap = buildTreeChildren(node.children, false);

      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = childWrap.classList.toggle("open");
        row.querySelector(".tree-caret").classList.toggle("open", isOpen);
        selectFolder(node.path, row);
      });

      dirEl.appendChild(row);
      dirEl.appendChild(childWrap);
      wrap.appendChild(dirEl);
    } else {
      const fileEl = document.createElement("div");
      fileEl.className = "tree-row tree-file";
      fileEl.dataset.path = node.path;
      fileEl.innerHTML = `
        <span class="tree-caret"></span>
        <span class="tree-icon">▪</span>
        <span class="tree-name">${escapeHtml(node.skill_name || node.name)}</span>
      `;
      fileEl.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(node.path);
      });
      wrap.appendChild(fileEl);
    }
  });

  return wrap;
}

function selectFolder(path, rowEl) {
  state.activeFolder = path;
  document.querySelectorAll(".tree-row").forEach((r) => r.classList.remove("active"));
  if (rowEl) rowEl.classList.add("active");
  else {
    const allRow = document.querySelector('.tree-row[data-path=""]');
    if (allRow) allRow.classList.add("active");
  }
  renderBreadcrumb();
  renderCards();
}

// -- flat skills list -------------------------------------------------------

async function loadSkills() {
  state.skills = await fetchJSON("/api/skills");
  el("skill-count").textContent = `${state.skills.length} SKILLS`;
}

function visibleSkills() {
  const q = el("search").value.trim().toLowerCase();
  let list = state.skills;

  if (state.activeFolder) {
    list = list.filter(
      (s) => s.folder === state.activeFolder || s.folder.startsWith(state.activeFolder + "/")
    );
  }

  if (q) {
    list = list.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.folder.toLowerCase().includes(q)
    );
  }

  return list;
}

function renderBreadcrumb() {
  const bc = el("breadcrumb");
  if (!state.activeFolder) {
    bc.innerHTML = `<span class="seg">~/all-skills</span>`;
    return;
  }
  const parts = state.activeFolder.split("/");
  bc.innerHTML =
    `<span class="seg">~</span>` +
    parts.map((p) => `<span class="sep">/</span><span class="seg">${escapeHtml(p)}</span>`).join("");
}

// -- cards ------------------------------------------------------------------

function renderCards() {
  const scroll = el("card-scroll");
  const list = visibleSkills();
  scroll.innerHTML = "";

  if (list.length === 0) {
    scroll.innerHTML = `
      <div class="empty-state">
        <span class="big">∅</span>
        no skills found here.
      </div>`;
    return;
  }

  list.forEach((skill) => {
    const card = document.createElement("div");
    card.className = "skill-card";
    card.dataset.path = skill.path;

    card.innerHTML = `
      <div class="card-head">
        <span class="card-expand">▸</span>
        <div class="card-main">
          <div class="card-title-row">
            <span class="card-name">${escapeHtml(skill.name)}</span>
            ${skill.folder ? `<span class="card-folder">${escapeHtml(skill.folder)}</span>` : ""}
            ${skill.related.length ? `<span class="card-related-badge">⇄ ${skill.related.length} related</span>` : ""}
          </div>
          <div class="card-desc">${escapeHtml(skill.description || "(no description)")}</div>
        </div>
        <button class="card-open-btn">OPEN ↗</button>
      </div>
      <div class="card-body">
        <div class="md-render md-fade"></div>
      </div>
    `;

    const head = card.querySelector(".card-head");
    const body = card.querySelector(".card-body");
    const mdRender = card.querySelector(".md-render");
    let loaded = false;

    head.addEventListener("click", async (e) => {
      if (e.target.classList.contains("card-open-btn")) return;
      const expanding = !card.classList.contains("expanded");
      card.classList.toggle("expanded");
      if (expanding && !loaded) {
        loaded = true;
        const full = await fetchJSON(`/api/skill?path=${encodeURIComponent(skill.path)}`);
        mdRender.innerHTML = marked.parse(full.body || "");
      }
    });

    card.querySelector(".card-open-btn").addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor(skill.path);
    });

    scroll.appendChild(card);
  });
}

// -- editor modal -------------------------------------------------------

function wireEditor() {
  el("editor-close").addEventListener("click", closeEditor);
  el("editor-overlay").addEventListener("click", (e) => {
    if (e.target.id === "editor-overlay") closeEditor();
  });
  el("editor-toggle-edit").addEventListener("click", toggleEditMode);
  el("editor-save").addEventListener("click", saveEditor);
  el("editor-delete").addEventListener("click", () => {
    showConfirm(state.editorPath);
  });
}

async function openEditor(path) {
  state.editorPath = path;
  state.editorEditing = false;

  el("editor-path").textContent = path;
  el("editor-preview").innerHTML = `<div class="empty-state">loading...</div>`;
  el("editor-preview").classList.remove("hidden");
  el("editor-textarea").classList.add("hidden");
  el("editor-toggle-edit").textContent = "[ EDIT ]";
  el("editor-save").classList.add("hidden");

  el("editor-overlay").classList.remove("hidden");

  const data = await fetchJSON(`/api/skill?path=${encodeURIComponent(path)}`);
  el("editor-preview").innerHTML = marked.parse(data.raw || "");
  el("editor-textarea").value = data.raw || "";
}

function closeEditor() {
  el("editor-overlay").classList.add("hidden");
  state.editorPath = null;
}

function toggleEditMode() {
  state.editorEditing = !state.editorEditing;
  if (state.editorEditing) {
    el("editor-preview").classList.add("hidden");
    el("editor-textarea").classList.remove("hidden");
    el("editor-toggle-edit").textContent = "[ PREVIEW ]";
    el("editor-save").classList.remove("hidden");
  } else {
    el("editor-preview").innerHTML = marked.parse(el("editor-textarea").value || "");
    el("editor-preview").classList.remove("hidden");
    el("editor-textarea").classList.add("hidden");
    el("editor-toggle-edit").textContent = "[ EDIT ]";
  }
}

async function saveEditor() {
  const raw = el("editor-textarea").value;
  const saveBtn = el("editor-save");
  saveBtn.textContent = "[ SAVING... ]";
  try {
    await fetchJSON("/api/skill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: state.editorPath, raw }),
    });
    saveBtn.textContent = "[ SAVED ✓ ]";
    await loadSkills();
    await loadTree();
    renderCards();
    setTimeout(() => (saveBtn.textContent = "[ SAVE ]"), 1200);
  } catch (err) {
    saveBtn.textContent = "[ ERROR ]";
    console.error(err);
  }
}

// -- delete confirm -------------------------------------------------------

function wireConfirm() {
  el("confirm-cancel").addEventListener("click", hideConfirm);
  el("confirm-overlay").addEventListener("click", (e) => {
    if (e.target.id === "confirm-overlay") hideConfirm();
  });
  el("confirm-yes").addEventListener("click", doDelete);
}

function showConfirm(path) {
  el("confirm-path").textContent = path;
  el("confirm-overlay").classList.remove("hidden");
}
function hideConfirm() {
  el("confirm-overlay").classList.add("hidden");
}

async function doDelete() {
  const path = state.editorPath;
  await fetchJSON(`/api/skill?path=${encodeURIComponent(path)}`, { method: "DELETE" });
  hideConfirm();
  closeEditor();
  await loadSkills();
  await loadTree();
  renderCards();
}

// -- topbar / search / view switch -----------------------------------------

function wireTopbar() {
  el("search").addEventListener("input", renderCards);

  document.querySelectorAll(".view-btn").forEach((btn) => {
    btn.addEventListener("click", () => switchView(btn.dataset.view));
  });
}

function switchView(view) {
  state.currentView = view;
  document.querySelectorAll(".view-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  el("view-browse-panel").classList.toggle("active", view === "browse");
  el("view-graph-panel").classList.toggle("active", view === "graph");
  if (view === "graph") loadGraph();
}

// -- graph view ---------------------------------------------------------

async function loadGraph() {
  const data = await fetchJSON("/api/graph");

  const nodes = new vis.DataSet(
    data.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      title: n.title,
      shape: "dot",
      size: 14,
      font: { color: "#c9e8d8", face: "JetBrains Mono", size: 13 },
      color: {
        background: "#0e5c3a",
        border: "#39ff8f",
        highlight: { background: "#1fa860", border: "#39ff8f" },
        hover: { background: "#1fa860", border: "#39ff8f" },
      },
    }))
  );

  const edges = new vis.DataSet(
    data.edges.map((e) => ({
      from: e.from,
      to: e.to,
      color: { color: "#1f4538", highlight: "#39ff8f", hover: "#39ff8f" },
      width: 1.5,
      smooth: { type: "continuous" },
    }))
  );

  const container = el("graph-canvas");
  const options = {
    nodes: { borderWidth: 2, shadow: { enabled: true, color: "rgba(57,255,143,0.3)", size: 10 } },
    edges: { shadow: false },
    physics: {
      solver: "forceAtlas2Based",
      forceAtlas2Based: { gravitationalConstant: -60, springLength: 110, springConstant: 0.06 },
      stabilization: { iterations: 150 },
    },
    interaction: { hover: true, tooltipDelay: 120 },
  };

  if (state.network) state.network.destroy();
  state.network = new vis.Network(container, { nodes, edges }, options);

  state.network.on("click", (params) => {
    if (params.nodes.length > 0) {
      openEditor(params.nodes[0]);
    }
  });
}

// -- utils --------------------------------------------------------------

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str == null ? "" : String(str);
  return d.innerHTML;
}

boot();
