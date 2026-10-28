// Chatbot — workspace UI logic.
// Talks to the local server: /agents, /scenes, /cards, /characters, /chat,
// PATCH /cards, /memories, and scene CRUD.
const API_ROOT = window.location.origin;

const state = {
  agents: [],
  scenes: [],
  scenarios: [],
  cards: [],
  models: [],
  tagCatalog: [],
  selectedModel: null,
  selectedAgent: null,
  selectedScenario: null,
  selectedScene: null,
  groupChat: false,        // group chat mode: multiple AI characters respond
  groupCharacters: [],     // selected AI character nicknames for group chat
  activeCards: new Set(),
  memories: [], // [{scenario, name, scenes:[{scene, name, characters:[{character, name, memories}]}]}]
};

const history = []; // {role: "user"|"assistant", content, name?}

// Conversations survive page reloads, stored per agent + scene.
// Group chats are one shared room per scene: every participant sees the same
// timeline, and changing who is in the room does not split the history.
const CHAT_STORAGE_KEY = "Chatbot.conversations.v1";
const UI_STORAGE_KEY = "Chatbot.ui.v1";
const THEME_STORAGE_KEY = "Chatbot.theme";
let activeConversationKey = null;

// Sidebar preference: remembered across reloads. On a phone-sized viewport the
// sidebar starts closed (drawer) unless the user explicitly expanded it.
const SIDEBAR_MOBILE = window.matchMedia("(max-width: 760px)");
let sidebarCollapsed = readUiState().sidebarCollapsed ?? SIDEBAR_MOBILE.matches;

function applyTheme() {
  try {
    const theme = localStorage.getItem(THEME_STORAGE_KEY) || "system";
    document.documentElement.setAttribute("data-theme", theme);
  } catch {
    document.documentElement.setAttribute("data-theme", "system");
  }
}

function setTheme(theme) {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
  document.documentElement.setAttribute("data-theme", theme);
}

applyTheme();

function readJsonStorage(key) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode); chat still works in-memory.
  }
}

function conversationKey(agent = state.selectedAgent, scene = state.selectedScene) {
  if (state.groupChat) {
    return `group::${scene || "free"}`;
  }
  return agent ? `${agent}::${scene || ""}` : null;
}

function persistConversation(key = activeConversationKey) {
  if (!key) return;
  const store = readJsonStorage(CHAT_STORAGE_KEY);
  if (history.length) {
    store[key] = [...history];
  } else {
    delete store[key];
  }
  writeJsonStorage(CHAT_STORAGE_KEY, store);
}

function readUiState() {
  return readJsonStorage(UI_STORAGE_KEY);
}

function saveUiState() {
  writeJsonStorage(UI_STORAGE_KEY, {
    agent: state.selectedAgent,
    scenario: state.selectedScenario,
    scene: state.selectedScene,
    model: state.selectedModel,
    groupChat: state.groupChat,
    groupCharacters: state.groupCharacters,
    sidebarCollapsed,
  });
}

// ---------- Sidebar toggle ----------
function applySidebarState({ persist = false } = {}) {
  const mobile = SIDEBAR_MOBILE.matches;
  const open = !sidebarCollapsed;
  els.layout.classList.toggle("sidebar-collapsed", !mobile && sidebarCollapsed);
  els.layout.classList.toggle("sidebar-open", mobile && open);
  els.sidebarToggle.setAttribute("aria-expanded", String(open));
  els.sidebarToggle.setAttribute("aria-label", open ? "Hide sidebar" : "Show sidebar");
  els.sidebarToggle.title = open ? "Hide sidebar" : "Show sidebar";
  els.sidebarBackdrop.classList.toggle("hidden", !(mobile && open));
  document.body.classList.toggle("sidebar-lock", mobile && open);
  // Keep keyboard/screen-reader focus out of a closed sidebar.
  els.sidebar.toggleAttribute("inert", sidebarCollapsed);
  if (persist) saveUiState();
}

function setSidebarCollapsed(collapsed) {
  sidebarCollapsed = collapsed;
  applySidebarState({ persist: true });
}

function toggleSidebar() {
  setSidebarCollapsed(!sidebarCollapsed);
}

function closeSidebarOnMobile() {
  if (SIDEBAR_MOBILE.matches && !sidebarCollapsed) setSidebarCollapsed(true);
}

// ---------- DOM ----------
const els = {
  layout: document.getElementById("layout"),
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebar-backdrop"),
  sidebarToggle: document.getElementById("sidebar-toggle"),
  agentList: document.getElementById("agent-list"),
  manageList: document.getElementById("manage-list"),
  cardList: document.getElementById("card-list"),
  scenarioSelect: document.getElementById("scenario-select"),
  sceneSelect: document.getElementById("scene-select"),
  sceneNote: document.getElementById("scene-note"),
  messages: document.getElementById("messages"),
  composer: document.getElementById("composer"),
  messageInput: document.getElementById("message-input"),
  sendButton: document.getElementById("send-button"),
  modelSelect: document.getElementById("model-select"),
  chatStatus: document.getElementById("chat-status"),
  chatAgentName: document.getElementById("chat-agent-name"),
  chatAgentMeta: document.getElementById("chat-agent-meta"),
  chatScenarioBadge: document.getElementById("chat-scenario-badge"),
  chatSceneBadge: document.getElementById("chat-scene-badge"),
  chatCardsBadge: document.getElementById("chat-cards-badge"),
  chapterBar: document.getElementById("chapter-bar"),
  chapterStory: document.getElementById("chapter-story"),
  chapterSelect: document.getElementById("chapter-select"),
  newCharacter: document.getElementById("new-character"),
  newCard: document.getElementById("new-card"),
  groupChatToggle: document.getElementById("group-chat-mode"),
  chatGroupBadge: document.getElementById("chat-group-badge"),
  modal: document.getElementById("character-modal"),
  modalTitle: document.getElementById("character-modal-title"),
  modalClose: document.getElementById("character-modal-close"),
  modalCancel: document.getElementById("character-cancel"),
  form: document.getElementById("character-form"),
  formError: document.getElementById("character-form-error"),
  // Scenarios
  scenariosModal: document.getElementById("scenarios-modal"),
  scenariosModalClose: document.getElementById("scenarios-modal-close"),
  scenariosModalDone: document.getElementById("scenarios-modal-done"),
  newScenario: document.getElementById("new-scenario"),
  scenarioList: document.getElementById("scenario-list"),
  scenarioModal: document.getElementById("scenario-modal"),
  scenarioModalTitle: document.getElementById("scenario-modal-title"),
  scenarioModalClose: document.getElementById("scenario-modal-close"),
  scenarioCancel: document.getElementById("scenario-cancel"),
  scenarioForm: document.getElementById("scenario-form"),
  scenarioFormError: document.getElementById("scenario-form-error"),
  scenarioFormParticipants: document.getElementById("scenario-form-participants"),
  scenarioFormScenes: document.getElementById("scenario-form-scenes"),
  scenarioScenesAll: document.getElementById("scenario-scenes-all"),
  scenarioTags: document.getElementById("scenario-tags"),
  // Scenes
  newScene: document.getElementById("new-scene"),
  sceneList: document.getElementById("scene-list"),
  sceneModal: document.getElementById("scene-modal"),
  sceneModalTitle: document.getElementById("scene-modal-title"),
  sceneModalClose: document.getElementById("scene-modal-close"),
  sceneCancel: document.getElementById("scene-cancel"),
  sceneForm: document.getElementById("scene-form"),
  sceneFormError: document.getElementById("scene-form-error"),
  sceneFormParticipants: document.getElementById("scene-form-participants"),
  sceneParticipantsWrap: document.getElementById("scene-participants-wrap"),
  sceneParticipants: document.getElementById("scene-participants"),
  // Tag pickers
  characterTags: document.getElementById("character-tags"),
  sceneTags: document.getElementById("scene-tags"),
  cardTags: document.getElementById("card-tags"),
  // Memories
  memoryScenarioSelect: document.getElementById("memory-scenario-select"),
  memoryList: document.getElementById("memory-list"),
  memoriesRefresh: document.getElementById("memories-refresh"),
  // Settings
  settingsToggle: document.getElementById("settings-toggle"),
  settingsMenu: document.getElementById("settings-menu"),
  // Modals (Settings sections)
  charactersModal: document.getElementById("characters-modal"),
  charactersModalClose: document.getElementById("characters-modal-close"),
  charactersModalDone: document.getElementById("characters-modal-done"),
  scenesModal: document.getElementById("scenes-modal"),
  scenesModalClose: document.getElementById("scenes-modal-close"),
  scenesModalDone: document.getElementById("scenes-modal-done"),
  cardsModal: document.getElementById("cards-modal"),
  cardsModalClose: document.getElementById("cards-modal-close"),
  cardsModalDone: document.getElementById("cards-modal-done"),
   // New world card modal refs
   worldCardModal: document.getElementById("world-card-modal"),
   worldCardModalTitle: document.getElementById("world-card-modal-title"),
   worldCardModalClose: document.getElementById("world-card-modal-close"),
   worldCardCancel: document.getElementById("world-card-cancel"),
   worldCardSave: document.getElementById("world-card-save"),
   worldCardForm: document.getElementById("world-card-form"),
   worldCardFormError: document.getElementById("world-card-form-error"),
   memoriesModal: document.getElementById("memories-modal"),
  memoriesModalClose: document.getElementById("memories-modal-close"),
  memoriesModalDone: document.getElementById("memories-modal-done"),
  themeModal: document.getElementById("theme-modal"),
  themeModalClose: document.getElementById("theme-modal-close"),
  themeModalDone: document.getElementById("theme-modal-done"),
  helpModal: document.getElementById("help-modal"),
  helpModalClose: document.getElementById("help-modal-close"),
  helpClose: document.getElementById("help-close"),
  helpStatus: document.getElementById("help-status"),
  shutdownOverlay: document.getElementById("shutdown-overlay"),
};

// ---------- API helpers ----------
async function api(path, options = {}) {
  const response = await fetch(`${API_ROOT}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || `Request failed (${response.status})`);
  }
  return data;
}

// ---------- Rendering ----------
// Mirrors the server's slugification so Unicode or spaced nicknames still map
// to their YAML file key.
function agentKey(nickname) {
  return String(nickname ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function clearNode(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

// ---------- Tag picker ----------
// One reusable picker used by every create/edit form. Selections live in a
// plain object ({ categoryId: [tagId, ...] }) owned by the caller, so tags and
// free-text fields are saved independently.
function categoriesForTarget(target) {
  return state.tagCatalog.filter((category) => (category.appliesTo ?? []).includes(target));
}

function knownTagLabels() {
  const labels = new Map();
  for (const category of state.tagCatalog) {
    for (const tag of category.tags) labels.set(tag.id, { label: tag.label, category: category.label });
  }
  return labels;
}

function removeTagId(selection, tagId) {
  for (const [categoryId, tagIds] of Object.entries(selection)) {
    if (!Array.isArray(tagIds) || !tagIds.includes(tagId)) continue;
    const next = tagIds.filter((id) => id !== tagId);
    if (next.length) selection[categoryId] = next;
    else delete selection[categoryId];
  }
}

function renderTagPicker(container, target, selection) {
  clearNode(container);
  container.classList.add("tag-picker");
  const categories = categoriesForTarget(target);
  const known = knownTagLabels();
  let query = "";

  const head = document.createElement("div");
  head.className = "tag-picker-head";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "tag-search";
  search.placeholder = categories.length ? "Search tags…" : "No tags available";
  search.disabled = !categories.length;
  search.setAttribute("aria-label", "Search tags");
  const count = document.createElement("span");
  count.className = "tag-count";
  head.append(search, count);
  container.appendChild(head);

  const selectedWrap = document.createElement("div");
  selectedWrap.className = "tag-selected";
  container.appendChild(selectedWrap);

  const sections = document.createElement("div");
  sections.className = "tag-sections";
  container.appendChild(sections);

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    refresh();
  });

  function selectedTotal() {
    return Object.values(selection).reduce(
      (sum, ids) => sum + (Array.isArray(ids) ? ids.length : 0),
      0,
    );
  }

  function chip(tagId, label, { unavailable = false, onRemove } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `tag-chip${unavailable ? " unavailable" : " selected"}`;
    button.title = unavailable
      ? "This tag is unavailable (deleted or not valid for this entity) — click to remove"
      : `Remove ${label}`;
    const text = document.createElement("span");
    text.textContent = label;
    const cross = document.createElement("span");
    cross.className = "tag-x";
    cross.textContent = "×";
    button.append(text, cross);
    button.addEventListener("click", onRemove ?? (() => { removeTagId(selection, tagId); refresh(); }));
    return button;
  }

  function refresh() {
    count.textContent = selectedTotal() ? `${selectedTotal()} selected` : "No tags selected";
    clearNode(selectedWrap);
    clearNode(sections);

    // Selected chips, grouped in category order for quick scanning/removal.
    const applicableIds = new Set(categories.flatMap((category) => category.tags.map((tag) => tag.id)));
    for (const category of categories) {
      const ids = selection[category.id] ?? [];
      for (const tagId of ids) {
        if (!applicableIds.has(tagId)) continue;
        const meta = known.get(tagId);
        if (meta) selectedWrap.appendChild(chip(tagId, meta.label));
      }
    }
    if (!selectedWrap.childNodes.length) {
      const hint = document.createElement("span");
      hint.className = "tag-empty";
      hint.textContent = "Click a tag below to add it.";
      selectedWrap.appendChild(hint);
    }

    // Categories: collapsible, searchable, scrollable.
    let visibleSections = 0;
    for (const category of categories) {
      const categoryText = category.label.toLowerCase();
      const matches = (tag) =>
        !query || tag.label.toLowerCase().includes(query) || categoryText.includes(query);
      const matchingTags = category.tags.filter(matches);
      if (query && !matchingTags.length) continue;
      visibleSections += 1;

      const ids = selection[category.id] ?? [];
      const details = document.createElement("details");
      details.className = "tag-category";
      details.open = Boolean(query) || ids.length > 0 || category === categories[0];

      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent = category.label;
      const meta = document.createElement("span");
      meta.className = "tag-category-meta";
      meta.textContent = ids.length ? `${ids.length} selected` : `${category.tags.length} tags`;
      const clear = document.createElement("button");
      clear.type = "button";
      clear.className = "tag-clear";
      clear.textContent = "Clear";
      clear.disabled = !ids.length;
      clear.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!ids.length) return;
        delete selection[category.id];
        refresh();
      });
      summary.append(label, meta, clear);
      details.appendChild(summary);

      const tagWrap = document.createElement("div");
      tagWrap.className = "tag-options";
      for (const tag of matchingTags) {
        const isSelected = ids.includes(tag.id);
        const button = document.createElement("button");
        button.type = "button";
        button.className = `tag-chip${isSelected ? " selected" : ""}`;
        button.textContent = tag.label;
        button.setAttribute("aria-pressed", String(isSelected));
        button.addEventListener("click", () => {
          const current = Array.isArray(selection[category.id]) ? [...selection[category.id]] : [];
          if (current.includes(tag.id)) {
            const next = current.filter((id) => id !== tag.id);
            if (next.length) selection[category.id] = next;
            else delete selection[category.id];
          } else {
            selection[category.id] = category.multiple === false ? [tag.id] : [...current, tag.id];
          }
          refresh();
        });
        tagWrap.appendChild(button);
      }
      details.appendChild(tagWrap);
      sections.appendChild(details);
    }

    if (query && !visibleSections) {
      const empty = document.createElement("p");
      empty.className = "tag-empty";
      empty.textContent = `No tags match “${search.value.trim()}”.`;
      sections.appendChild(empty);
    }

    // Preserve selections whose tag was deleted or no longer applies to this
    // entity: show them as removable chips instead of silently dropping them.
    const unavailable = [];
    for (const [categoryId, tagIds] of Object.entries(selection)) {
      if (!Array.isArray(tagIds)) continue;
      for (const tagId of tagIds) {
        if (applicableIds.has(tagId)) continue;
        unavailable.push({ tagId, label: known.get(tagId)?.label ?? tagId });
      }
    }
    if (unavailable.length) {
      const details = document.createElement("details");
      details.className = "tag-category tag-unavailable";
      details.open = true;
      const summary = document.createElement("summary");
      const label = document.createElement("span");
      label.textContent = "Unavailable tags";
      const meta = document.createElement("span");
      meta.className = "tag-category-meta";
      meta.textContent = `${unavailable.length} kept`;
      summary.append(label, meta);
      details.appendChild(summary);
      const wrap = document.createElement("div");
      wrap.className = "tag-options";
      for (const item of unavailable) {
        wrap.appendChild(chip(item.tagId, item.label, {
          unavailable: true,
          onRemove: () => { removeTagId(selection, item.tagId); refresh(); },
        }));
      }
      details.appendChild(wrap);
      sections.appendChild(details);
    }
  }

  refresh();
  return () => selection;
}

function renderAgents() {
  clearNode(els.agentList);
  const scene = state.scenes.find((s) => s.key === state.selectedScene);
  for (const agent of state.agents) {
    const blocked = scene && !scene.participants.includes(agent.nickname);
    if (state.groupChat) {
      // Group chat: checkboxes to pick multiple AI responders.
      const row = document.createElement("label");
      row.className = "agent-row";
      const check = document.createElement("input");
      check.type = "checkbox";
      check.checked = state.groupCharacters.includes(agent.nickname);
      check.disabled = blocked || String(agent.role ?? "").trim().toLowerCase() === "user";
      check.addEventListener("change", () => {
        if (check.checked) {
          state.groupCharacters = [...state.groupCharacters, agent.nickname];
        } else {
          state.groupCharacters = state.groupCharacters.filter((n) => n !== agent.nickname);
        }
        updateComposer();
        saveUiState();
        renderChatBadges();
      });
      const name = document.createElement("span");
      name.textContent = agent.nickname;
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = agent.role || "character";
      row.append(check, name, role);
      els.agentList.appendChild(row);
    } else {
      // Single agent: existing radio-style selection.
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "agent-item" + (state.selectedAgent === agent.nickname ? " selected" : "");
      btn.disabled = blocked;
      const name = document.createElement("span");
      name.textContent = agent.nickname;
      const role = document.createElement("span");
      role.className = "role";
      role.textContent = agent.role || "character";
      btn.append(name, role);
      btn.addEventListener("click", () => selectAgent(agent));
      els.agentList.appendChild(btn);
    }
  }
}

function renderManageList() {
  clearNode(els.manageList);
  for (const agent of state.agents) {
    const item = document.createElement("div");
    item.className = "manage-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = agent.nickname;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => editCharacter(agent));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteCharacter(agent));
    item.append(name, edit, del);
    els.manageList.appendChild(item);
  }
}

function cardTypeLabel(type) {
  const labels = { world: "world", location_shift: "location shift", genre: "genre" };
  return labels[type] ?? String(type || "world").replace(/_/g, " ");
}

function renderCards() {
  clearNode(els.cardList);
  for (const card of state.cards) {
    const row = document.createElement("div");
    row.className = "card-row";
    const toggle = document.createElement("label");
    toggle.className = "card-toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = card.active;
    check.addEventListener("change", async () => {
      try {
        const data = await api(`/cards/${card.key}`, {
          method: "PATCH",
          body: JSON.stringify({ active: check.checked }),
        });
        const updated = data.card;
        state.cards = state.cards.map((c) => (c.key === updated.key ? updated : c));
        renderChatBadges();
      } catch (err) {
        check.checked = !check.checked;
        setChatStatus(`Card update failed: ${err.message}`, true);
      }
    });
    const name = document.createElement("span");
    name.className = "card-name";
    name.textContent = card.name;
    const type = document.createElement("span");
    type.className = "card-type";
    type.textContent = cardTypeLabel(card.type);
    toggle.append(check, name, type);
    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "4px";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openWorldCardModal(card));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn";
    del.textContent = "Delete";
    del.addEventListener("click", async () => {
      if (!confirm(`Delete world card "${card.name}"? This cannot be undone.`)) return;
      try {
        await api(`/cards/${card.key}`, { method: "DELETE" });
        state.cards = state.cards.filter((c) => c.key !== card.key);
        state.activeCards.delete(card.key);
        renderCards();
        renderChatBadges();
        setChatStatus(`Deleted card ${card.name}.`);
      } catch (err) {
        setChatStatus(`Card delete failed: ${err.message}`, true);
      }
    });
    actions.append(edit, del);
    row.append(toggle, actions);
    els.cardList.appendChild(row);
  }
}

function renderChatBadges() {
  const scene = state.scenes.find((s) => s.key === state.selectedScene);
  const scenario = scene ? scenarioForKey(scene.scenario) : null;
  if (scenario) {
    els.chatScenarioBadge.textContent = `Story: ${scenario.name}`;
    els.chatScenarioBadge.classList.remove("hidden");
  } else {
    els.chatScenarioBadge.classList.add("hidden");
  }
  if (scene) {
    els.chatSceneBadge.textContent = `Scene: ${scene.name}`;
    els.chatSceneBadge.classList.remove("hidden");
  } else {
    els.chatSceneBadge.classList.add("hidden");
  }
  const active = state.cards.filter((c) => c.active).map((c) => c.name);
  if (active.length) {
    els.chatCardsBadge.textContent = `Cards: ${active.join(", ")}`;
    els.chatCardsBadge.classList.remove("hidden");
  } else {
    els.chatCardsBadge.classList.add("hidden");
  }
  if (state.groupChat && state.groupCharacters.length) {
    els.chatGroupBadge.textContent = `Group: ${state.groupCharacters.join(", ")}`;
    els.chatGroupBadge.classList.remove("hidden");
  } else {
    els.chatGroupBadge.classList.add("hidden");
  }
}

function setChatStatus(text, isError = false) {
  els.chatStatus.textContent = text;
  els.chatStatus.classList.toggle("error", isError);
}

// ---------- Agents / scenes ----------
function selectAgent(agent) {
  state.selectedAgent = agent.nickname;
  els.chatAgentName.textContent = agent.nickname;
  els.chatAgentMeta.textContent = `${agent.age} · ${agent.role || "character"} — ${agent.personality.split(",")[0] || agent.personality}`;
  renderAgents();
  updateComposer();
  syncConversation({ note: `Conversation started with ${agent.nickname}.` });
  saveUiState();
}

function updateComposer() {
  const ready = state.groupChat
    ? state.groupCharacters.length > 0
    : Boolean(state.selectedAgent);
  els.messageInput.disabled = !ready;
  els.sendButton.disabled = !ready;
}

// ---------- Model selection (LM Studio) ----------
async function loadModels() {
  try {
    const response = await fetch(`${API_ROOT}/models`);
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || `Model list failed (${response.status})`);
    }
    const data = await response.json();
    state.models = data.models;
    state.selectedModel = data.models.includes(state.selectedModel)
      ? state.selectedModel
      : (data.defaultModel ?? data.models[0] ?? null);
    renderModels(`LM Studio connected — ${data.models.length} model(s) loaded.`);
  } catch (err) {
    state.models = [];
    state.selectedModel = null;
    renderModels(err.message);
  }
}

function renderModels(statusText) {
  clearNode(els.modelSelect);
  if (!state.models.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No models loaded";
    els.modelSelect.appendChild(option);
    els.modelSelect.disabled = true;
    setChatStatus(`LM Studio offline — ${statusText}`, true);
    return;
  }
  for (const id of state.models) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = id;
    option.selected = id === state.selectedModel;
    els.modelSelect.appendChild(option);
  }
  els.modelSelect.disabled = false;
  setChatStatus(statusText);
}

// ---------- Scene ----------
function scenarioForKey(key) {
  return state.scenarios.find((scenario) => scenario.key === key) ?? null;
}

// Quick chapter switcher shown above the messages. It only appears when the
// active scene belongs to a scenario with more than one chapter, so users can
// move Living Room → Kitchen without opening settings or the sidebar.
function populateChapterSelect() {
  const scene = state.scenes.find((s) => s.key === state.selectedScene);
  const scenario = scene ? scenarioForKey(scene.scenario) : null;
  const chapters = scenario
    ? state.scenes.filter((s) => s.scenario === scenario.key)
    : [];
  const show = Boolean(scene) && chapters.length > 1;
  els.chapterBar.classList.toggle("hidden", !show);
  if (!show) return;
  els.chapterStory.textContent = `📖 ${scenario.name}`;
  clearNode(els.chapterSelect);
  for (const chapter of chapters) {
    const option = document.createElement("option");
    option.value = chapter.key;
    option.textContent = chapter.name;
    els.chapterSelect.appendChild(option);
  }
  els.chapterSelect.value = scene.key;
}

// Route chapter changes through the same path as the sidebar scene selector so
// conversations, memories, participants, and badges follow the new scene.
function switchScene(sceneKey) {
  const scene = state.scenes.find((s) => s.key === sceneKey);
  if (!scene) return;
  state.selectedScenario = scene.scenario || null;
  refreshSceneSelect(sceneKey);
}

// Selecting a story is a shortcut into that story: keep the current chapter
// when it belongs to the story, otherwise open its first chapter. A story with
// no chapters yet leaves the workspace in free chat until one is linked.
function onScenarioChange() {
  state.selectedScenario = els.scenarioSelect.value || null;
  if (!state.selectedScenario) {
    refreshSceneSelect();
    return;
  }
  const scenario = scenarioForKey(state.selectedScenario);
  const chapters = state.scenes.filter((scene) => scene.scenario === state.selectedScenario);
  const current = state.scenes.find((scene) => scene.key === state.selectedScene);
  if (current && current.scenario === state.selectedScenario) {
    refreshSceneSelect();
  } else if (chapters.length) {
    refreshSceneSelect(chapters[0].key);
  } else {
    state.selectedScene = null;
    refreshSceneSelect();
    setChatStatus(`"${scenario?.name ?? "This scenario"}" has no chapters yet. Link scenes in Settings ▸ Scenes.`, true);
  }
}

function sceneOption(scene) {
  const option = document.createElement("option");
  option.value = scene.key;
  option.textContent = scene.name;
  return option;
}

// Scenario selector: "All scenarios" keeps every chapter visible, while a
// specific story narrows the scene list to that story's chapters.
function populateScenarioSelect() {
  clearNode(els.scenarioSelect);
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "All scenarios";
  els.scenarioSelect.appendChild(all);
  for (const scenario of state.scenarios) {
    const option = document.createElement("option");
    option.value = scenario.key;
    option.textContent = scenario.name;
    els.scenarioSelect.appendChild(option);
  }
  els.scenarioSelect.value = state.selectedScenario || "";
}

// Chapters are grouped under their scenario so the dashboard reflects the
// book/chapter hierarchy; unlinked scenes stay in their own group. When a
// scenario is selected, only its chapters (and free chat) are listed.
function populateScenes() {
  const visibleScenarios = state.selectedScenario
    ? state.scenarios.filter((scenario) => scenario.key === state.selectedScenario)
    : state.scenarios;
  const byScenario = new Map(visibleScenarios.map((scenario) => [scenario.key, []]));
  const standalone = [];
  for (const scene of state.scenes) {
    const group = scene.scenario ? byScenario.get(scene.scenario) : null;
    if (group) group.push(scene);
    else if (!state.selectedScenario) standalone.push(scene);
  }

  for (const scenario of visibleScenarios) {
    const scenes = byScenario.get(scenario.key);
    if (!scenes.length) continue;
    const group = document.createElement("optgroup");
    group.label = `📖 ${scenario.name}`;
    for (const scene of scenes) group.appendChild(sceneOption(scene));
    els.sceneSelect.appendChild(group);
  }

  if (standalone.length) {
    if (state.scenarios.length) {
      const group = document.createElement("optgroup");
      group.label = "Standalone scenes";
      for (const scene of standalone) group.appendChild(sceneOption(scene));
      els.sceneSelect.appendChild(group);
    } else {
      for (const scene of standalone) els.sceneSelect.appendChild(sceneOption(scene));
    }
  }
}

// Rebuilds the scene dropdown after scenario changes, keeping the current
// selection (or following a rename) when possible.
function refreshSceneSelect(newSelection = null) {
  if (newSelection) state.selectedScene = newSelection;
  if (state.selectedScenario && !state.scenarios.some((scenario) => scenario.key === state.selectedScenario)) {
    state.selectedScenario = null;
  }
  populateScenarioSelect();
  clearNode(els.sceneSelect);
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "No scene (free chat)";
  els.sceneSelect.appendChild(placeholder);
  populateScenes();
  if (state.selectedScene && !state.scenes.some((s) => s.key === state.selectedScene)) {
    state.selectedScene = null;
    els.sceneSelect.value = "";
  } else {
    els.sceneSelect.value = state.selectedScene || "";
  }
  onSceneChange();
}

function onSceneChange() {
  const previousSceneKey = state.selectedScene;
  state.selectedScene = els.sceneSelect.value || null;
  const sceneChanged = previousSceneKey !== state.selectedScene;
  const scene = state.scenes.find((s) => s.key === state.selectedScene);
  els.sceneNote.classList.toggle("hidden", !scene);
  if (scene) {
    const scenario = scenarioForKey(scene.scenario);
    const note = [
      scenario ? `Story: ${scenario.name}` : "Standalone scene",
      `Agents here: ${scene.participants.join(", ")} · ${scene.location || "somewhere"}${scene.world_card ? ` · card: ${scene.world_card}` : ""}`,
    ];
    els.sceneNote.textContent = note.join(" · ");
  }
  renderSceneParticipants(scene);

  if (state.groupChat) {
    // One room per scene: every AI participant in the scene can speak. Switch
    // scenes with all participants selected; keep manual choices within a room.
    const participants = scene ? scene.participants : [];
    const available = state.agents
      .filter((agent) => String(agent.role ?? "").trim().toLowerCase() !== "user")
      .filter((agent) => !scene || participants.includes(agent.nickname))
      .map((agent) => agent.nickname);
    if (sceneChanged || state.groupCharacters.length === 0) {
      state.groupCharacters = available;
    } else {
      state.groupCharacters = state.groupCharacters.filter((name) => available.includes(name));
      if (state.groupCharacters.length === 0) state.groupCharacters = available;
    }
    if (state.groupCharacters.length === 0) {
      els.chatAgentName.textContent = "Group chat — pick participants";
      els.chatAgentMeta.textContent = "";
    } else {
      els.chatAgentName.textContent = "Group chat";
      els.chatAgentMeta.textContent = state.groupCharacters.join(", ");
    }
    renderAgents();
    updateComposer();
    syncConversation({ force: true });
  } else {
    // Single agent: existing scene-participant logic.
    if (scene && state.selectedAgent && !scene.participants.includes(state.selectedAgent)) {
      const agent = state.agents.find((a) => a.nickname === state.selectedAgent);
      const first = state.agents.find((a) => scene.participants.includes(a.nickname));
      if (first) {
        selectAgent(first);
      } else {
        state.selectedAgent = null;
        els.chatAgentName.textContent = "Select an agent";
        els.chatAgentMeta.textContent = "";
        updateComposer();
        renderAgents();
        syncConversation({ force: true });
      }
      setChatStatus(`${agent?.nickname ?? "The agent"} is not part of "${scene.name}" — switched agents.`, true);
    } else {
      renderAgents();
      syncConversation({
        note: state.selectedAgent
          ? (scene ? `Scene changed to ${scene.name}.` : "Free chat.")
          : undefined,
      });
    }
  }
  renderChatBadges();
  populateChapterSelect();
  saveUiState();
}

// Per-scene agent selection (quick editor in the Scene panel).
// Toggling a checkbox immediately persists participants via PUT /scenes/:key.
function renderSceneParticipants(scene) {
  els.sceneParticipantsWrap.classList.toggle("hidden", !scene);
  if (!scene) return;
  clearNode(els.sceneParticipants);
  for (const agent of state.agents) {
    const row = document.createElement("label");
    row.className = "participant-toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = scene.participants.includes(agent.nickname);
    check.addEventListener("change", async () => {
      // Read the latest list from state: this closure's `scene` object is stale
      // after the previous toggle saved.
      const current = state.scenes.find((s) => s.key === scene.key) ?? scene;
      const currentParticipants = current.participants ?? [];
      const participants = check.checked
        ? [...currentParticipants, agent.nickname]
        : currentParticipants.filter((name) => name !== agent.nickname);
      if (participants.length === 0) {
        check.checked = true;
        setChatStatus("A scene needs at least one agent.", true);
        return;
      }
      try {
        const data = await api(`/scenes/${scene.key}`, {
          method: "PUT",
          body: JSON.stringify({ participants }),
        });
        state.scenes = state.scenes.map((s) => (s.key === scene.key ? { ...s, participants: data.scene.participants } : s));
        setChatStatus(`${agent.nickname} ${check.checked ? "joined" : "left"} "${data.scene.name}".`);
        if (state.selectedScene === scene.key) {
          renderSceneParticipants(state.scenes.find((s) => s.key === scene.key));
          if (state.selectedAgent && !data.scene.participants.includes(state.selectedAgent)) {
            const replacement = state.agents.find((a) => data.scene.participants.includes(a.nickname));
            if (replacement) {
              selectAgent(replacement);
            } else {
              state.selectedAgent = null;
              els.chatAgentName.textContent = "Select an agent";
              els.chatAgentMeta.textContent = "";
              updateComposer();
              syncConversation({ force: true });
            }
          }
        }
        renderAgents();
        renderChatBadges();
        saveUiState();
      } catch (err) {
        check.checked = !check.checked;
        setChatStatus(`Scene update failed: ${err.message}`, true);
      }
    });
    const name = document.createElement("span");
    name.textContent = agent.nickname;
    row.append(check, name);
    els.sceneParticipants.appendChild(row);
  }
}

// ---------- Scene CRUD (Settings ▸ Scenes) ----------
function renderSceneList() {
  clearNode(els.sceneList);
  for (const scene of state.scenes) {
    const item = document.createElement("div");
    item.className = "manage-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = scene.name;
    const scenario = scenarioForKey(scene.scenario);
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = scenario ? scenario.name : "Standalone";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openSceneModal(scene));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteSceneRecord(scene));
    item.append(name, meta, edit, del);
    els.sceneList.appendChild(item);
  }
}

let editingSceneKey = null; // null = create, string = existing scene key
let editingSceneTags = {};

function openSceneModal(scene = null) {
  editingSceneKey = scene ? scene.key : "";
  editingSceneTags = cloneSelections(scene?.tag_selections);
  els.sceneModalTitle.textContent = scene ? `Edit ${scene.name}` : "New scene";
  els.sceneFormError.classList.add("hidden");
  els.sceneForm.reset();
  clearNode(els.sceneFormParticipants);
  for (const agent of state.agents) {
    const row = document.createElement("label");
    row.className = "participant-toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "participant";
    check.value = agent.nickname;
    check.checked = scene ? scene.participants.includes(agent.nickname) : false;
    const name = document.createElement("span");
    name.textContent = agent.nickname;
    row.append(check, name);
    els.sceneFormParticipants.appendChild(row);
  }
  const scenarioSelect = els.sceneForm.elements.namedItem("scenario");
  while (scenarioSelect.options.length > 1) scenarioSelect.remove(1);
  for (const scenario of state.scenarios) {
    const option = document.createElement("option");
    option.value = scenario.key;
    option.textContent = scenario.name;
    scenarioSelect.appendChild(option);
  }
  const activeScene = state.scenes.find((s) => s.key === state.selectedScene);
  scenarioSelect.value = scene ? (scene.scenario ?? "") : (activeScene?.scenario ?? "");
  const cardSelect = els.sceneForm.elements.namedItem("world_card");
  while (cardSelect.options.length > 1) cardSelect.remove(1);
  for (const card of state.cards) {
    const option = document.createElement("option");
    option.value = card.key;
    option.textContent = card.name;
    cardSelect.appendChild(option);
  }
  if (scene) {
    els.sceneForm.elements.namedItem("name").value = scene.name;
    els.sceneForm.elements.namedItem("description").value = scene.description || "";
    els.sceneForm.elements.namedItem("location").value = scene.location || "";
    const cardValue = state.cards.find((c) => c.name === scene.world_card || c.key === scene.world_card);
    cardSelect.value = cardValue ? cardValue.key : "";
  } else {
    cardSelect.value = "";
  }
  renderTagPicker(els.sceneTags, "scene", editingSceneTags);
  els.sceneModal.classList.remove("hidden");
  els.sceneForm.elements.namedItem("name").focus();
}

function closeSceneModal() {
  els.sceneModal.classList.add("hidden");
}

function showSceneFormError(message) {
  els.sceneFormError.textContent = message;
  els.sceneFormError.classList.remove("hidden");
}

async function submitSceneForm(event) {
  event.preventDefault();
  const selected = [...els.sceneForm.elements.namedItem("participant")]
    .filter((check) => check.checked)
    .map((check) => check.value);
  const cardValue = els.sceneForm.elements.namedItem("world_card").value;
  const scenarioValue = els.sceneForm.elements.namedItem("scenario").value;
  const payload = {
    name: String(els.sceneForm.elements.namedItem("name").value || "").trim(),
    description: String(els.sceneForm.elements.namedItem("description").value || "").trim(),
    location: String(els.sceneForm.elements.namedItem("location").value || "").trim(),
    world_card: cardValue || null,
    scenario: scenarioValue || null,
    participants: selected,
    tag_selections: editingSceneTags,
  };
  const editingKey = editingSceneKey || "";
  try {
    let selectedKey = editingKey || null;
    if (editingKey) {
      const data = await api(`/scenes/${editingKey}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      selectedKey = data.scene.key;
    } else {
      const data = await api("/scenes", { method: "POST", body: JSON.stringify(payload) });
      selectedKey = data.scene.key;
    }
    closeSceneModal();
    setChatStatus(editingKey ? "Scene updated." : "Scene created.");
    await reloadWorkspace(selectedKey);
  } catch (err) {
    showSceneFormError(err.message);
  }
}

async function deleteSceneRecord(scene) {
  const confirmed = window.confirm(
    `Delete scene "${scene.name}"? This removes house/scenes/${scene.key}.yaml permanently.`,
  );
  if (!confirmed) return;
  try {
    await api(`/scenes/${scene.key}`, { method: "DELETE" });
    if (state.selectedScene === scene.key) {
      state.selectedScene = null;
      els.sceneSelect.value = "";
      // Scene is gone — refresh filtering back to free chat.
      renderAgents();
      syncConversation({ force: true, note: state.selectedAgent ? "Scene removed." : undefined });
      saveUiState();
    }
    setChatStatus(`Deleted scene ${scene.name}.`);
    await reloadWorkspace();
  } catch (err) {
    setChatStatus(`Delete failed: ${err.message}`, true);
  }
}

// ---------- Scenario CRUD (Settings ▸ Scenarios) ----------
const SCENARIO_STORY_FIELDS = [
  "genre",
  "tone",
  "themes",
  "premise",
  "relationship_dynamics",
  "central_conflict",
  "narrative_direction",
  "background",
  "long_term_objectives",
  "opening_message",
];

let editingScenarioKey = null; // null/"" = create, string = existing scenario key
let editingScenarioTags = {};

function renderScenarioManageList() {
  clearNode(els.scenarioList);
  for (const scenario of state.scenarios) {
    const item = document.createElement("div");
    item.className = "manage-item";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = scenario.name;
    const count = state.scenes.filter((scene) => scene.scenario === scenario.key).length;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${count} scene${count === 1 ? "" : "s"}`;
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "icon-btn";
    edit.textContent = "Edit";
    edit.addEventListener("click", () => openScenarioModal(scenario));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn danger";
    del.textContent = "Delete";
    del.addEventListener("click", () => deleteScenarioRecord(scenario));
    item.append(name, meta, edit, del);
    els.scenarioList.appendChild(item);
  }
}

function refreshScenarioScenesAll() {
  const boxes = [...els.scenarioFormScenes.querySelectorAll('input[name="scene"]')];
  const checked = boxes.filter((box) => box.checked).length;
  els.scenarioScenesAll.checked = boxes.length > 0 && checked === boxes.length;
  els.scenarioScenesAll.indeterminate = checked > 0 && checked < boxes.length;
}

// Lists every scene so a story can claim several chapters at once. Scenes owned
// by another scenario are labelled, and selecting them here reassigns ownership.
function renderScenarioSceneChoices(scenario) {
  clearNode(els.scenarioFormScenes);
  for (const scene of state.scenes) {
    const row = document.createElement("label");
    row.className = "participant-toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "scene";
    check.value = scene.key;
    check.checked = Boolean(scenario) && scene.scenario === scenario.key;
    check.addEventListener("change", refreshScenarioScenesAll);
    const label = document.createElement("span");
    const currentOwner = scene.scenario && (!scenario || scene.scenario !== scenario.key)
      ? scenarioForKey(scene.scenario)
      : null;
    label.textContent = currentOwner
      ? `${scene.name} (in ${currentOwner.name})`
      : scene.name;
    row.append(check, label);
    els.scenarioFormScenes.appendChild(row);
  }
  refreshScenarioScenesAll();
}

function openScenarioModal(scenario = null) {
  editingScenarioKey = scenario ? scenario.key : "";
  editingScenarioTags = cloneSelections(scenario?.tag_selections);
  els.scenarioModalTitle.textContent = scenario ? `Edit ${scenario.name}` : "New scenario";
  els.scenarioFormError.classList.add("hidden");
  els.scenarioForm.reset();
  const field = (fieldName) => els.scenarioForm.elements.namedItem(fieldName);

  const cardSelect = field("world_card");
  while (cardSelect.options.length > 1) cardSelect.remove(1);
  for (const card of state.cards) {
    const option = document.createElement("option");
    option.value = card.key;
    option.textContent = card.name;
    cardSelect.appendChild(option);
  }

  clearNode(els.scenarioFormParticipants);
  for (const agent of state.agents) {
    const row = document.createElement("label");
    row.className = "participant-toggle";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.name = "participant";
    check.value = agent.nickname;
    check.checked = scenario ? scenario.participants.includes(agent.nickname) : false;
    const label = document.createElement("span");
    label.textContent = agent.nickname;
    row.append(check, label);
    els.scenarioFormParticipants.appendChild(row);
  }

  renderScenarioSceneChoices(scenario);

  if (scenario) {
    field("name").value = scenario.name;
    field("description").value = scenario.description || "";
    for (const name of SCENARIO_STORY_FIELDS) {
      field(name).value = scenario.extras?.[name] ?? "";
    }
    const cardValue = state.cards.find(
      (card) => card.name === scenario.world_card || card.key === scenario.world_card,
    );
    cardSelect.value = cardValue ? cardValue.key : "";
  } else {
    cardSelect.value = "";
  }

  renderTagPicker(els.scenarioTags, "scenario", editingScenarioTags);
  els.scenarioModal.classList.remove("hidden");
  field("name").focus();
}

function closeScenarioModal() {
  els.scenarioModal.classList.add("hidden");
}

async function submitScenarioForm(event) {
  event.preventDefault();
  const field = (fieldName) => els.scenarioForm.elements.namedItem(fieldName);
  const participants = [...els.scenarioForm.elements.namedItem("participant")]
    .filter((check) => check.checked)
    .map((check) => check.value);
  const scenes = [...els.scenarioFormScenes.querySelectorAll('input[name="scene"]')]
    .filter((check) => check.checked)
    .map((check) => check.value);
  const payload = {
    name: String(field("name").value || "").trim(),
    description: String(field("description").value || "").trim(),
    world_card: field("world_card").value || null,
    participants,
    scenes,
    tag_selections: editingScenarioTags,
  };
  for (const name of SCENARIO_STORY_FIELDS) {
    payload[name] = String(field(name).value || "").trim();
  }

  const editingKey = editingScenarioKey || "";
  try {
    if (editingKey) {
      await api(`/scenarios/${editingKey}`, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/scenarios", { method: "POST", body: JSON.stringify(payload) });
    }
    closeScenarioModal();
    setChatStatus(editingKey ? "Scenario updated." : "Scenario created.");
    await reloadWorkspace(state.selectedScene);
  } catch (err) {
    els.scenarioFormError.textContent = err.message;
    els.scenarioFormError.classList.remove("hidden");
  }
}

async function deleteScenarioRecord(scenario) {
  const count = state.scenes.filter((scene) => scene.scenario === scenario.key).length;
  const confirmed = window.confirm(
    `Delete scenario "${scenario.name}"? ${count} linked scene${count === 1 ? "" : "s"} will become standalone. ` +
    `This removes house/scenarios/${scenario.key}.yaml permanently.`,
  );
  if (!confirmed) return;
  try {
    await api(`/scenarios/${scenario.key}`, { method: "DELETE" });
    setChatStatus(`Deleted scenario ${scenario.name}. Linked scenes are now standalone.`);
    await reloadWorkspace(state.selectedScene);
  } catch (err) {
    setChatStatus(`Delete failed: ${err.message}`, true);
  }
}

// ---------- Cards ----------
let editingCardKey = null; // null = create, string = existing card key
let editingCardTags = {};

function syncActiveCardState() {
  state.activeCards = new Set(state.cards.filter((c) => c.active).map((c) => c.key));
}

// ---------- Chat ----------
function renderConversation(note) {
  clearNode(els.messages);
  for (let i = 0; i < history.length; i++) {
    const entry = history[i];
    appendMessage(
      entry.role === "user" ? "user" : "assistant",
      entry.role === "assistant" ? (entry.name || state.selectedAgent) : null,
      entry.content,
      i,
    );
  }
  if (!history.length && note) {
    const el = document.createElement("div");
    el.className = "message system-note";
    el.textContent = note;
    els.messages.appendChild(el);
  }
}

// Switches to the conversation saved for the current agent + scene. Repeat
// calls for the same pair are no-ops so unrelated workspace reloads keep chat.
function syncConversation({ note, force = false } = {}) {
  const key = conversationKey();
  if (!force && key === activeConversationKey) return;
  activeConversationKey = key;
  history.length = 0;
  if (key) {
    const saved = readJsonStorage(CHAT_STORAGE_KEY)[key];
    if (Array.isArray(saved)) {
      history.push(...saved
        .filter((entry) => entry && ["user", "assistant"].includes(entry.role) && typeof entry.content === "string")
        .slice(-50));
    }
  }
  renderConversation(note);
}

function appendMessage(kind, author, text, index = null) {
  const el = document.createElement("div");
  el.className = `message ${kind}`;
  if (index !== null && index !== undefined) {
    el.dataset.msgIndex = String(index);
  }

  if (author) {
    const who = document.createElement("span");
    who.className = "author";
    who.textContent = author;
    el.appendChild(who);
  }

  const body = document.createElement("span");
  body.className = "message-body";
  body.textContent = text || "";
  el.appendChild(body);

  if (index !== null && index !== undefined) {
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "message-edit-btn";
    editBtn.title = "Edit message";
    editBtn.setAttribute("aria-label", "Edit message");
    editBtn.innerHTML = "&#9998;";
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      startEditMessage(el, index);
    });
    el.appendChild(editBtn);
  }

  els.messages.appendChild(el);
  els.messages.scrollTop = els.messages.scrollHeight;
  return body;
}

function trimHistory() {
  while (history.length > 50) history.shift();
}

function setBusy(busy) {
  els.sendButton.disabled = busy;
  els.messageInput.disabled = busy;
}

function startEditMessage(messageEl, index) {
  if (index < 0 || index >= history.length) return;
  if (els.sendButton.disabled && els.messageInput.disabled && history[index]?.role === "assistant") {
    // allow editing but be gentle about busy state? just allow
  }

  const body = messageEl.querySelector(".message-body");
  const editBtn = messageEl.querySelector(".message-edit-btn");
  if (!body || messageEl.querySelector(".message-edit-form")) return;

  if (editBtn) editBtn.style.display = "none";
  const originalText = history[index].content || "";

  const form = document.createElement("form");
  form.className = "message-edit-form";
  form.addEventListener("click", (e) => e.stopPropagation());

  const textarea = document.createElement("textarea");
  textarea.className = "message-edit-textarea";
  textarea.value = originalText;
  textarea.rows = Math.max(2, Math.min(8, originalText.split("\n").length + 1));

  const actions = document.createElement("div");
  actions.className = "message-edit-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "submit";
  saveBtn.className = "btn primary small";
  saveBtn.textContent = "Save";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn ghost small";
  cancelBtn.textContent = "Cancel";
  cancelBtn.addEventListener("click", () => {
    form.remove();
    if (editBtn) editBtn.style.display = "";
    body.style.display = "";
  });

  actions.append(saveBtn, cancelBtn);
  form.append(textarea, actions);
  body.style.display = "none";
  messageEl.appendChild(form);
  textarea.focus();
  textarea.select();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const newText = textarea.value.trim();
    if (!newText) {
      cancelBtn.click();
      return;
    }
    if (newText === originalText.trim()) {
      cancelBtn.click();
      return;
    }
    await commitEditMessage(index, newText);
  });
}

async function commitEditMessage(index, newText) {
  if (index < 0 || index >= history.length) return;
  const entry = history[index];
  const isUser = entry.role === "user";
  const conversation = activeConversationKey;

  entry.content = newText;
  persistConversation(conversation);

  if (isUser) {
    // Truncate after this message and regenerate response
    history.splice(index + 1);
    trimHistory();
    persistConversation(conversation);
    renderConversation();
    setBusy(true);
    els.messageInput.value = "";
    const isGroup = state.groupChat && state.groupCharacters.length > 0;
    if (isGroup) {
      await sendGroupMessage(newText, conversation);
    } else if (state.selectedAgent) {
      await sendSingleMessage(newText, state.selectedAgent, conversation);
    }
    setBusy(false);
    els.messageInput.focus();
  } else {
    // Edit assistant message in place
    renderConversation();
    setChatStatus("Message updated.");
  }
}

async function sendMessage(event) {
  event.preventDefault();
  const message = els.messageInput.value.trim();
  const isGroup = state.groupChat && state.groupCharacters.length > 0;
  if (!message || (!state.selectedAgent && !isGroup)) return;

  els.messageInput.value = "";
  setBusy(true);
  const userIndex = history.length;
  appendMessage("user", null, message, userIndex);
  history.push({ role: "user", content: message });
  trimHistory();
  const conversation = activeConversationKey;
  persistConversation(conversation);

  if (isGroup) {
    await sendGroupMessage(message, conversation);
  } else {
    await sendSingleMessage(message, state.selectedAgent, conversation);
  }
  setBusy(false);
  els.messageInput.focus();
}

async function sendSingleMessage(message, agentName, conversation) {
  const replyIndex = history.length;
  const replyBody = appendMessage("assistant", agentName, "", replyIndex);
  setChatStatus(`${agentName} is typing…`);
  let fullText = "";
  try {
    const response = await fetch(`${API_ROOT}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        agentNickname: agentName,
        sceneName: state.selectedScene,
        message,
        model: state.selectedModel || undefined,
        history: history.slice(0, -1),
        activeCards: state.cards.filter((c) => c.active).map((c) => c.key),
      }),
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || `Chat failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.type === "delta") {
          fullText += chunk.text;
          replyBody.textContent = fullText;
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (chunk.type === "done") {
          fullText = chunk.text;
          replyBody.textContent = fullText;
        } else if (chunk.type === "error") {
          throw new Error(chunk.error || "The model request failed.");
        }
      }
    }
    if (!fullText) {
      replyBody.textContent = fullText = "(no response — check that LM Studio is running)";
      setChatStatus("Empty reply. Is LM Studio running with a model loaded?", true);
      history.pop();
      persistConversation(conversation);
    } else {
      history.push({ role: "assistant", content: fullText, name: agentName });
      trimHistory();
      persistConversation(conversation);
      renderConversation();
      setChatStatus("");
      loadMemories();
    }
  } catch (err) {
    history.pop();
    persistConversation(conversation);
    setChatStatus(err.message, true);
  }
}

async function sendGroupMessage(message, conversation) {
  const speakers = [...state.groupCharacters];
  setChatStatus(`${speakers.join(", ")} are responding…`);
  const replyBodies = {};
  const bubbles = {};
  let allResponses = [];
  let streamError = null;

  // Bubbles appear only for characters who actually speak, so a [PASS] or a
  // duplicate reply does not leave an empty bubble in the shared timeline.
  function bubbleFor(speaker) {
    if (!replyBodies[speaker]) {
      const replyIndex = history.length;
      const body = appendMessage("assistant", speaker, "", replyIndex);
      replyBodies[speaker] = body;
      bubbles[speaker] = body.parentElement;
      bubbles[speaker].dataset.msgIndex = String(replyIndex);
    }
    return replyBodies[speaker];
  }

  function dropBubble(speaker) {
    if (bubbles[speaker]) {
      bubbles[speaker].remove();
      delete bubbles[speaker];
      delete replyBodies[speaker];
    }
  }

  try {
    const response = await fetch(`${API_ROOT}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        characterNicknames: speakers,
        sceneName: state.selectedScene,
        message,
        model: state.selectedModel || undefined,
        history: history.slice(0, -1),
        activeCards: state.cards.filter((c) => c.active).map((c) => c.key),
      }),
    });
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.message || `Group chat failed (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        let chunk;
        try { chunk = JSON.parse(line); } catch { continue; }
        if (chunk.type === "delta") {
          const body = bubbleFor(chunk.speaker);
          body.textContent += chunk.text;
          els.messages.scrollTop = els.messages.scrollHeight;
        } else if (chunk.type === "done") {
          bubbleFor(chunk.speaker).textContent = chunk.text;
          allResponses.push({ speaker: chunk.speaker, text: chunk.text });
          setChatStatus(`${allResponses.length}/${speakers.length} responded`);
        } else if (chunk.type === "skip") {
          dropBubble(chunk.speaker);
        } else if (chunk.type === "error") {
          streamError = chunk.error || "The group chat request failed.";
        }
      }
    }
    if (allResponses.length === 0) {
      setChatStatus(streamError || "No responses — check that LM Studio is running.", true);
      history.pop();
      persistConversation(conversation);
    } else {
      for (const r of allResponses) {
        history.push({ role: "assistant", content: r.text, name: r.speaker });
      }
      trimHistory();
      persistConversation(conversation);
      renderConversation();
      setChatStatus(streamError || "");
      if (streamError) els.chatStatus.classList.add("error");
      loadMemories();
    }
  } catch (err) {
    history.pop();
    persistConversation(conversation);
    setChatStatus(err.message, true);
  }
}

// ---------- Character CRUD (T-5.1–T-5.5) ----------
let editingKey = null; // null = create, string = existing key
let editingTags = {}; // tag_selections for the character form

function cloneSelections(value) {
  const copy = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return copy;
  for (const [categoryId, ids] of Object.entries(value)) {
    if (Array.isArray(ids) && ids.length) {
      copy[categoryId] = ids.filter((id) => typeof id === "string" && id.trim());
    }
  }
  return copy;
}

function openCharacterModal(agent = null) {
  editingKey = agent ? agentKey(agent.nickname) : null;
  editingTags = cloneSelections(agent?.tag_selections);
  els.modalTitle.textContent = agent ? `Edit ${agent.nickname}` : "New character";
  els.formError.classList.add("hidden");
  els.form.reset();
  if (agent) {
    els.form.elements.namedItem("nickname").value = agent.nickname;
    els.form.elements.namedItem("gender").value = agent.gender;
    els.form.elements.namedItem("age").value = agent.age;
    els.form.elements.namedItem("personality").value = agent.personality;
    els.form.elements.namedItem("appearance").value = agent.appearance;
    els.form.elements.namedItem("role").value = agent.role ?? "";
    els.form.elements.namedItem("system_prompt").value = agent.system_prompt ?? "";
    els.form.elements.namedItem("memory_enabled").checked = agent.memory_enabled !== false;
  }
  renderTagPicker(els.characterTags, "character", editingTags);
  els.modal.classList.remove("hidden");
  els.form.elements.namedItem("nickname").focus();
}

// Loads the full agent definition (incl. system_prompt) then opens the editor.
async function editCharacter(agent) {
  try {
    const data = await api(`/characters/${agentKey(agent.nickname)}`);
    openCharacterModal(data.agent);
  } catch {
    openCharacterModal(agent);
  }
}

function closeCharacterModal() {
  els.modal.classList.add("hidden");
}

function showFormError(message) {
  els.formError.textContent = message;
  els.formError.classList.remove("hidden");
}

async function submitCharacterForm(event) {
  event.preventDefault();
  const formData = new FormData(els.form);
  const payload = {
    nickname: String(formData.get("nickname") || "").trim(),
    gender: String(formData.get("gender") || "").trim(),
    age: Number(formData.get("age")),
    personality: String(formData.get("personality") || "").trim(),
    appearance: String(formData.get("appearance") || "").trim(),
    role: String(formData.get("role") || "").trim() || undefined,
    system_prompt: String(formData.get("system_prompt") || "").trim() || undefined,
    memory_enabled: els.form.elements.namedItem("memory_enabled").checked,
    tag_selections: editingTags,
  };
  try {
    if (editingKey) {
      await api(`/characters/${editingKey}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
    } else {
      await api("/characters", {
        method: "POST",
        body: JSON.stringify(payload),
      });
    }
    closeCharacterModal();
    setChatStatus(editingKey ? "Character updated." : "Character created.");
    await boot(); // reload agent lists
  } catch (err) {
    showFormError(err.message);
  }
}

async function deleteCharacter(agent) {
  const confirmed = window.confirm(
    `Delete "${agent.nickname}"? This removes house/characters/${agentKey(agent.nickname)}.yaml permanently.`,
  );
  if (!confirmed) return;
  try {
    await api(`/characters/${agentKey(agent.nickname)}`, { method: "DELETE" });
    if (state.selectedAgent === agent.nickname) {
      state.selectedAgent = null;
      els.chatAgentName.textContent = "Select an agent";
      els.chatAgentMeta.textContent = "";
      syncConversation({ force: true });
      saveUiState();
      updateComposer();
    }
    setChatStatus(`Deleted ${agent.nickname}.`);
    await boot();
  } catch (err) {
    setChatStatus(`Delete failed: ${err.message}`, true);
  }
}

// ---------- Memories (dashboard) ----------
async function loadMemories() {
  try {
    const data = await api("/memories");
    state.memories = data.scenarios;
    renderMemories();
  } catch (err) {
    setChatStatus(`Memories failed to load: ${err.message}`, true);
  }
}

function memoryCount(scenario) {
  return scenario.scenes.reduce(
    (total, scene) =>
      total + scene.characters.reduce((sum, character) => sum + character.memories.length, 0),
    0,
  );
}

// The dashboard mirrors the book → chapter → character structure of the vault.
function renderMemories() {
  const keep = els.memoryScenarioSelect.value;
  clearNode(els.memoryScenarioSelect);
  const allOption = document.createElement("option");
  allOption.value = "";
  allOption.textContent = "All stories";
  els.memoryScenarioSelect.appendChild(allOption);
  for (const scenario of state.memories) {
    const option = document.createElement("option");
    option.value = scenario.scenario;
    option.textContent = `${scenario.name} (${memoryCount(scenario)})`;
    els.memoryScenarioSelect.appendChild(option);
  }
  els.memoryScenarioSelect.value =
    state.memories.some((scenario) => scenario.scenario === keep) ? keep : "";

  clearNode(els.memoryList);
  const scenarios = state.memories.filter(
    (scenario) => !els.memoryScenarioSelect.value || scenario.scenario === els.memoryScenarioSelect.value,
  );
  let rendered = 0;
  for (const scenario of scenarios) {
    const storyHeader = document.createElement("div");
    storyHeader.className = "memory-scenario";
    storyHeader.textContent = `📖 ${scenario.name}`;
    els.memoryList.appendChild(storyHeader);

    for (const scene of scenario.scenes) {
      const sceneHeader = document.createElement("div");
      sceneHeader.className = "memory-scene";
      sceneHeader.textContent = `🎬 ${scene.name}`;
      els.memoryList.appendChild(sceneHeader);

      for (const group of scene.characters) {
        const header = document.createElement("div");
        header.className = "memory-character";
        header.textContent = group.name;
        els.memoryList.appendChild(header);

        for (const entry of group.memories) {
          rendered += 1;
          const item = document.createElement("div");
          item.className = "memory-entry";

          const top = document.createElement("div");
          top.className = "memory-top";
          const date = document.createElement("span");
          date.className = "memory-date";
          date.textContent = entry.date;
          const score = document.createElement("span");
          score.className = "memory-importance";
          score.textContent = `★ ${entry.importance}`;
          top.append(date, score);

          const preview = document.createElement("p");
          preview.className = "memory-preview";
          // Show the complete day's exchanges; CSS clamps until clicked.
          preview.textContent = entry.content || entry.preview;
          preview.title = "Click to expand/collapse";
          preview.addEventListener("click", () => preview.classList.toggle("expanded"));

          const del = document.createElement("button");
          del.type = "button";
          del.className = "icon-btn danger memory-delete";
          del.textContent = "Delete";
          del.addEventListener("click", () =>
            deleteMemoryEntry(entry, `${group.name} · ${scene.name} · ${scenario.name}`));

          item.append(top, preview, del);
          els.memoryList.appendChild(item);
        }
      }
    }
  }
  if (!rendered) {
    const empty = document.createElement("p");
    empty.className = "note";
    empty.textContent = "No memories yet — chat with an agent to create some.";
    els.memoryList.appendChild(empty);
  }
}

async function deleteMemoryEntry(entry, label) {
  const confirmed = window.confirm(
    `Delete the ${entry.date} memory of ${label}? This cannot be undone.`,
  );
  if (!confirmed) return;
  try {
    const encoded = entry.path.split("/").map(encodeURIComponent).join("/");
    await api(`/memories/${encoded}`, { method: "DELETE" });
    setChatStatus(`Deleted ${entry.path}.md memory.`);
    await loadMemories();
  } catch (err) {
    setChatStatus(`Memory delete failed: ${err.message}`, true);
  }
}

// ---------- Settings (lower-left) ----------
function toggleSettingsMenu(force) {
  const show = force ?? els.settingsMenu.classList.contains("hidden");
  els.settingsMenu.classList.toggle("hidden", !show);
  els.settingsToggle.classList.toggle("active", show);
}

function closeSettingsMenu() {
  toggleSettingsMenu(false);
}

function openCharactersFromSettings() {
  closeSettingsMenu();
  els.charactersModal.classList.remove("hidden");
  renderManageList();
}

function closeCharactersModal() {
  els.charactersModal.classList.add("hidden");
}

function openScenariosFromSettings() {
  closeSettingsMenu();
  els.scenariosModal.classList.remove("hidden");
  renderScenarioManageList();
}

function closeScenariosModal() {
  els.scenariosModal.classList.add("hidden");
}

function openScenesFromSettings() {
  closeSettingsMenu();
  els.scenesModal.classList.remove("hidden");
  renderSceneList();
}

function closeScenesModal() {
  els.scenesModal.classList.add("hidden");
}

function openCardsModal() {
  closeSettingsMenu();
  els.cardsModal.classList.remove("hidden");
  renderCards();
}

function closeCardsModal() {
  els.cardsModal.classList.add("hidden");
}

function openMemoriesModal() {
  closeSettingsMenu();
  els.memoriesModal.classList.remove("hidden");
  loadMemories();
}

function closeMemoriesModal() {
  els.memoriesModal.classList.add("hidden");
}

function openThemeModal() {
  closeSettingsMenu();
  if (!els.themeModal) return;
  els.themeModal.classList.remove("hidden");
  // Update selected state
  const current = (() => {
    try {
      return localStorage.getItem(THEME_STORAGE_KEY) || "system";
    } catch {
      return "system";
    }
  })();
  document.querySelectorAll(".theme-option").forEach((btn) => {
    if (btn.dataset.themeValue === current) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

function closeThemeModal() {
  if (els.themeModal) {
    els.themeModal.classList.add("hidden");
  }
}

function openHelpFromSettings() {
  closeSettingsMenu();
  els.helpModal.classList.remove("hidden");
  updateHelpStatus();
}

async function updateHelpStatus() {
  try {
    const response = await fetch(`${API_ROOT}/health`);
    const data = await response.json();
    const provider = data.provider || "lmstudio";
    const providerName = provider === "ollama" ? "Ollama" : "LM Studio";
    const llm = data.llm || data.lmStudio || {};
    const baseUrl = data.baseUrl || data.lmStudioBaseUrl || "";
    const hint = provider === "ollama" 
      ? "OFFLINE — run ollama serve and ollama pull <model>"
      : "OFFLINE — run lms server start and load a model";
    els.helpStatus.textContent = `Backend: ${baseUrl} · Server: running · ${providerName}: ${llm.reachable ? `connected (${llm.models.length} model(s) loaded)` : hint}`;
  } catch (err) {
    els.helpStatus.textContent = `Server unreachable: ${err.message}`;
  }
}

function closeHelpModal() {
  els.helpModal.classList.add("hidden");
}

// ---------- End session (Settings ▸ End session) ----------
let endingSession = false;

async function endSession() {
  closeSettingsMenu();
  if (endingSession) return;
  const confirmed = window.confirm(
    "Stop the Chatbot server? The chat will disconnect until you run start.bat again.",
  );
  if (!confirmed) return;
  endingSession = true;
  setChatStatus("Stopping the Chatbot server…");
  try {
    await api("/shutdown", { method: "POST", body: "{}" });
  } catch {
    // The socket can close before the acknowledgement is readable; that still
    // means the server is stopping.
  }
  els.shutdownOverlay.classList.remove("hidden");
}

// ---------- Boot ----------
async function reloadWorkspace(newSceneKey = null) {
  const [agentsData, scenesData, scenariosData, cardsData, tagsData] = await Promise.all([
    api("/agents"),
    api("/scenes"),
    api("/scenarios"),
    api("/cards"),
    api("/tags").catch(() => ({ categories: [] })),
  ]);
  state.agents = agentsData.agents;
  state.scenes = scenesData.scenes;
  state.scenarios = scenariosData.scenarios;
  state.cards = cardsData.cards;
  state.tagCatalog = tagsData.categories ?? [];
  if (newSceneKey) {
    const nextScene = state.scenes.find((scene) => scene.key === newSceneKey);
    if (nextScene) state.selectedScenario = nextScene.scenario || null;
  }
  // A selected agent may have been renamed or deleted elsewhere.
  if (state.selectedAgent && !state.agents.some((agent) => agent.nickname === state.selectedAgent)) {
    state.selectedAgent = null;
    els.chatAgentName.textContent = "Select an agent";
    els.chatAgentMeta.textContent = "";
    syncConversation({ force: true });
  }
  refreshSceneSelect(newSceneKey);
  syncActiveCardState();
  renderAgents();
  renderManageList();
  renderSceneList();
  renderScenarioManageList();
  renderCards();
  renderChatBadges();
  updateComposer();
}

async function boot() {
  const saved = readUiState();
  // The desktop preference is remembered; a phone-sized viewport always starts
  // with the overlay drawer closed so it never covers the chat on load.
  sidebarCollapsed = SIDEBAR_MOBILE.matches
    ? true
    : (typeof saved.sidebarCollapsed === "boolean" ? saved.sidebarCollapsed : false);
  applySidebarState();
  if (saved.scenario) state.selectedScenario = saved.scenario;
  if (saved.scene) state.selectedScene = saved.scene;
  if (saved.model) state.selectedModel = saved.model;
  if (saved.groupChat) {
    state.groupChat = true;
    state.groupCharacters = Array.isArray(saved.groupCharacters) ? saved.groupCharacters : [];
    els.groupChatToggle.checked = true;
  }
  await reloadWorkspace();
  // Restore the last agent only when it still exists and belongs to the scene.
  const scene = state.scenes.find((s) => s.key === state.selectedScene);
  const agent = saved.agent ? state.agents.find((a) => a.nickname === saved.agent) : null;
  if (!state.groupChat && agent && (!scene || scene.participants.includes(agent.nickname))) {
    selectAgent(agent);
  } else if (state.groupChat) {
    // Re-render agents with checkboxes reflecting restored group characters.
    renderAgents();
    els.chatAgentName.textContent = "Group chat";
    els.chatAgentMeta.textContent = state.groupCharacters.join(", ");
  }
  await loadModels();
  await loadMemories();
  saveUiState();
}

els.composer.addEventListener("submit", sendMessage);
els.sidebarToggle.addEventListener("click", toggleSidebar);
els.sidebarBackdrop.addEventListener("click", () => setSidebarCollapsed(true));
els.agentList.addEventListener("click", (event) => {
  if (event.target.closest(".agent-item")) closeSidebarOnMobile();
});
SIDEBAR_MOBILE.addEventListener("change", (event) => {
  sidebarCollapsed = event.matches ? true : readUiState().sidebarCollapsed === true;
  applySidebarState();
});
els.groupChatToggle.addEventListener("change", () => {
  state.groupChat = els.groupChatToggle.checked;
  if (state.groupChat) {
    // Entering a scene room preselects every AI participant of that scene.
    const scene = state.scenes.find((s) => s.key === state.selectedScene);
    state.groupCharacters = state.agents
      .filter((agent) => String(agent.role ?? "").trim().toLowerCase() !== "user")
      .filter((agent) => !scene || scene.participants.includes(agent.nickname))
      .map((agent) => agent.nickname);
  } else {
    state.groupCharacters = [];
  }
  state.selectedAgent = null;
  els.chatAgentName.textContent = state.groupChat ? "Group chat" : "Select an agent";
  els.chatAgentMeta.textContent = state.groupChat ? state.groupCharacters.join(", ") : "";
  renderAgents();
  updateComposer();
  renderChatBadges();
  syncConversation({ force: true });
  saveUiState();
});
els.scenarioSelect.addEventListener("change", () => {
  onScenarioChange();
  closeSidebarOnMobile();
});
els.sceneSelect.addEventListener("change", () => {
  const scene = state.scenes.find((s) => s.key === els.sceneSelect.value);
  const scenario = scene ? (scene.scenario || null) : null;
  if (state.selectedScenario !== scenario) {
    // Pick the story that owns the chosen scene (or clear the filter for free
    // chat), then rebuild the list so the two selectors stay consistent.
    state.selectedScenario = scenario;
    state.selectedScene = scene ? scene.key : null;
    refreshSceneSelect();
  } else {
    onSceneChange();
  }
  closeSidebarOnMobile();
});
els.chapterSelect.addEventListener("change", () => {
  if (els.chapterSelect.value) switchScene(els.chapterSelect.value);
});
els.modelSelect.addEventListener("change", () => {
  state.selectedModel = els.modelSelect.value || null;
  setChatStatus(state.selectedModel ? `Using model ${state.selectedModel}.` : "");
});
els.newCharacter.addEventListener("click", () => openCharacterModal());
els.modalClose.addEventListener("click", closeCharacterModal);
els.modalCancel.addEventListener("click", closeCharacterModal);
els.form.addEventListener("submit", submitCharacterForm);
els.newScene.addEventListener("click", () => openSceneModal());
els.newScenario.addEventListener("click", () => openScenarioModal());
els.scenarioScenesAll.addEventListener("change", () => {
  for (const box of els.scenarioFormScenes.querySelectorAll('input[name="scene"]')) {
    box.checked = els.scenarioScenesAll.checked;
  }
  els.scenarioScenesAll.indeterminate = false;
});
els.newCard.addEventListener("click", () => openWorldCardModal());
els.sceneModalClose.addEventListener("click", closeSceneModal);
els.sceneCancel.addEventListener("click", closeSceneModal);
els.sceneForm.addEventListener("submit", submitSceneForm);
els.scenarioModalClose.addEventListener("click", closeScenarioModal);
els.scenarioCancel.addEventListener("click", closeScenarioModal);
els.scenarioForm.addEventListener("submit", submitScenarioForm);
els.memoryScenarioSelect.addEventListener("change", renderMemories);
els.memoriesRefresh.addEventListener("click", loadMemories);
els.settingsToggle.addEventListener("click", () => toggleSettingsMenu());
els.settingsMenu.addEventListener("click", (event) => {
  const item = event.target.closest(".settings-item");
  if (!item) return;
  if (item.dataset.action === "scenarios") { openScenariosFromSettings(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "scenes") { openScenesFromSettings(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "characters") { openCharactersFromSettings(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "cards") { openCardsModal(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "memories") { openMemoriesModal(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "theme") {
    openThemeModal();
    closeSidebarOnMobile();
    return;
  }
  if (item.dataset.action === "help") { openHelpFromSettings(); closeSidebarOnMobile(); return; }
  if (item.dataset.action === "shutdown") { endSession(); closeSidebarOnMobile(); return; }
  closeSidebarOnMobile();
});
document.addEventListener("click", (event) => {
  if (!els.settingsMenu.classList.contains("hidden") &&
      !els.settingsMenu.contains(event.target) &&
      !els.settingsToggle.contains(event.target)) {
    closeSettingsMenu();
  }
});
els.helpModalClose.addEventListener("click", closeHelpModal);
els.helpClose.addEventListener("click", closeHelpModal);
els.charactersModalClose.addEventListener("click", closeCharactersModal);
els.charactersModalDone.addEventListener("click", closeCharactersModal);
els.scenariosModalClose.addEventListener("click", closeScenariosModal);
els.scenariosModalDone.addEventListener("click", closeScenariosModal);
els.scenesModalClose.addEventListener("click", closeScenesModal);
els.scenesModalDone.addEventListener("click", closeScenesModal);
els.cardsModalClose.addEventListener("click", closeCardsModal);
els.cardsModalDone.addEventListener("click", closeCardsModal);
els.memoriesModalClose.addEventListener("click", closeMemoriesModal);
els.memoriesModalDone.addEventListener("click", closeMemoriesModal);
if (els.themeModalClose) {
  els.themeModalClose.addEventListener("click", closeThemeModal);
}
if (els.themeModalDone) {
  els.themeModalDone.addEventListener("click", closeThemeModal);
}
document.querySelectorAll(".theme-option").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.themeValue;
    if (["dark", "light", "system"].includes(theme)) {
      setTheme(theme);
      document.querySelectorAll(".theme-option").forEach((b) => {
        b.classList.toggle("active", b === btn);
      });
      setChatStatus(`Theme set to ${theme}.`);
    }
  });
});
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (SIDEBAR_MOBILE.matches && !sidebarCollapsed) setSidebarCollapsed(true);
    if (!els.modal.classList.contains("hidden")) closeCharacterModal();
    if (!els.sceneModal.classList.contains("hidden")) closeSceneModal();
    if (!els.scenarioModal.classList.contains("hidden")) closeScenarioModal();
    if (!els.charactersModal.classList.contains("hidden")) closeCharactersModal();
    if (!els.scenariosModal.classList.contains("hidden")) closeScenariosModal();
    if (!els.scenesModal.classList.contains("hidden")) closeScenesModal();
    if (!els.cardsModal.classList.contains("hidden")) closeCardsModal();
    if (!els.memoriesModal.classList.contains("hidden")) closeMemoriesModal();
    if (els.themeModal && !els.themeModal.classList.contains("hidden")) closeThemeModal();
    if (!els.helpModal.classList.contains("hidden")) closeHelpModal();
    closeSettingsMenu();
  }
});
// ---------- World Card Modal (Settings ▸ World Cards ▸ New/Edit) ----------
function openWorldCardModal(card = null) {
  editingCardKey = card ? card.key : null;
  editingCardTags = cloneSelections(card?.tag_selections);
  els.worldCardModalTitle.textContent = card ? `Edit ${card.name}` : "New world card";
  els.worldCardModal.classList.remove("hidden");
  els.worldCardForm.reset();
  els.worldCardFormError.classList.add("hidden");
  const field = (fieldName) => els.worldCardForm.elements.namedItem(fieldName);
  if (card) {
    field("name").value = card.name;
    field("type").value = card.type ?? "world";
    field("description").value = card.description ?? "";
    field("active").checked = !!card.active;
  }
  renderTagPicker(els.cardTags, "card", editingCardTags);
  field("name").focus();
}
function closeWorldCardModal() {
  els.worldCardModal.classList.add("hidden");
}
async function submitWorldCardForm(event) {
  event.preventDefault();
  const field = (fieldName) => els.worldCardForm.elements.namedItem(fieldName);
  const name = field("name").value;
  const description = field("description").value;
  const type = field("type").value;
  const active = field("active").checked;

  els.worldCardFormError.classList.add("hidden");
  els.worldCardFormError.textContent = "";

  try {
    const payload = { name, description, type, active, tag_selections: editingCardTags };
    const wasEditing = Boolean(editingCardKey);
    const data = wasEditing
      ? await api(`/cards/${editingCardKey}`, { method: "PUT", body: JSON.stringify(payload) })
      : await api("/cards", { method: "POST", body: JSON.stringify(payload) });
    closeWorldCardModal();
    state.cards = [...state.cards.filter((card) => card.key !== data.card.key), data.card];
    syncActiveCardState();
    renderCards();
    renderChatBadges();
    setChatStatus(`${wasEditing ? "Updated" : "Created"} card ${data.card.name}.`);
    // A renamed card may change its key, so refresh scene/card links too.
    if (wasEditing && editingCardKey !== data.card.key) await reloadWorkspace(state.selectedScene);
  } catch (err) {
    els.worldCardFormError.classList.remove("hidden");
    els.worldCardFormError.textContent = err.message || String(err);
  }
}
els.worldCardModalClose.addEventListener("click", closeWorldCardModal);
els.worldCardCancel.addEventListener("click", closeWorldCardModal);
els.worldCardForm.addEventListener("submit", submitWorldCardForm);

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => {
    boot().catch((err) => setChatStatus(`Failed to load workspace: ${err.message}`, true));
  });
} else {
  boot().catch((err) => setChatStatus(`Failed to load workspace: ${err.message}`, true));
}
