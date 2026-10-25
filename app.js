import { createClient } from "./vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { choosePlacements } from "./labels.js";

// UI gate only. Row changes are enforced by RLS on the JWT email.
const ADMIN_EMAIL = "hello@samquinn.com.au";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Implicit flow matches the default magic-link email template.
    // The return URL must not include a hash: the session tokens use it.
    flowType: "implicit",
  },
});

const $ = (id) => document.getElementById(id);

const state = {
  modes: [],
  maps: [],
  bySlug: new Map(),
  callouts: [],
  seen: new Set(),
  filter: "all",
  query: "",
  map: null,
  selectedId: null,
  hotId: null,
  drawings: [],
  drawSeen: new Set(),
  tool: "marker",
  drawColor: "#ff3b30",
  drawDraft: null,
  selectedDrawingId: null,
  hotDrawingId: null,
  undo: [],
  draft: null,
  editingId: null,
  confirmDeleteId: null,
  legendOpen: false,
  session: null,
  toldNotAdmin: false,
  booted: false,
  userAdjusted: false,
  view: { x: 0, y: 0, scale: 1, min: 0.2, max: 8, fit: 1 },
};

const pointers = new Map();
let drag = null;
let pinch = null;
let suppressClick = false;
let suppressToken = 0;

function markSuppressed() {
  suppressClick = true;
  const token = ++suppressToken;
  window.setTimeout(() => {
    if (token === suppressToken) suppressClick = false;
  }, 400);
}
let pinDrag = null;
let pointDrag = null;
let channel = null;
let channelToken = 0;
let liveFailures = 0;
let countNodes = new Map();

const board = $("board");
const viewer = $("viewer");
const viewport = $("viewport");
const world = $("world");
const mapImage = $("map-image");
const pinsEl = $("pins");
const drawingsEl = $("drawings");
const form = $("callout-form");
const adminDialog = $("admin-dialog");

function cleanText(value, max) {
  const text = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > max) return null;
  return text;
}

function cleanEmail(value) {
  const text = String(value || "").trim();
  if (!text || text.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return null;
  return text;
}

function forgetLegacyKeys() {
  try {
    localStorage.removeItem("mw4-callouts-gamertag");
    localStorage.removeItem("mw4-callouts-voter-id");
  } catch {
    // Storage can be blocked. Nothing else reads these keys.
  }
}

function sessionEmail(session) {
  return String(session?.user?.email || "").trim().toLowerCase();
}

function isAdmin() {
  return sessionEmail(state.session) === ADMIN_EMAIL;
}

// Local screenshot aid. The flag does nothing on the deployed host, and it never writes.
function previewAdmin() {
  const host = location.hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  if (!local) return false;
  return new URLSearchParams(location.search).get("preview-admin") === "1";
}

function editingTools() {
  return isAdmin() || previewAdmin();
}

function canWrite() {
  return isAdmin();
}

function announce(message) {
  $("announce").textContent = message;
}

function showBanner(message) {
  const banner = $("banner");
  banner.hidden = !message;
  banner.textContent = message || "";
}

function updateHint() {
  if (!editingTools()) {
    $("hint").textContent = "Scroll or pinch to zoom. Drag to pan.";
    return;
  }
  if (state.tool === "line" || state.tool === "arrow") {
    $("hint").textContent = "Click points. Double-click or Finish to end. Drag empty map to pan.";
    return;
  }
  if (state.tool === "zone") {
    $("hint").textContent = "Click zone points. Click the first point or Finish to close.";
    return;
  }
  $("hint").textContent = "Drag a pin to move it. Click empty map to name a spot. Drag empty map to pan.";
}

function paintAdminChrome() {
  const signedIn = Boolean(sessionEmail(state.session));
  document.body.classList.toggle("is-admin", isAdmin());
  document.body.classList.toggle("is-editor", editingTools());
  for (const id of ["admin-open", "viewer-admin"]) {
    const button = $(id);
    button.textContent = signedIn ? "Sign out" : "Admin";
    button.setAttribute("aria-label", signedIn ? "Sign out" : "Admin sign in");
  }
  updateHint();
  paintDrawTools();
  if (!editingTools() && !form.hidden) closeDraft();
}

function applySession(session) {
  state.session = session || null;
  const email = sessionEmail(state.session);
  paintAdminChrome();
  if (state.map) renderMarkers();
  if (!email) {
    state.toldNotAdmin = false;
    return;
  }
  if (email !== ADMIN_EMAIL) {
    if (!state.toldNotAdmin) {
      state.toldNotAdmin = true;
      showAdminNotice("This account isn’t the admin.");
    }
    return;
  }
  state.toldNotAdmin = false;
  if (adminDialog.open) adminDialog.close();
}

function showAdminNotice(message) {
  $("admin-title").textContent = "Admin";
  $("admin-copy").hidden = true;
  $("admin-email-field").hidden = true;
  $("admin-send").hidden = true;
  $("admin-message").hidden = false;
  $("admin-message").textContent = message;
  $("admin-error").textContent = "";
  $("admin-signout").hidden = false;
  if (!adminDialog.open) adminDialog.showModal();
}

function openAdminDialog() {
  $("admin-title").textContent = "Admin";
  $("admin-copy").hidden = false;
  $("admin-copy").textContent = "Email yourself a sign-in link. Everyone else can look around without an account.";
  $("admin-email-field").hidden = false;
  $("admin-send").hidden = false;
  $("admin-send").disabled = false;
  $("admin-message").hidden = true;
  $("admin-message").textContent = "";
  $("admin-error").textContent = "";
  $("admin-signout").hidden = true;
  $("admin-email").value = "";
  if (!adminDialog.open) adminDialog.showModal();
  $("admin-email").focus();
}

function setLive(status) {
  const node = $("live-status");
  const text = $("live-text");
  node.classList.remove("is-live", "is-off");
  if (status === "SUBSCRIBED") {
    node.classList.add("is-live");
    text.textContent = "Live";
    liveFailures = 0;
    return;
  }
  if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
    node.classList.add("is-off");
    text.textContent = "Offline";
    return;
  }
  text.textContent = "Connecting";
}

function normalize(row) {
  if (!row || !row.id) return null;
  const x = Number(row.x);
  const y = Number(row.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const name = cleanText(row.name, 40);
  if (!name || !row.map_slug) return null;
  return {
    id: String(row.id),
    map_slug: String(row.map_slug),
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    name,
    created_at: String(row.created_at || ""),
  };
}

function remember(row) {
  if (!row || state.seen.has(row.id)) return false;
  state.seen.add(row.id);
  state.callouts.push(row);
  return true;
}

function applyUpdate(row) {
  if (!row) return "skip";
  const index = state.callouts.findIndex((item) => item.id === row.id);
  if (index === -1) {
    remember(row);
    return "added";
  }
  const prev = state.callouts[index];
  const same = prev.name === row.name && prev.x === row.x && prev.y === row.y && prev.map_slug === row.map_slug;
  state.callouts[index] = row;
  return same ? "same" : "changed";
}

function forget(id) {
  if (!state.seen.has(id)) return false;
  state.seen.delete(id);
  state.callouts = state.callouts.filter((row) => row.id !== id);
  if (state.selectedId === id) state.selectedId = null;
  if (state.hotId === id) state.hotId = null;
  if (state.confirmDeleteId === id) state.confirmDeleteId = null;
  if (state.editingId === id) closeDraft({ render: false });
  return true;
}

function callsFor(slug) {
  return state.callouts
    .filter((row) => row.map_slug === slug)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
}

function countLabel(count) {
  if (!count) return "No calls";
  return count === 1 ? "1 call" : `${count} calls`;
}

function renderFilters() {
  const wrap = $("filters");
  wrap.replaceChildren();
  const modes = [{ id: "all", label: "All" }, ...state.modes];
  for (const mode of modes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chip";
    button.textContent = mode.label;
    button.setAttribute("aria-pressed", String(state.filter === mode.id));
    button.addEventListener("click", () => {
      state.filter = mode.id;
      renderFilters();
      renderBoard();
    });
    wrap.appendChild(button);
  }
}

function renderBoard() {
  const query = state.query.trim().toLowerCase();
  board.replaceChildren();
  countNodes = new Map();
  let shown = 0;

  for (const mode of state.modes) {
    if (state.filter !== "all" && state.filter !== mode.id) continue;
    const maps = state.maps.filter((map) => {
      if (map.mode !== mode.id) return false;
      if (!query) return true;
      return map.name.toLowerCase().includes(query) || map.slug.includes(query);
    });
    if (!maps.length) continue;
    shown += maps.length;

    const section = document.createElement("section");
    section.className = "mode-block";
    const heading = document.createElement("h2");
    heading.textContent = mode.label;
    const grid = document.createElement("div");
    grid.className = "grid";

    for (const map of maps) {
      const link = document.createElement("a");
      link.className = "card";
      link.href = `#${map.slug}`;
      link.dataset.slug = map.slug;

      const media = document.createElement("span");
      media.className = "card-media";
      const image = document.createElement("img");
      image.src = map.thumb;
      image.alt = "";
      image.loading = "lazy";
      const badge = document.createElement("span");
      badge.className = `badge${map.imageKind === "screenshot" ? " badge-screenshot" : ""}`;
      badge.textContent = map.badge;
      media.append(image, badge);

      const body = document.createElement("span");
      body.className = "card-body";
      const name = document.createElement("span");
      name.className = "card-name";
      name.textContent = map.name;
      const meta = document.createElement("span");
      meta.className = "card-meta";
      const count = document.createElement("span");
      count.dataset.countFor = map.slug;
      const n = callsFor(map.slug).length;
      count.textContent = countLabel(n);
      countNodes.set(map.slug, count);
      meta.append(`${map.players} · `, count);
      body.append(name, meta);
      link.append(media, body);
      link.addEventListener("pointerenter", () => {
        const preload = new Image();
        preload.src = map.image;
      });
      grid.appendChild(link);
    }

    section.append(heading, grid);
    board.appendChild(section);
  }

  if (!shown) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No maps match that.";
    board.appendChild(empty);
  }
}

function renderCounts() {
  for (const [slug, node] of countNodes) {
    node.textContent = countLabel(callsFor(slug).length);
  }
  const n = state.map ? callsFor(state.map.slug).length : 0;
  $("legend-toggle").textContent = n === 1 ? "Legend · 1" : `Legend · ${n}`;
  $("legend-title").textContent = n === 1 ? "1 callout" : `${n} callouts`;
  renderLegend();
}

function renderLegend() {
  const list = $("legend-list");
  list.replaceChildren();
  if (!state.map) return;
  const rows = callsFor(state.map.slug);
  rows.forEach((row, index) => {
    const item = document.createElement("div");
    item.className = "legend-item";
    item.dataset.id = row.id;
    if (row.id === state.selectedId || row.id === state.hotId) item.classList.add("is-hot");
    if (row.id === state.selectedId) item.setAttribute("aria-current", "true");

    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "legend-jump";
    const mark = document.createElement("span");
    mark.className = "legend-mark";
    mark.textContent = String(index + 1);
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = row.name;
    jump.append(mark, name);
    jump.addEventListener("click", () => focusCallout(row.id, { sticky: true, reveal: true }));
    jump.addEventListener("focus", () => focusCallout(row.id, { sticky: false, reveal: true }));
    item.addEventListener("mouseenter", () => focusCallout(row.id, { sticky: false, reveal: true }));
    item.addEventListener("mouseleave", () => {
      if (state.hotId === row.id && state.selectedId !== row.id) {
        state.hotId = null;
        paintHot();
      }
    });
    item.appendChild(jump);

    if (editingTools()) {
      const actions = document.createElement("div");
      actions.className = "legend-actions";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "legend-rename";
      rename.textContent = "Rename";
      rename.addEventListener("click", () => openRename(row.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "legend-delete";
      const confirming = state.confirmDeleteId === row.id;
      remove.textContent = confirming ? "Confirm" : "Delete";
      if (confirming) remove.classList.add("is-confirm");
      remove.addEventListener("click", () => deleteCallout(row.id));
      actions.append(rename, remove);
      item.appendChild(actions);
    }
    list.appendChild(item);
  });
  const zones = drawingsFor(state.map.slug).filter((row) => row.kind === "zone");
  if (!rows.length && !zones.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No callouts on this map yet.";
    list.appendChild(empty);
    return;
  }
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No callouts on this map yet.";
    list.appendChild(empty);
  }
  if (!zones.length) return;
  const heading = document.createElement("h4");
  heading.className = "legend-sub";
  heading.textContent = "Zones";
  list.appendChild(heading);
  for (const zone of zones) {
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "legend-jump legend-item";
    jump.dataset.id = zone.id;
    if (zone.id === state.selectedDrawingId || zone.id === state.hotDrawingId) jump.classList.add("is-hot");
    const swatch = document.createElement("span");
    swatch.className = "legend-swatch";
    swatch.style.background = zone.color;
    const name = document.createElement("span");
    name.className = "legend-name";
    name.textContent = zone.label || "Zone";
    jump.append(swatch, name);
    jump.addEventListener("click", () => focusZone(zone.id, true));
    jump.addEventListener("mouseenter", () => focusZone(zone.id, true));
    jump.addEventListener("mouseleave", () => {
      if (state.hotDrawingId === zone.id) {
        state.hotDrawingId = null;
        renderDrawings();
        jump.classList.remove("is-hot");
      }
    });
    list.appendChild(jump);
  }
}

function renderMarkers(freshId) {
  pinsEl.replaceChildren();
  if (!state.map) return;
  const rows = callsFor(state.map.slug);
  const places = choosePlacements(rows);
  rows.forEach((row, index) => {
    const marker = document.createElement("div");
    marker.className = "marker";
    if (row.id === freshId) marker.classList.add("is-new");
    if (row.id === state.selectedId || row.id === state.hotId) marker.classList.add("is-active");
    marker.dataset.id = row.id;
    marker.dataset.place = places.get(row.id) || "top";
    marker.style.left = `${row.x * 100}%`;
    marker.style.top = `${row.y * 100}%`;
    marker.style.zIndex = row.id === state.selectedId || row.id === state.hotId ? "40" : "2";

    const ui = document.createElement("span");
    ui.className = "marker-ui";
    const dot = document.createElement("span");
    dot.className = "dot";
    const num = document.createElement("span");
    num.className = "dot-num";
    num.textContent = String(index + 1);
    dot.appendChild(num);
    const tag = document.createElement("span");
    tag.className = "tag";
    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = row.name;
    tag.appendChild(name);
    if (editingTools()) {
      const actions = document.createElement("span");
      actions.className = "pin-actions";
      const rename = document.createElement("button");
      rename.type = "button";
      rename.className = "pin-edit";
      rename.dataset.id = row.id;
      rename.textContent = "Rename";
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pin-delete";
      remove.dataset.id = row.id;
      const confirming = state.confirmDeleteId === row.id;
      remove.textContent = confirming ? "Confirm" : "Delete";
      if (confirming) remove.classList.add("is-confirm");
      actions.append(rename, remove);
      tag.appendChild(actions);
    }
    ui.append(dot, tag);
    marker.appendChild(ui);
    pinsEl.appendChild(marker);
  });
  renderDraftMarker();
  renderDrawings();
  renderLegend();
}

function renderDraftMarker() {
  const existing = pinsEl.querySelector(".is-draft");
  if (existing) existing.remove();
  if (!state.draft) return;
  const marker = document.createElement("div");
  marker.className = "marker is-draft";
  marker.style.left = `${state.draft.x * 100}%`;
  marker.style.top = `${state.draft.y * 100}%`;
  const ui = document.createElement("span");
  ui.className = "marker-ui";
  const dot = document.createElement("span");
  dot.className = "dot";
  ui.appendChild(dot);
  marker.appendChild(ui);
  pinsEl.appendChild(marker);
}

function paintHot() {
  for (const marker of pinsEl.querySelectorAll(".marker[data-id]")) {
    const on = marker.dataset.id === state.selectedId || marker.dataset.id === state.hotId;
    marker.classList.toggle("is-active", on);
    marker.style.zIndex = on ? "40" : "2";
  }
  for (const item of document.querySelectorAll(".legend-item")) {
    const on = item.dataset.id === state.selectedId || item.dataset.id === state.hotId;
    item.classList.toggle("is-hot", on);
    if (item.dataset.id === state.selectedId) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
}

function focusCallout(id, { sticky, reveal }) {
  if (sticky) state.selectedId = id;
  state.hotId = id;
  paintHot();
  const row = state.callouts.find((item) => item.id === id);
  if (reveal && row) revealPin(row);
  if (sticky) {
    document.querySelector(`.legend-item[data-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "nearest" });
  }
}

function applyView() {
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.scale})`;
  world.style.setProperty("--inv", String(1 / state.view.scale));
  positionDraftForm();
}

function imageSize() {
  return {
    w: mapImage.naturalWidth || state.map?.width || 1,
    h: mapImage.naturalHeight || state.map?.height || 1,
  };
}

function clampPan() {
  const { w, h } = imageSize();
  const width = w * state.view.scale;
  const height = h * state.view.scale;
  const margin = 48;
  const maxX = viewport.clientWidth - margin;
  const maxY = viewport.clientHeight - margin;
  state.view.x = Math.min(maxX, Math.max(margin - width, state.view.x));
  state.view.y = Math.min(maxY, Math.max(margin - height, state.view.y));
}

function fitMap() {
  const { w, h } = imageSize();
  if (!w || !h || !viewport.clientWidth) return;
  world.style.width = `${w}px`;
  world.style.height = `${h}px`;
  const fit = Math.min(viewport.clientWidth / w, viewport.clientHeight / h) * 0.94;
  state.view.fit = fit;
  state.view.min = fit * 0.8;
  state.view.max = Math.max(8, fit * 8);
  state.view.scale = fit;
  state.view.x = (viewport.clientWidth - w * fit) / 2;
  state.view.y = (viewport.clientHeight - h * fit) / 2;
  state.userAdjusted = false;
  applyView();
}

function zoomAt(cx, cy, next) {
  const { w, h } = imageSize();
  const scale = Math.min(state.view.max, Math.max(state.view.min, next));
  const wx = (cx - state.view.x) / state.view.scale;
  const wy = (cy - state.view.y) / state.view.scale;
  state.view.scale = scale;
  state.view.x = cx - wx * scale;
  state.view.y = cy - wy * scale;
  state.userAdjusted = true;
  if (w && h) clampPan();
  applyView();
}

function pinClientPoint(row) {
  const { w, h } = imageSize();
  const rect = viewport.getBoundingClientRect();
  return {
    x: rect.left + state.view.x + row.x * w * state.view.scale,
    y: rect.top + state.view.y + row.y * h * state.view.scale,
  };
}

function visibleMapBounds() {
  const rect = viewport.getBoundingClientRect();
  let bottom = rect.bottom;
  const legend = $("legend");
  if (state.legendOpen && window.matchMedia("(max-width: 720px)").matches && legend) {
    bottom = Math.min(bottom, legend.getBoundingClientRect().top);
  }
  return { left: rect.left, top: rect.top, right: rect.right, bottom };
}

function pinInView(row) {
  const point = pinClientPoint(row);
  const bounds = visibleMapBounds();
  const pad = 56;
  return point.x >= bounds.left + pad
    && point.x <= bounds.right - pad
    && point.y >= bounds.top + pad
    && point.y <= bounds.bottom - pad;
}

function revealPin(row) {
  if (pinInView(row)) return;
  const { w, h } = imageSize();
  const bounds = visibleMapBounds();
  const rect = viewport.getBoundingClientRect();
  const targetX = (bounds.left + bounds.right) / 2 - rect.left;
  const targetY = (bounds.top + bounds.bottom) / 2 - rect.top;
  state.view.x = targetX - row.x * w * state.view.scale;
  state.view.y = targetY - row.y * h * state.view.scale;
  state.userAdjusted = true;
  clampPan();
  applyView();
}

function setLegendOpen(open) {
  state.legendOpen = open;
  viewer.classList.toggle("is-legend-open", open);
  $("legend-toggle").setAttribute("aria-expanded", String(open));
}

function showMap(slug) {
  const map = state.bySlug.get(slug);
  if (!map) return;
  state.map = map;
  state.selectedId = null;
  state.hotId = null;
  state.confirmDeleteId = null;
  closeDraft({ render: false });
  setLegendOpen(false);
  viewer.hidden = false;
  document.body.classList.add("viewer-open");
  $("viewer-name").textContent = map.name;
  const bits = [map.players, map.badge];
  if (map.note) bits.push(map.note);
  $("viewer-sub").textContent = bits.join(" · ");
  mapImage.alt = `${map.name} ${map.imageKind === "screenshot" ? "screenshot" : "overhead"}`;
  $("map-loading").hidden = false;
  if (mapImage.getAttribute("src") !== map.image) {
    mapImage.src = map.image;
  } else if (mapImage.complete && mapImage.naturalWidth) {
    $("map-loading").hidden = true;
    fitMap();
  }
  renderMarkers();
  renderCounts();
  $("close-viewer").focus();
}

function closeViewer() {
  closeDraft({ render: false });
  viewer.hidden = true;
  document.body.classList.remove("viewer-open");
  state.map = null;
  state.selectedId = null;
  state.hotId = null;
  setLegendOpen(false);
}

function route() {
  const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (slug && state.bySlug.has(slug)) showMap(slug);
  else closeViewer();
}

function pointFromClient(clientX, clientY) {
  const rect = mapImage.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || y < 0 || x > 1 || y > 1) return null;
  return {
    x: Math.round(x * 1e6) / 1e6,
    y: Math.round(y * 1e6) / 1e6,
  };
}

function openDraft(clientX, clientY) {
  if (!editingTools()) return;
  const point = pointFromClient(clientX, clientY);
  if (!point || !state.map) return;
  state.editingId = null;
  state.draft = point;
  $("draft-title").textContent = "Name this spot";
  $("draft-save").textContent = "Drop pin";
  $("draft-delete").hidden = true;
  $("draft-delete").dataset.confirm = "";
  $("draft-delete").textContent = "Delete";
  $("callout-input").value = "";
  $("draft-error").textContent = "";
  $("draft-save").disabled = false;
  form.hidden = false;
  renderDraftMarker();
  positionDraftForm();
  setLegendOpen(false);
  $("callout-input").focus();
}

function openRename(id) {
  if (!editingTools()) return;
  const row = state.callouts.find((item) => item.id === id);
  if (!row) return;
  state.draft = null;
  state.editingId = id;
  state.confirmDeleteId = null;
  focusCallout(id, { sticky: true, reveal: true });
  $("draft-title").textContent = "Rename callout";
  $("draft-save").textContent = "Save";
  $("draft-delete").hidden = false;
  $("draft-delete").dataset.confirm = "";
  $("draft-delete").textContent = "Delete";
  $("callout-input").value = row.name;
  $("draft-error").textContent = "";
  $("draft-save").disabled = false;
  form.hidden = false;
  renderDraftMarker();
  positionDraftForm();
  setLegendOpen(false);
  $("callout-input").focus();
  $("callout-input").select();
}

function closeDraft(options = {}) {
  state.draft = null;
  state.editingId = null;
  form.hidden = true;
  $("draft-error").textContent = "";
  $("draft-delete").hidden = true;
  $("draft-delete").dataset.confirm = "";
  if (options.render !== false) renderDraftMarker();
}

function positionDraftForm() {
  if (form.hidden) return;
  const marker = state.draft
    ? pinsEl.querySelector(".is-draft")
    : pinsEl.querySelector(`.marker[data-id="${CSS.escape(state.editingId || "")}"]`);
  if (!marker) return;
  if (window.matchMedia("(max-width: 720px)").matches) return;
  const rect = marker.getBoundingClientRect();
  const width = form.offsetWidth || 280;
  const height = form.offsetHeight || 160;
  let left = rect.right + 12;
  let top = rect.top - 10;
  if (left + width > window.innerWidth - 8) left = rect.left - width - 12;
  if (top + height > window.innerHeight - 8) top = window.innerHeight - height - 8;
  form.style.left = `${Math.max(8, left)}px`;
  form.style.top = `${Math.max(8, top)}px`;
}

function permissionDenied(error) {
  const code = String(error?.code || "");
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return code === "42501" || /row-level security|permission denied|jwt/i.test(message);
}

function friendlyError(error) {
  const message = error?.message || "Could not save that callout.";
  if (permissionDenied(error)) return "Only the admin can change callouts.";
  if (message.includes("name_check")) return "Use 1–40 characters for the callout.";
  if (message.includes("x_check") || message.includes("y_check")) return "That spot is outside the map.";
  if (message.includes("map_slug")) return "That map is not valid.";
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) return "Could not reach the server.";
  return message;
}

async function saveDraft(event) {
  event.preventDefault();
  if (!editingTools() || !state.map) return;
  if (!canWrite()) {
    $("draft-error").textContent = "Preview only. Sign in as admin to save.";
    return;
  }
  const name = cleanText($("callout-input").value, 40);
  if (!name) {
    $("draft-error").textContent = "Name the spot. Up to 40 characters.";
    return;
  }
  if (state.editingId) {
    await renameCallout(state.editingId, name);
    return;
  }
  if (!state.draft) return;
  $("draft-save").disabled = true;
  $("draft-error").textContent = "";
  const payload = {
    map_slug: state.map.slug,
    x: state.draft.x,
    y: state.draft.y,
    name,
  };
  const { data, error } = await supabase
    .from("callouts")
    .insert(payload)
    .select("id,map_slug,x,y,name,created_at")
    .single();
  $("draft-save").disabled = false;
  if (error) {
    $("draft-error").textContent = friendlyError(error);
    return;
  }
  const row = normalize(data);
  const added = row && remember(row);
  closeDraft();
  renderCounts();
  renderMarkers(added ? row.id : null);
  if (row) announce(row.name);
}

async function renameCallout(id, name) {
  if (!canWrite()) {
    $("draft-error").textContent = "Preview only. Sign in as admin to save.";
    return;
  }
  $("draft-save").disabled = true;
  $("draft-error").textContent = "";
  const { data, error } = await supabase
    .from("callouts")
    .update({ name })
    .eq("id", id)
    .select("id,map_slug,x,y,name,created_at");
  $("draft-save").disabled = false;
  if (error || !data?.length) {
    $("draft-error").textContent = error ? friendlyError(error) : "Only the admin can change callouts.";
    return;
  }
  const row = normalize(data[0]);
  applyUpdate(row);
  closeDraft();
  renderCounts();
  renderMarkers();
  if (row) announce(row.name);
}

async function deleteCallout(id, options = {}) {
  if (!editingTools() || !id) return;
  if (!canWrite()) {
    announce("Preview only. Sign in as admin to save.");
    return;
  }
  const row = state.callouts.find((item) => item.id === id);
  if (!row) return;
  if (!options.immediate && state.confirmDeleteId !== id) {
    state.confirmDeleteId = id;
    renderMarkers();
    return;
  }
  state.confirmDeleteId = null;
  const { data, error } = await supabase.from("callouts").delete().eq("id", id).select("id");
  if (error || !data?.length) {
    announce("Couldn't delete that callout.");
    renderMarkers();
    return;
  }
  forget(id);
  closeDraft({ render: false });
  renderCounts();
  renderMarkers();
  announce(`Deleted ${row.name}.`);
}

const DRAW_COLORS = ["#ff3b30", "#e2b340", "#3d8bfd", "#9dcc6a", "#f4f1e8"];
const SVG_NS = "http://www.w3.org/2000/svg";

function drawingsFor(slug) {
  return state.drawings
    .filter((row) => row.map_slug === slug)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.id.localeCompare(b.id));
}

function normalizeDrawing(row) {
  if (!row?.id || !row.map_slug) return null;
  const kind = String(row.kind || "");
  if (kind !== "line" && kind !== "arrow" && kind !== "zone") return null;
  let points = row.points;
  if (typeof points === "string") {
    try { points = JSON.parse(points); } catch { return null; }
  }
  if (!Array.isArray(points)) return null;
  const clean = [];
  for (const pair of points) {
    if (!Array.isArray(pair) || pair.length < 2) return null;
    const x = Number(pair[0]);
    const y = Number(pair[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    clean.push([
      Math.round(Math.min(1, Math.max(0, x)) * 1e6) / 1e6,
      Math.round(Math.min(1, Math.max(0, y)) * 1e6) / 1e6,
    ]);
  }
  if (kind === "zone" ? clean.length < 3 : clean.length < 2) return null;
  const color = DRAW_COLORS.includes(String(row.color || "").toLowerCase())
    ? String(row.color).toLowerCase()
    : "#ff3b30";
  const label = row.label == null ? null : cleanText(row.label, 40);
  return {
    id: String(row.id),
    map_slug: String(row.map_slug),
    kind,
    points: clean,
    color,
    label,
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function rememberDrawing(row) {
  if (!row || state.drawSeen.has(row.id)) return false;
  state.drawSeen.add(row.id);
  state.drawings.push(row);
  return true;
}

function applyDrawing(row) {
  if (!row) return "skip";
  const index = state.drawings.findIndex((item) => item.id === row.id);
  if (index === -1) {
    rememberDrawing(row);
    return "added";
  }
  const prev = state.drawings[index];
  const same = JSON.stringify(prev.points) === JSON.stringify(row.points)
    && prev.color === row.color
    && prev.label === row.label
    && prev.kind === row.kind;
  state.drawings[index] = row;
  return same ? "same" : "changed";
}

function forgetDrawing(id) {
  if (!state.drawSeen.has(id)) return false;
  state.drawSeen.delete(id);
  state.drawings = state.drawings.filter((row) => row.id !== id);
  if (state.selectedDrawingId === id) state.selectedDrawingId = null;
  if (state.hotDrawingId === id) state.hotDrawingId = null;
  return true;
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const [px, py] of points) {
    x += px;
    y += py;
  }
  return { x: x / points.length, y: y / points.length };
}

function nearPoint(a, b) {
  const { w, h } = imageSize();
  const ax = Array.isArray(a) ? a[0] : a.x;
  const ay = Array.isArray(a) ? a[1] : a.y;
  const bx = Array.isArray(b) ? b[0] : b.x;
  const by = Array.isArray(b) ? b[1] : b.y;
  return Math.hypot((ax - bx) * w * state.view.scale, (ay - by) * h * state.view.scale) < 18;
}

function pushUndo(action) {
  state.undo.push(action);
  if (state.undo.length > 20) state.undo.shift();
  paintDrawTools();
}

function paintDrawTools() {
  const tools = $("draw-tools");
  tools.hidden = !editingTools();
  $("draw-preview").hidden = !previewAdmin() || isAdmin();
  for (const button of tools.querySelectorAll(".tool-btn")) {
    const on = button.dataset.tool === state.tool;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  }
  for (const button of tools.querySelectorAll(".color-btn")) {
    const on = button.dataset.color === state.drawColor;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", String(on));
  }
  $("draw-label-field").hidden = state.tool !== "zone";
  const drafting = Boolean(state.drawDraft && state.drawDraft.points.length);
  $("draw-finish").hidden = !drafting;
  const selected = state.drawings.find((row) => row.id === state.selectedDrawingId);
  $("draw-delete").hidden = !selected;
  $("draw-delete").textContent = $("draw-delete").dataset.confirm === state.selectedDrawingId ? "Confirm delete" : "Delete";
  $("draw-undo").disabled = state.undo.length === 0;
}

function selectDrawing(id) {
  state.selectedDrawingId = id;
  state.hotDrawingId = id;
  $("draw-delete").dataset.confirm = "";
  renderDrawings();
  paintDrawTools();
}

function focusZone(id, reveal) {
  state.hotDrawingId = id;
  if (editingTools()) state.selectedDrawingId = id;
  renderDrawings();
  paintDrawTools();
  for (const item of document.querySelectorAll(".legend-jump.legend-item")) {
    item.classList.toggle("is-hot", item.dataset.id === id);
  }
  const row = state.drawings.find((item) => item.id === id);
  if (reveal && row) revealPin(centroid(row.points));
}

function svgEl(name, attrs) {
  const node = document.createElementNS(SVG_NS, name);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function renderDrawings() {
  drawingsEl.replaceChildren();
  if (!state.map) return;
  const { w, h } = imageSize();
  drawingsEl.setAttribute("viewBox", `0 0 ${w} ${h}`);
  const defs = svgEl("defs", {});
  drawingsEl.appendChild(defs);
  const rows = drawingsFor(state.map.slug);
  for (const row of rows) appendDrawing(row, w, h, defs);
  if (state.drawDraft && state.drawDraft.points.length) {
    appendDraft(state.drawDraft, w, h);
  }
}

function appendDrawing(row, w, h, defs) {
  const selected = row.id === state.selectedDrawingId || row.id === state.hotDrawingId;
  const pts = row.points.map(([x, y]) => `${x * w},${y * h}`).join(" ");
  if (row.kind === "zone") {
    drawingsEl.appendChild(svgEl("polygon", {
      points: pts,
      fill: row.color,
      "fill-opacity": "0.28",
      stroke: row.color,
      "stroke-width": selected ? "12" : "8",
      class: "drawing-hit",
      "data-id": row.id,
    }));
    if (row.label) {
      const center = centroid(row.points);
      const text = svgEl("text", {
        x: String(center.x * w),
        y: String(center.y * h),
        fill: "#f4f1e8",
        stroke: "#0c0e0a",
        "stroke-width": "6",
        "paint-order": "stroke",
        "text-anchor": "middle",
        "dominant-baseline": "middle",
        "font-size": String(Math.max(22, Math.round(Math.min(w, h) * 0.02))),
        "font-family": "Barlow Condensed, sans-serif",
        "pointer-events": "none",
      });
      text.textContent = row.label;
      drawingsEl.appendChild(text);
    }
  } else {
    drawingsEl.appendChild(svgEl("polyline", {
      points: pts,
      fill: "none",
      stroke: "transparent",
      "stroke-width": "28",
      "stroke-linecap": "round",
      "pointer-events": "stroke",
      class: "drawing-hit",
      "data-id": row.id,
    }));
    const line = svgEl("polyline", {
      points: pts,
      fill: "none",
      stroke: row.color,
      "stroke-width": selected ? "12" : "8",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "pointer-events": "none",
    });
    if (row.kind === "arrow") {
      const markerId = `arrowhead-${row.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
      const marker = svgEl("marker", {
        id: markerId,
        markerWidth: "8",
        markerHeight: "8",
        refX: "6",
        refY: "4",
        orient: "auto",
        markerUnits: "strokeWidth",
      });
      marker.appendChild(svgEl("path", { d: "M0,0 L8,4 L0,8 Z", fill: row.color }));
      defs.appendChild(marker);
      line.setAttribute("marker-end", `url(#${markerId})`);
    }
    drawingsEl.appendChild(line);
  }
  if (selected && editingTools()) {
    row.points.forEach(([x, y], index) => {
      drawingsEl.appendChild(svgEl("circle", {
        cx: String(x * w),
        cy: String(y * h),
        r: "16",
        fill: "#fff6d4",
        stroke: row.color,
        "stroke-width": "4",
        class: "draw-handle",
        "data-id": row.id,
        "data-index": String(index),
      }));
    });
  }
}

function appendDraft(draft, w, h) {
  const pts = draft.points.map((point) => `${point.x * w},${point.y * h}`).join(" ");
  drawingsEl.appendChild(svgEl(draft.kind === "zone" ? "polygon" : "polyline", {
    points: pts,
    fill: draft.kind === "zone" ? state.drawColor : "none",
    "fill-opacity": draft.kind === "zone" ? "0.18" : "0",
    stroke: state.drawColor,
    "stroke-width": "8",
    "stroke-dasharray": "18 12",
    "stroke-linecap": "round",
    "pointer-events": "none",
  }));
}

function addDrawPoint(clientX, clientY) {
  const point = pointFromClient(clientX, clientY);
  if (!point || !state.map || !editingTools()) return;
  if (!state.drawDraft || state.drawDraft.kind !== state.tool) {
    state.drawDraft = { kind: state.tool, points: [] };
  }
  const points = state.drawDraft.points;
  if (state.tool === "zone" && points.length >= 3 && nearPoint(point, points[0])) {
    finishDrawing();
    return;
  }
  points.push(point);
  renderDrawings();
  paintDrawTools();
}

async function finishDrawing() {
  const draft = state.drawDraft;
  if (!draft || !state.map) return;
  const minimum = draft.kind === "zone" ? 3 : 2;
  if (draft.points.length < minimum) {
    announce(draft.kind === "zone" ? "A zone needs at least 3 points." : "Add at least two points.");
    return;
  }
  const points = draft.points.map((point) => [point.x, point.y]);
  const label = draft.kind === "zone" ? cleanText($("draw-label").value, 40) : null;
  state.drawDraft = null;
  paintDrawTools();
  if (!canWrite()) {
    const row = normalizeDrawing({
      id: `preview-${crypto.randomUUID()}`,
      map_slug: state.map.slug,
      kind: draft.kind,
      points,
      color: state.drawColor,
      label,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    if (row) {
      rememberDrawing(row);
      pushUndo({ kind: "add-drawing", id: row.id });
    }
    renderDrawings();
    renderLegend();
    announce("Preview only. This drawing is not saved.");
    return;
  }
  const { data, error } = await supabase
    .from("map_drawings")
    .insert({
      map_slug: state.map.slug,
      kind: draft.kind,
      points,
      color: state.drawColor,
      label,
    })
    .select("id,map_slug,kind,points,color,label,created_at,updated_at")
    .single();
  if (error) {
    announce("Couldn't save that drawing.");
    console.error(error);
    renderDrawings();
    return;
  }
  const row = normalizeDrawing(data);
  if (row && rememberDrawing(row)) pushUndo({ kind: "add-drawing", id: row.id });
  renderDrawings();
  renderLegend();
  if (row) announce(row.label || row.kind);
}

async function deleteSelectedDrawing() {
  const id = state.selectedDrawingId;
  const row = state.drawings.find((item) => item.id === id);
  if (!row || !editingTools()) return;
  const button = $("draw-delete");
  if (button.dataset.confirm !== id) {
    button.dataset.confirm = id;
    paintDrawTools();
    return;
  }
  button.dataset.confirm = "";
  if (id.startsWith("preview-")) {
    pushUndo({ kind: "remove-drawing", row: structuredClone(row) });
    forgetDrawing(id);
    renderDrawings();
    renderLegend();
    paintDrawTools();
    return;
  }
  if (!canWrite()) {
    announce("Preview only. Sign in as admin to save.");
    paintDrawTools();
    return;
  }
  const { data, error } = await supabase.from("map_drawings").delete().eq("id", id).select("id");
  if (error || !data?.length) {
    announce("Couldn't delete that drawing.");
    paintDrawTools();
    return;
  }
  pushUndo({ kind: "remove-drawing", row: structuredClone(row) });
  forgetDrawing(id);
  renderDrawings();
  renderLegend();
  paintDrawTools();
}

async function persistDrawingPoints(row) {
  if (!canWrite() || String(row.id).startsWith("preview-")) return true;
  const updated_at = new Date().toISOString();
  const { data, error } = await supabase
    .from("map_drawings")
    .update({ points: row.points, updated_at })
    .eq("id", row.id)
    .select("id,map_slug,kind,points,color,label,created_at,updated_at");
  if (error || !data?.length) return false;
  applyDrawing(normalizeDrawing(data[0]));
  return true;
}

function startPinDrag(event, marker) {
  const row = state.callouts.find((item) => item.id === marker.dataset.id);
  if (!row) return;
  viewport.setPointerCapture?.(event.pointerId);
  pinDrag = {
    id: row.id,
    pointerId: event.pointerId,
    moved: false,
    ox: event.clientX,
    oy: event.clientY,
    x: row.x,
    y: row.y,
  };
}

function movePinDrag(event) {
  const distance = Math.hypot(event.clientX - pinDrag.ox, event.clientY - pinDrag.oy);
  if (!pinDrag.moved && distance < 8) return;
  if (!pinDrag.moved) markSuppressed();
  pinDrag.moved = true;
  const point = pointFromClient(event.clientX, event.clientY);
  if (!point) return;
  const row = state.callouts.find((item) => item.id === pinDrag.id);
  const marker = pinsEl.querySelector(`.marker[data-id="${CSS.escape(pinDrag.id)}"]`);
  if (!row || !marker) return;
  row.x = point.x;
  row.y = point.y;
  marker.style.left = `${point.x * 100}%`;
  marker.style.top = `${point.y * 100}%`;
}

async function finishPinDrag(dragState) {
  const row = state.callouts.find((item) => item.id === dragState.id);
  if (!row) return;
  if (!canWrite()) {
    row.x = dragState.x;
    row.y = dragState.y;
    renderMarkers();
    announce("Preview only. Sign in as admin to save.");
    return;
  }
  const { data, error } = await supabase
    .from("callouts")
    .update({ x: row.x, y: row.y })
    .eq("id", row.id)
    .select("id,map_slug,x,y,name,created_at");
  if (error || !data?.length) {
    row.x = dragState.x;
    row.y = dragState.y;
    renderMarkers();
    announce("Couldn't move that pin.");
    return;
  }
  applyUpdate(normalize(data[0]));
  pushUndo({ kind: "pin", id: row.id, x: dragState.x, y: dragState.y });
  renderMarkers();
}

function startPointDrag(event, handle) {
  const row = state.drawings.find((item) => item.id === handle.dataset.id);
  const index = Number(handle.dataset.index);
  if (!row || !Number.isInteger(index) || !row.points[index]) return;
  viewport.setPointerCapture?.(event.pointerId);
  pointDrag = {
    id: row.id,
    index,
    pointerId: event.pointerId,
    moved: false,
    ox: event.clientX,
    oy: event.clientY,
    points: structuredClone(row.points),
  };
}

function movePointDrag(event) {
  const distance = Math.hypot(event.clientX - pointDrag.ox, event.clientY - pointDrag.oy);
  if (!pointDrag.moved && distance < 8) return;
  if (!pointDrag.moved) markSuppressed();
  pointDrag.moved = true;
  const point = pointFromClient(event.clientX, event.clientY);
  if (!point) return;
  const row = state.drawings.find((item) => item.id === pointDrag.id);
  if (!row || !row.points[pointDrag.index]) return;
  row.points[pointDrag.index] = [point.x, point.y];
  renderDrawings();
}

async function finishPointDrag(dragState) {
  const row = state.drawings.find((item) => item.id === dragState.id);
  if (!row) return;
  if (!canWrite() || String(row.id).startsWith("preview-")) {
    if (!canWrite() && !String(row.id).startsWith("preview-")) {
      row.points = dragState.points;
      renderDrawings();
    } else {
      pushUndo({ kind: "points", id: row.id, points: dragState.points });
    }
    if (!canWrite()) announce("Preview only. Sign in as admin to save.");
    return;
  }
  const saved = await persistDrawingPoints(row);
  if (!saved) {
    row.points = dragState.points;
    renderDrawings();
    announce("Couldn't move that point.");
    return;
  }
  pushUndo({ kind: "points", id: row.id, points: dragState.points });
}

async function undoLast() {
  const action = state.undo.pop();
  paintDrawTools();
  if (!action) return;
  if (action.kind === "pin") {
    const row = state.callouts.find((item) => item.id === action.id);
    if (!row || !canWrite()) return;
    const { error, data } = await supabase
      .from("callouts")
      .update({ x: action.x, y: action.y })
      .eq("id", row.id)
      .select("id,map_slug,x,y,name,created_at");
    if (error || !data?.length) {
      announce("Couldn't undo that move.");
      return;
    }
    applyUpdate(normalize(data[0]));
    renderMarkers();
    return;
  }
  if (action.kind === "add-drawing") {
    const row = state.drawings.find((item) => item.id === action.id);
    if (!row) return;
    if (String(row.id).startsWith("preview-") || !canWrite()) {
      forgetDrawing(row.id);
      renderDrawings();
      renderLegend();
      return;
    }
    const { data, error } = await supabase.from("map_drawings").delete().eq("id", row.id).select("id");
    if (error || !data?.length) {
      announce("Couldn't undo that drawing.");
      return;
    }
    forgetDrawing(row.id);
    renderDrawings();
    renderLegend();
    return;
  }
  if (action.kind === "remove-drawing") {
    if (String(action.row.id).startsWith("preview-") || !canWrite()) {
      rememberDrawing(action.row);
      renderDrawings();
      renderLegend();
      return;
    }
    const { data, error } = await supabase
      .from("map_drawings")
      .insert({
        map_slug: action.row.map_slug,
        kind: action.row.kind,
        points: action.row.points,
        color: action.row.color,
        label: action.row.label,
      })
      .select("id,map_slug,kind,points,color,label,created_at,updated_at")
      .single();
    if (error) {
      announce("Couldn't undo that delete.");
      return;
    }
    const row = normalizeDrawing(data);
    if (row) rememberDrawing(row);
    renderDrawings();
    renderLegend();
    return;
  }
  if (action.kind === "points") {
    const row = state.drawings.find((item) => item.id === action.id);
    if (!row) return;
    const current = structuredClone(row.points);
    row.points = action.points;
    if (String(row.id).startsWith("preview-") || !canWrite()) {
      renderDrawings();
      return;
    }
    const saved = await persistDrawingPoints(row);
    if (!saved) {
      row.points = current;
      renderDrawings();
      announce("Couldn't undo that point.");
    }
  }
}

function subscribe() {
  const token = ++channelToken;
  if (channel) supabase.removeChannel(channel);
  const next = supabase
    .channel(`callouts-feed-${token}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "callouts" },
      (payload) => {
        if (token !== channelToken) return;
        const event = payload.eventType;
        if (event === "DELETE") {
          const id = payload.old?.id ? String(payload.old.id) : "";
          if (!id || !forget(id)) return;
          renderCounts();
          if (state.map) renderMarkers();
          if (state.booted) announce("A callout was removed.");
          return;
        }
        const row = normalize(payload.new);
        if (!row) return;
        if (event === "UPDATE") {
          const result = applyUpdate(row);
          if (result === "same" || result === "skip") return;
          renderCounts();
          if (state.map && state.map.slug === row.map_slug) renderMarkers();
          if (state.booted && result === "changed") announce(`${row.name} was updated.`);
          return;
        }
        if (!remember(row)) return;
        renderCounts();
        if (state.map && state.map.slug === row.map_slug) renderMarkers(row.id);
        if (state.booted) announce(row.name);
      }
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "map_drawings" },
      (payload) => {
        if (token !== channelToken) return;
        const event = payload.eventType;
        if (event === "DELETE") {
          const id = payload.old?.id ? String(payload.old.id) : "";
          if (!id || !forgetDrawing(id)) return;
          renderDrawings();
          renderLegend();
          return;
        }
        const row = normalizeDrawing(payload.new);
        if (!row) return;
        if (event === "UPDATE") {
          const result = applyDrawing(row);
          if (result === "same" || result === "skip") return;
          if (state.map && state.map.slug === row.map_slug) {
            renderDrawings();
            renderLegend();
          }
          return;
        }
        if (!rememberDrawing(row)) return;
        if (state.map && state.map.slug === row.map_slug) {
          renderDrawings();
          renderLegend();
        }
      }
    )
    .subscribe((status) => {
      if (token !== channelToken) return;
      setLive(status);
      if (status === "SUBSCRIBED") return;
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
        liveFailures += 1;
        if (liveFailures <= 4) {
          window.setTimeout(() => {
            if (token === channelToken) subscribe();
          }, 2500);
        }
      }
    });
  channel = next;
}

async function loadCallouts() {
  const [calls, drawings] = await Promise.all([
    supabase
      .from("callouts")
      .select("id,map_slug,x,y,name,created_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("map_drawings")
      .select("id,map_slug,kind,points,color,label,created_at,updated_at")
      .order("created_at", { ascending: true }),
  ]);
  if (calls.error) throw calls.error;
  if (drawings.error) throw drawings.error;
  for (const row of calls.data || []) remember(normalize(row));
  for (const row of drawings.data || []) rememberDrawing(normalizeDrawing(row));
  state.booted = true;
  renderCounts();
  if (state.map) {
    renderMarkers();
    renderDrawings();
  }
}

function onPointerDown(event) {
  if (event.target.closest(".legend, .pin-actions, .draw-tools")) return;
  if (event.button !== undefined && event.button !== 0) return;
  const handle = event.target.closest(".draw-handle");
  if (handle && editingTools()) {
    startPointDrag(event, handle);
    return;
  }
  const marker = event.target.closest(".marker[data-id]");
  if (marker && editingTools()) {
    startPinDrag(event, marker);
    return;
  }
  if (event.target.closest(".drawing-hit") && editingTools()) return;
  viewport.setPointerCapture?.(event.pointerId);
  pointers.set(event.pointerId, {
    x: event.clientX,
    y: event.clientY,
    ox: event.clientX,
    oy: event.clientY,
  });
  if (pointers.size >= 2) {
    beginPinch();
    drag = null;
    return;
  }
  drag = { id: event.pointerId, moved: false, lastX: event.clientX, lastY: event.clientY };
}

function beginPinch() {
  const pts = [...pointers.values()];
  if (pts.length < 2) return;
  const rect = viewport.getBoundingClientRect();
  const midX = (pts[0].x + pts[1].x) / 2 - rect.left;
  const midY = (pts[0].y + pts[1].y) / 2 - rect.top;
  pinch = {
    dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
    scale: state.view.scale,
    wx: (midX - state.view.x) / state.view.scale,
    wy: (midY - state.view.y) / state.view.scale,
  };
  markSuppressed();
}

function onPointerMove(event) {
  if (pinDrag && pinDrag.pointerId === event.pointerId) {
    movePinDrag(event);
    return;
  }
  if (pointDrag && pointDrag.pointerId === event.pointerId) {
    movePointDrag(event);
    return;
  }
  const point = pointers.get(event.pointerId);
  if (!point) return;
  point.x = event.clientX;
  point.y = event.clientY;
  if (pointers.size >= 2 && pinch) {
    const pts = [...pointers.values()];
    const rect = viewport.getBoundingClientRect();
    const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
    const cx = (pts[0].x + pts[1].x) / 2 - rect.left;
    const cy = (pts[0].y + pts[1].y) / 2 - rect.top;
    const scale = Math.min(state.view.max, Math.max(state.view.min, pinch.scale * (dist / pinch.dist)));
    state.view.scale = scale;
    state.view.x = cx - pinch.wx * scale;
    state.view.y = cy - pinch.wy * scale;
    state.userAdjusted = true;
    clampPan();
    applyView();
    return;
  }
  if (!drag || drag.id !== event.pointerId) return;
  const distance = Math.hypot(event.clientX - point.ox, event.clientY - point.oy);
  if (!drag.moved && distance < 8) return;
  if (!drag.moved) markSuppressed();
  drag.moved = true;
  state.view.x += event.clientX - drag.lastX;
  state.view.y += event.clientY - drag.lastY;
  drag.lastX = event.clientX;
  drag.lastY = event.clientY;
  state.userAdjusted = true;
  clampPan();
  applyView();
}

function onPointerUp(event) {
  if (pinDrag && pinDrag.pointerId === event.pointerId) {
    const dragState = pinDrag;
    pinDrag = null;
    if (dragState.moved) finishPinDrag(dragState);
    return;
  }
  if (pointDrag && pointDrag.pointerId === event.pointerId) {
    const dragState = pointDrag;
    pointDrag = null;
    if (dragState.moved) finishPointDrag(dragState);
    return;
  }
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && drag.id === event.pointerId) drag = null;
}

async function onAdminClick() {
  if (state.session) {
    state.toldNotAdmin = false;
    const { error } = await supabase.auth.signOut();
    if (error) console.error(error);
    return;
  }
  openAdminDialog();
}

board.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-slug]");
  if (!link) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  event.preventDefault();
  const slug = link.dataset.slug;
  if (location.hash !== `#${slug}`) history.pushState({ map: slug }, "", `#${slug}`);
  showMap(slug);
});

$("search").addEventListener("input", (event) => {
  state.query = event.target.value;
  renderBoard();
});

$("close-viewer").addEventListener("click", () => {
  if (location.hash) history.pushState({ map: null }, "", location.pathname + location.search);
  closeViewer();
});

$("admin-open").addEventListener("click", onAdminClick);
$("viewer-admin").addEventListener("click", onAdminClick);
$("admin-close").addEventListener("click", () => adminDialog.close());
$("admin-signout").addEventListener("click", onAdminClick);

$("admin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const email = cleanEmail($("admin-email").value);
  if (!email) {
    $("admin-error").textContent = "Enter a valid email address.";
    return;
  }
  $("admin-send").disabled = true;
  $("admin-error").textContent = "";
  const emailRedirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}`;
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo },
  });
  $("admin-send").disabled = false;
  if (error) {
    $("admin-error").textContent = error.message || "Could not send the sign-in link.";
    return;
  }
  $("admin-email-field").hidden = true;
  $("admin-send").hidden = true;
  $("admin-copy").hidden = true;
  $("admin-message").hidden = false;
  $("admin-message").textContent = "Check that inbox for the sign-in link, then open it in this browser.";
});

form.addEventListener("submit", saveDraft);
$("draft-cancel").addEventListener("click", () => closeDraft());
$("draft-delete").addEventListener("click", () => {
  const button = $("draft-delete");
  if (button.dataset.confirm !== "yes") {
    button.dataset.confirm = "yes";
    button.textContent = "Confirm delete";
    return;
  }
  deleteCallout(state.editingId, { immediate: true });
});

viewport.addEventListener("pointerdown", onPointerDown);
viewport.addEventListener("pointermove", onPointerMove);
viewport.addEventListener("pointerup", onPointerUp);
viewport.addEventListener("pointercancel", onPointerUp);
viewport.addEventListener("touchmove", (event) => {
  if (event.target.closest(".pin-actions")) return;
  event.preventDefault();
}, { passive: false });
viewport.addEventListener("contextmenu", (event) => event.preventDefault());
viewport.addEventListener("dragstart", (event) => event.preventDefault());

viewport.addEventListener("wheel", (event) => {
  event.preventDefault();
  const rect = viewport.getBoundingClientRect();
  const factor = event.ctrlKey ? Math.exp(-event.deltaY * 0.008) : event.deltaY < 0 ? 1.12 : 1 / 1.12;
  zoomAt(event.clientX - rect.left, event.clientY - rect.top, state.view.scale * factor);
}, { passive: false });

viewport.addEventListener("click", (event) => {
  if (suppressClick) {
    suppressClick = false;
    suppressToken += 1;
    return;
  }
  if (event.target.closest(".draw-handle")) return;
  const hit = event.target.closest(".drawing-hit");
  if (hit) {
    if (editingTools()) selectDrawing(hit.dataset.id);
    return;
  }
  if (event.target.closest(".marker, .pin-actions")) return;
  if (!editingTools()) return;
  if (state.tool === "marker") {
    openDraft(event.clientX, event.clientY);
    return;
  }
  addDrawPoint(event.clientX, event.clientY);
});

viewport.addEventListener("dblclick", (event) => {
  if (!editingTools() || state.tool === "marker" || !state.drawDraft) return;
  const points = state.drawDraft.points;
  if (points.length >= 2 && nearPoint(points[points.length - 1], points[points.length - 2])) points.pop();
  finishDrawing();
  event.preventDefault();
});

pinsEl.addEventListener("click", (event) => {
  if (suppressClick) return;
  const edit = event.target.closest(".pin-edit");
  if (edit) {
    event.stopPropagation();
    openRename(edit.dataset.id);
    return;
  }
  const remove = event.target.closest(".pin-delete");
  if (remove) {
    event.stopPropagation();
    deleteCallout(remove.dataset.id);
    return;
  }
  const marker = event.target.closest(".marker[data-id]");
  if (!marker) return;
  event.stopPropagation();
  focusCallout(marker.dataset.id, { sticky: true, reveal: false });
});

$("zoom-in").addEventListener("click", () => {
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, state.view.scale * 1.25);
});
$("zoom-out").addEventListener("click", () => {
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, state.view.scale / 1.25);
});
$("zoom-fit").addEventListener("click", fitMap);

$("legend-toggle").addEventListener("click", () => setLegendOpen(!state.legendOpen));
$("legend-close").addEventListener("click", () => setLegendOpen(false));

$("draw-tools").addEventListener("click", (event) => {
  const tool = event.target.closest(".tool-btn");
  if (tool) {
    state.tool = tool.dataset.tool;
    state.drawDraft = null;
    $("draw-delete").dataset.confirm = "";
    updateHint();
    renderDrawings();
    paintDrawTools();
    return;
  }
  const color = event.target.closest(".color-btn");
  if (color) {
    state.drawColor = color.dataset.color;
    paintDrawTools();
  }
});
$("draw-finish").addEventListener("click", () => finishDrawing());
$("draw-delete").addEventListener("click", () => deleteSelectedDrawing());
$("draw-undo").addEventListener("click", () => undoLast());

mapImage.addEventListener("load", () => {
  $("map-loading").hidden = true;
  fitMap();
  renderMarkers();
});

window.addEventListener("resize", () => {
  if (viewer.hidden) return;
  if (state.userAdjusted) {
    clampPan();
    applyView();
  } else {
    fitMap();
  }
});

document.addEventListener("keydown", (event) => {
  if (adminDialog.open) return;
  if (event.key === "Escape" && state.drawDraft) {
    state.drawDraft = null;
    renderDrawings();
    paintDrawTools();
    return;
  }
  if (event.key === "Escape" && !form.hidden) {
    closeDraft();
    return;
  }
  if (event.key === "Escape" && state.confirmDeleteId) {
    state.confirmDeleteId = null;
    renderMarkers();
    return;
  }
  if (event.target.closest("input, textarea")) return;
  if (viewer.hidden) return;
  if (event.key === "Escape" && state.legendOpen && window.matchMedia("(max-width: 720px)").matches) {
    setLegendOpen(false);
  } else if (event.key === "Escape") {
    $("close-viewer").click();
  } else if (event.key === "+" || event.key === "=") {
    $("zoom-in").click();
  } else if (event.key === "-" || event.key === "_") {
    $("zoom-out").click();
  } else if (event.key === "0") {
    fitMap();
  }
});

window.addEventListener("popstate", route);

async function start() {
  forgetLegacyKeys();
  paintAdminChrome();
  supabase.auth.onAuthStateChange((_event, session) => {
    applySession(session);
  });
  try {
    const { data } = await supabase.auth.getSession();
    applySession(data.session);
  } catch (error) {
    console.error(error);
  }
  try {
    const response = await fetch("maps.json");
    if (!response.ok) throw new Error(`maps.json ${response.status}`);
    const catalog = await response.json();
    state.modes = catalog.modes;
    state.maps = catalog.maps;
    state.bySlug = new Map(catalog.maps.map((map) => [map.slug, map]));
  } catch (error) {
    showBanner("Could not load the map list.");
    console.error(error);
    return;
  }
  renderFilters();
  renderBoard();
  route();
  subscribe();
  try {
    await loadCallouts();
  } catch (error) {
    showBanner("Could not load shared callouts. You can still browse the maps.");
    console.error(error);
  }
}

start();
