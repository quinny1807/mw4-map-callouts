import { createClient } from "./vendor/supabase.js";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from "./config.js";
import { choosePlacements, compareByVotes, emphasisFor } from "./labels.js";

const TAG_KEY = "mw4-callouts-gamertag";
const VOTER_KEY = "mw4-callouts-voter-id";

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
});

const $ = (id) => document.getElementById(id);

const state = {
  modes: [],
  maps: [],
  bySlug: new Map(),
  callouts: [],
  seen: new Set(),
  votes: [],
  voteKeys: new Set(),
  filter: "all",
  query: "",
  map: null,
  selectedId: null,
  draft: null,
  pendingPoint: null,
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
const form = $("callout-form");
const dialog = $("tag-dialog");

function cleanText(value, max) {
  const text = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.length > max) return null;
  return text;
}

function loadTag() {
  try {
    return cleanText(localStorage.getItem(TAG_KEY) || "", 32);
  } catch {
    return cleanText(state.memoryTag || "", 32);
  }
}

function saveTag(tag) {
  state.memoryTag = tag;
  try {
    localStorage.setItem(TAG_KEY, tag);
  } catch {
    // Private mode still keeps the name for this tab.
  }
}

function voterId() {
  try {
    const existing = localStorage.getItem(VOTER_KEY) || "";
    if (existing.length >= 8 && existing.length <= 64) return existing;
    const created = crypto.randomUUID();
    localStorage.setItem(VOTER_KEY, created);
    return created;
  } catch {
    if (!state.memoryVoter) state.memoryVoter = crypto.randomUUID();
    return state.memoryVoter;
  }
}

function voteKey(row) {
  return `${row.callout_id}:${row.voter_id}`;
}

function normalizeVote(row) {
  if (!row?.id || !row.callout_id || !row.voter_id) return null;
  const voter = String(row.voter_id);
  if (voter.length < 8 || voter.length > 64) return null;
  const gamertag = row.gamertag == null ? null : cleanText(row.gamertag, 32);
  return {
    id: String(row.id),
    callout_id: String(row.callout_id),
    voter_id: voter,
    gamertag,
    created_at: String(row.created_at || ""),
  };
}

function rememberVote(row) {
  if (!row) return false;
  const key = voteKey(row);
  if (state.voteKeys.has(key) || state.voteKeys.has(row.id)) {
    const existing = state.votes.find((vote) => voteKey(vote) === key);
    if (existing && String(existing.id).startsWith("tmp-") && !String(row.id).startsWith("tmp-")) {
      state.voteKeys.delete(existing.id);
      existing.id = row.id;
      existing.created_at = row.created_at || existing.created_at;
      existing.gamertag = row.gamertag;
      state.voteKeys.add(row.id);
    }
    return false;
  }
  state.voteKeys.add(key);
  state.voteKeys.add(row.id);
  state.votes.push(row);
  return true;
}

function voteCount(calloutId) {
  let count = 0;
  for (const vote of state.votes) {
    if (vote.callout_id === calloutId) count += 1;
  }
  return count;
}

function hasVoted(calloutId) {
  const mine = voterId();
  return state.votes.some((vote) => vote.callout_id === calloutId && vote.voter_id === mine);
}

function isDuplicate(error) {
  const code = String(error?.code || "");
  const message = `${error?.message || ""} ${error?.details || ""}`;
  return code === "23505" || /duplicate key|already exists|unique constraint/i.test(message);
}

function tagLabel() {
  return loadTag() || "Set gamertag";
}

function paintTagButtons() {
  const label = tagLabel();
  for (const id of ["open-gamertag", "viewer-gamertag"]) {
    const button = $(id);
    button.textContent = label;
    button.setAttribute("aria-label", loadTag() ? `Change gamertag, current ${label}` : "Set gamertag");
  }
  $("draft-tag").textContent = loadTag() || "…";
}

function announce(message) {
  $("announce").textContent = message;
}

function showBanner(message) {
  const banner = $("banner");
  banner.hidden = !message;
  banner.textContent = message || "";
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
  const gamertag = cleanText(row.gamertag, 32);
  if (!name || !gamertag || !row.map_slug) return null;
  return {
    id: String(row.id),
    map_slug: String(row.map_slug),
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
    name,
    gamertag,
    created_at: String(row.created_at || ""),
  };
}

function remember(row) {
  if (!row || state.seen.has(row.id)) return false;
  state.seen.add(row.id);
  state.callouts.push(row);
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
  $("toggle-calls").textContent = n === 1 ? "1 call" : `${n} calls`;
  renderCallList();
}

function renderCallList() {
  const list = $("calls-list");
  list.replaceChildren();
  if (!state.map) return;
  const rows = [...callsFor(state.map.slug)].sort((a, b) => compareByVotes(a, b, (pin) => voteCount(pin.id)));
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "No callouts on this map yet.";
    list.appendChild(empty);
    return;
  }
  for (const row of rows) {
    const item = document.createElement("div");
    item.className = "call-row";
    if (row.id === state.selectedId) item.setAttribute("aria-current", "true");
    const jump = document.createElement("button");
    jump.type = "button";
    jump.className = "call-jump";
    const strong = document.createElement("strong");
    strong.textContent = row.name;
    const by = document.createElement("span");
    by.textContent = `by ${row.gamertag}`;
    jump.append(strong, by);
    jump.addEventListener("click", () => selectPin(row.id));
    item.append(jump, voteButton(row));
    list.appendChild(item);
  }
}

function voteButton(row) {
  const count = voteCount(row.id);
  const voted = hasVoted(row.id);
  const button = document.createElement("button");
  button.type = "button";
  button.className = `vote${voted ? " is-voted" : ""}`;
  button.dataset.id = row.id;
  button.setAttribute("aria-pressed", String(voted));
  const noun = count === 1 ? "vote" : "votes";
  button.setAttribute(
    "aria-label",
    voted ? `Upvoted ${row.name}, ${count} ${noun}` : `Upvote ${row.name}, ${count} ${noun}`
  );
  const mark = document.createElement("span");
  mark.className = "vote-mark";
  mark.setAttribute("aria-hidden", "true");
  mark.textContent = "▲";
  const num = document.createElement("span");
  num.className = "vote-count";
  num.textContent = String(count);
  button.append(mark, num);
  return button;
}

function renderMarkers(freshId) {
  pinsEl.replaceChildren();
  if (!state.map) return;
  const rows = callsFor(state.map.slug);
  const places = choosePlacements(rows);
  const emphasis = emphasisFor(rows, (pin) => voteCount(pin.id));
  for (const row of rows) {
    const marker = document.createElement("div");
    marker.className = "marker";
    if (row.id === freshId) marker.classList.add("is-new");
    if (row.id === state.selectedId) marker.classList.add("is-active");
    if (emphasis.lead.has(row.id)) marker.classList.add("is-lead");
    if (emphasis.quiet.has(row.id)) marker.classList.add("is-quiet");
    marker.dataset.id = row.id;
    marker.dataset.place = places.get(row.id) || "top";
    marker.style.left = `${row.x * 100}%`;
    marker.style.top = `${row.y * 100}%`;
    const votes = Math.min(voteCount(row.id), 40);
    const lead = emphasis.lead.has(row.id) ? 20 : 0;
    const active = row.id === state.selectedId ? 30 : 0;
    marker.style.zIndex = String(2 + votes + lead + active);

    const ui = document.createElement("span");
    ui.className = "marker-ui";
    const dot = document.createElement("span");
    dot.className = "dot";
    const tag = document.createElement("span");
    tag.className = "tag";
    const name = document.createElement("span");
    name.className = "tag-name";
    name.textContent = row.name;
    const by = document.createElement("span");
    by.className = "tag-by";
    by.textContent = `by ${row.gamertag}`;
    tag.append(name, by, voteButton(row));
    ui.append(dot, tag);
    marker.appendChild(ui);
    pinsEl.appendChild(marker);
  }
  renderDraftMarker();
  renderCallList();
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

function centerOn(row) {
  const { w, h } = imageSize();
  const scale = Math.min(state.view.max, Math.max(state.view.scale, state.view.fit * 2.2));
  state.view.scale = scale;
  state.view.x = viewport.clientWidth / 2 - row.x * w * scale;
  state.view.y = viewport.clientHeight / 2 - row.y * h * scale;
  state.userAdjusted = true;
  clampPan();
  applyView();
}

function selectPin(id) {
  state.selectedId = id;
  const row = state.callouts.find((item) => item.id === id);
  renderMarkers();
  if (row) centerOn(row);
}

function showMap(slug) {
  const map = state.bySlug.get(slug);
  if (!map) return;
  state.map = map;
  state.selectedId = null;
  closeDraft();
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
  closeDraft();
  viewer.hidden = true;
  document.body.classList.remove("viewer-open");
  state.map = null;
  $("calls-panel").hidden = true;
  $("toggle-calls").setAttribute("aria-expanded", "false");
}

function route() {
  const slug = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (slug && state.bySlug.has(slug)) showMap(slug);
  else closeViewer();
}

function openTagDialog() {
  const existing = loadTag();
  $("tag-input").value = existing || "";
  $("tag-error").textContent = "";
  $("tag-cancel").hidden = !existing;
  if (!dialog.open) dialog.showModal();
  $("tag-input").focus();
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
  const point = pointFromClient(clientX, clientY);
  if (!point || !state.map) return;
  if (!loadTag()) {
    state.pendingPoint = { ...point, clientX, clientY };
    openTagDialog();
    return;
  }
  state.draft = point;
  $("callout-input").value = "";
  $("draft-error").textContent = "";
  $("draft-save").disabled = false;
  form.hidden = false;
  paintTagButtons();
  renderDraftMarker();
  positionDraftForm();
  $("callout-input").focus();
}

function closeDraft() {
  state.draft = null;
  form.hidden = true;
  $("draft-error").textContent = "";
  renderDraftMarker();
}

function positionDraftForm() {
  if (form.hidden) return;
  const marker = pinsEl.querySelector(".is-draft");
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

function friendlyError(error) {
  const message = error?.message || "Could not save that callout.";
  if (message.includes("name_check")) return "Use 1–40 characters for the callout.";
  if (message.includes("gamertag_check")) return "Gamertag must be 1–32 characters.";
  if (message.includes("x_check") || message.includes("y_check")) return "That spot is outside the map.";
  if (message.includes("map_slug")) return "That map is not valid.";
  if (message.includes("Failed to fetch") || message.includes("NetworkError")) return "Could not reach the server.";
  return message;
}

async function saveDraft(event) {
  event.preventDefault();
  if (!state.draft || !state.map) return;
  const name = cleanText($("callout-input").value, 40);
  const gamertag = loadTag();
  if (!name) {
    $("draft-error").textContent = "Name the spot. Up to 40 characters.";
    return;
  }
  if (!gamertag) {
    openTagDialog();
    return;
  }
  $("draft-save").disabled = true;
  $("draft-error").textContent = "";
  const payload = {
    map_slug: state.map.slug,
    x: state.draft.x,
    y: state.draft.y,
    name,
    gamertag,
  };
  const { data, error } = await supabase
    .from("callouts")
    .insert(payload)
    .select("id,map_slug,x,y,name,gamertag,created_at")
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
  if (row) announce(`${row.name}, by ${row.gamertag}`);
}

function refreshVotes(calloutId) {
  renderCounts();
  if (!state.map) return;
  const onMap = state.callouts.some((row) => row.id === calloutId && row.map_slug === state.map.slug);
  if (onMap || !calloutId) renderMarkers();
}

async function castVote(calloutId) {
  const callout = state.callouts.find((row) => row.id === calloutId);
  if (!callout) return;
  if (hasVoted(calloutId)) {
    announce(`You already upvoted ${callout.name}.`);
    return;
  }
  const voter = voterId();
  const gamertag = loadTag();
  const optimistic = {
    id: `tmp-${calloutId}`,
    callout_id: calloutId,
    voter_id: voter,
    gamertag,
    created_at: new Date().toISOString(),
  };
  rememberVote(optimistic);
  refreshVotes(calloutId);
  const { data, error } = await supabase
    .from("callout_votes")
    .insert({
      callout_id: calloutId,
      voter_id: voter,
      gamertag,
    })
    .select("id,callout_id,voter_id,gamertag,created_at")
    .single();
  if (error) {
    if (isDuplicate(error)) {
      announce(`You already upvoted ${callout.name}.`);
      refreshVotes(calloutId);
      return;
    }
    state.votes = state.votes.filter((vote) => vote.id !== optimistic.id);
    state.voteKeys.delete(voteKey(optimistic));
    state.voteKeys.delete(optimistic.id);
    refreshVotes(calloutId);
    announce("Couldn't save that vote.");
    console.error(error);
    return;
  }
  rememberVote(normalizeVote(data));
  refreshVotes(calloutId);
  announce(`Upvoted ${callout.name}.`);
}

function subscribe() {
  const token = ++channelToken;
  if (channel) supabase.removeChannel(channel);
  const next = supabase
    .channel(`callouts-feed-${token}`)
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "callouts" },
      (payload) => {
        if (token !== channelToken) return;
        const row = normalize(payload.new);
        if (!row || !remember(row)) return;
        renderCounts();
        if (state.map && state.map.slug === row.map_slug) renderMarkers(row.id);
        if (state.booted) announce(`${row.name}, by ${row.gamertag}`);
      }
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "callout_votes" },
      (payload) => {
        if (token !== channelToken) return;
        const row = normalizeVote(payload.new);
        if (!row || !rememberVote(row)) return;
        refreshVotes(row.callout_id);
        if (state.booted && row.voter_id !== voterId()) {
          const callout = state.callouts.find((item) => item.id === row.callout_id);
          if (callout) {
            const n = voteCount(callout.id);
            announce(`${callout.name} now has ${n} ${n === 1 ? "vote" : "votes"}.`);
          }
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
  const [calls, votes] = await Promise.all([
    supabase
      .from("callouts")
      .select("id,map_slug,x,y,name,gamertag,created_at")
      .order("created_at", { ascending: true }),
    supabase
      .from("callout_votes")
      .select("id,callout_id,voter_id,gamertag,created_at"),
  ]);
  if (calls.error) throw calls.error;
  if (votes.error) throw votes.error;
  for (const row of calls.data || []) remember(normalize(row));
  for (const row of votes.data || []) rememberVote(normalizeVote(row));
  state.booted = true;
  renderCounts();
  if (state.map) renderMarkers();
}

function onPointerDown(event) {
  if (event.target.closest(".calls-panel, .vote")) return;
  if (event.button !== undefined && event.button !== 0) return;
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
  pointers.delete(event.pointerId);
  if (pointers.size < 2) pinch = null;
  if (drag && drag.id === event.pointerId) drag = null;
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

$("open-gamertag").addEventListener("click", openTagDialog);
$("viewer-gamertag").addEventListener("click", openTagDialog);

$("tag-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const tag = cleanText($("tag-input").value, 32);
  if (!tag) {
    $("tag-error").textContent = "Enter a gamertag, up to 32 characters.";
    return;
  }
  saveTag(tag);
  paintTagButtons();
  dialog.close();
  const pending = state.pendingPoint;
  state.pendingPoint = null;
  if (pending && state.map) openDraft(pending.clientX, pending.clientY);
});

$("tag-cancel").addEventListener("click", () => {
  if (loadTag()) dialog.close();
});

dialog.addEventListener("cancel", (event) => {
  if (!loadTag()) event.preventDefault();
});

form.addEventListener("submit", saveDraft);
$("draft-cancel").addEventListener("click", closeDraft);

viewport.addEventListener("pointerdown", onPointerDown);
viewport.addEventListener("pointermove", onPointerMove);
viewport.addEventListener("pointerup", onPointerUp);
viewport.addEventListener("pointercancel", onPointerUp);
viewport.addEventListener("touchmove", (event) => {
  if (event.target.closest(".calls-panel, .vote")) return;
  event.preventDefault();
}, { passive: false });
viewport.addEventListener("contextmenu", (event) => event.preventDefault());
viewport.addEventListener("dragstart", (event) => event.preventDefault());

viewport.addEventListener("wheel", (event) => {
  if (event.target.closest(".calls-panel")) return;
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
  if (event.target.closest(".marker, .calls-panel, .vote")) return;
  openDraft(event.clientX, event.clientY);
});

pinsEl.addEventListener("click", (event) => {
  const vote = event.target.closest(".vote");
  if (vote) {
    event.stopPropagation();
    castVote(vote.dataset.id);
    return;
  }
  const marker = event.target.closest(".marker[data-id]");
  if (!marker) return;
  event.stopPropagation();
  selectPin(marker.dataset.id);
});

$("calls-list").addEventListener("click", (event) => {
  const vote = event.target.closest(".vote");
  if (!vote) return;
  event.stopPropagation();
  castVote(vote.dataset.id);
});

$("zoom-in").addEventListener("click", () => {
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, state.view.scale * 1.25);
});
$("zoom-out").addEventListener("click", () => {
  zoomAt(viewport.clientWidth / 2, viewport.clientHeight / 2, state.view.scale / 1.25);
});
$("zoom-fit").addEventListener("click", fitMap);

$("toggle-calls").addEventListener("click", () => {
  const panel = $("calls-panel");
  panel.hidden = !panel.hidden;
  $("toggle-calls").setAttribute("aria-expanded", String(!panel.hidden));
});

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
  if (event.key === "Escape" && !form.hidden) {
    closeDraft();
    return;
  }
  if (event.target.closest("input, textarea")) return;
  if (viewer.hidden) return;
  if (event.key === "Escape") {
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
  paintTagButtons();
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
  if (!loadTag()) openTagDialog();
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
