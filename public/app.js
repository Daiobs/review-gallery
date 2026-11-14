/**
 * 审图哨所 v4 (Review Outpost v4) — Reviewer Studio Frontend
 * Pure ES Module, zero external CDN dependencies, strict Rule 2 / 3 / 5 compliance.
 */

export const FLAG_ORDER = ["H", "F", "O", "R"];
const REPAIR_FLAGS = new Set(["H", "F", "O"]);
const VALID_FLAGS = new Set(FLAG_ORDER);

export const TIER_META = {
  1: { label: "1 神图", short: "神图", cls: "badge-tier-1" },
  2: { label: "2 心动", short: "心动", cls: "badge-tier-2" },
  3: { label: "3 高品质", short: "高品质", cls: "badge-tier-3" },
};

export const FLAG_META = {
  H: { label: "H 修手指", cls: "badge-flag-repair" },
  F: { label: "F 修脚", cls: "badge-flag-repair" },
  O: { label: "O 局部修", cls: "badge-flag-repair" },
  R: { label: "R 重抽", cls: "badge-flag-redraw" },
};

const VIEW_MODE_STORAGE_KEY = "review_outpost_view_mode";

/**
 * Normalize flags to canonical order ["H", "F", "O", "R"] without duplicates.
 * @param {unknown} flags
 * @returns {Array<"H"|"F"|"O"|"R">}
 */
export function normalizeFlags(flags) {
  if (!Array.isArray(flags)) return [];
  const set = new Set(flags.filter((f) => typeof f === "string" && VALID_FLAGS.has(f)));
  return FLAG_ORDER.filter((f) => set.has(f));
}

/**
 * Rule 3: Strict mutually-exclusive bucket priority (identical to src/buckets.ts & hub_client.py):
 * 1) flags intersects H / F / O -> "repair" (preserving tier in D1/ledger)
 * 2) else flags contains R      -> "redraw"
 * 3) else tier in {1, 2, 3}     -> "archived"
 * 4) else                       -> "discarded"
 *
 * @param {number|null|undefined} tier
 * @param {string[]|undefined} flags
 * @returns {"repair"|"redraw"|"archived"|"discarded"}
 */
export function computeBucket(tier, flags) {
  const list = Array.isArray(flags) ? flags : [];
  for (const f of list) {
    if (REPAIR_FLAGS.has(f)) return "repair";
  }
  if (list.includes("R")) return "redraw";
  if (tier === 1 || tier === 2 || tier === 3) return "archived";
  return "discarded";
}

/**
 * Determine whether an item has any reviewer input (matches backend judged_count definition).
 * @param {{ tier?: number|null, flags?: string[], note?: string }} item
 * @returns {boolean}
 */
export function isItemJudged(item) {
  const hasTier = item.tier === 1 || item.tier === 2 || item.tier === 3;
  const hasFlags = Array.isArray(item.flags) && item.flags.length > 0;
  const hasNote = typeof item.note === "string" && item.note.trim().length > 0;
  return hasTier || hasFlags || hasNote;
}

/**
 * Compute aggregate 4-bucket counts and judged_count over items.
 * @param {Array<{ tier?: number|null, flags?: string[], note?: string }>} items
 * @param {number} [pushedOverride]
 */
export function computeBatchCounts(items, pushedOverride) {
  let archived = 0;
  let repair = 0;
  let redraw = 0;
  let discarded = 0;
  let judged = 0;

  for (const item of items) {
    const bucket = computeBucket(item.tier ?? null, item.flags ?? []);
    if (bucket === "archived") archived += 1;
    else if (bucket === "repair") repair += 1;
    else if (bucket === "redraw") redraw += 1;
    else discarded += 1;

    if (isItemJudged(item)) judged += 1;
  }

  return {
    judged_count: judged,
    counts: {
      pushed: typeof pushedOverride === "number" ? pushedOverride : items.length,
      archived,
      repair,
      redraw,
      discarded,
    },
  };
}

/**
 * Format human-readable bucket badge label, preserving original tier note when overridden by repair/redraw.
 * @param {"archived"|"repair"|"redraw"|"discarded"} bucket
 * @param {number|null|undefined} tier
 * @returns {string}
 */
export function formatBucketLabel(bucket, tier) {
  const hasTier = tier === 1 || tier === 2 || tier === 3;
  if (bucket === "repair") {
    return hasTier ? `待修复 (原定${tier}档)` : "待修复";
  }
  if (bucket === "redraw") {
    return hasTier ? `待重抽 (原定${tier}档)` : "待重抽";
  }
  if (bucket === "archived") {
    return "拟归档";
  }
  return "不收录";
}

/* ============================================================================
 * Browser Application Runtime
 * ========================================================================== */

function initApp() {
  const state = {
    route: "list", // "list" | "batch"
    batches: [],
    currentBatchId: null,
    batch: null,
    items: [],
    visibleIndices: [],
    activeIndex: -1, // index into state.items
    viewMode: loadStoredViewMode(), // "grid" | "masonry"
    filter: "all", // "all" | "unjudged" | "archived" | "repair" | "redraw" | "discarded"
    doneSubmitting: false,

    // Lightbox state
    lightbox: {
      open: false,
      scale: 1, // multiplier relative to fitted stage box (1 = Fit)
      zoomMode: "fit", // "fit" | "actual" | "custom"
      panX: 0,
      panY: 0,
      pointers: new Map(),
      pinchPrevDist: 0,
      pinchPrevMid: null,
      wasMultiTouch: false,
      swipeStartX: 0,
      swipeStartY: 0,
      dragging: false,
      lastTapTime: 0,
      lastTapX: 0,
      lastTapY: 0,
    },

    // Modals
    noteModalOpen: false,
    noteTargetIndex: -1,
    helpModalOpen: false,

    // Speech recognition
    speechRec: null,
    speechActive: false,
  };

  // Per-item sequential PATCH chains & latest sequence numbers
  const pendingChains = new Map();
  const itemMutationSeq = new Map();
  const cardDomByIndex = new Map();

  // DOM References
  const el = {
    btnBackBatches: document.getElementById("btn-back-batches"),
    brandBlock: document.getElementById("brand-block"),
    batchHeaderMeta: document.getElementById("batch-header-meta"),
    headerBatchId: document.getElementById("header-batch-id"),
    headerAgentBadge: document.getElementById("header-agent-badge"),
    headerStatusBadge: document.getElementById("header-status-badge"),
    headerProgressText: document.getElementById("header-progress-text"),
    headerProgressFill: document.getElementById("header-progress-fill"),
    headerBucketSummary: document.getElementById("header-bucket-summary"),

    batchToolbarActions: document.getElementById("batch-toolbar-actions"),
    btnViewGrid: document.getElementById("btn-view-grid"),
    btnViewMasonry: document.getElementById("btn-view-masonry"),
    btnShortcutHelp: document.getElementById("btn-shortcut-help"),
    btnMarkDone: document.getElementById("btn-mark-done"),
    btnRevokeDone: document.getElementById("btn-revoke-done"),
    btnRefresh: document.getElementById("btn-refresh"),

    viewBatchList: document.getElementById("view-batch-list"),
    batchListCount: document.getElementById("batch-list-count"),
    batchListLoading: document.getElementById("batch-list-loading"),
    batchListEmpty: document.getElementById("batch-list-empty"),
    batchListGrid: document.getElementById("batch-list-grid"),

    viewBatchDetail: document.getElementById("view-batch-detail"),
    lockedBanner: document.getElementById("locked-banner"),
    btnBannerRevoke: document.getElementById("btn-banner-revoke"),
    purgedBanner: document.getElementById("purged-banner"),
    bucketFilterBar: document.getElementById("bucket-filter-bar"),
    fltCountAll: document.getElementById("flt-count-all"),
    fltCountUnjudged: document.getElementById("flt-count-unjudged"),
    fltCountArchived: document.getElementById("flt-count-archived"),
    fltCountRepair: document.getElementById("flt-count-repair"),
    fltCountRedraw: document.getElementById("flt-count-redraw"),
    fltCountDiscarded: document.getElementById("flt-count-discarded"),

    batchDetailLoading: document.getElementById("batch-detail-loading"),
    batchItemsEmpty: document.getElementById("batch-items-empty"),
    btnResetFilter: document.getElementById("btn-reset-filter"),
    galleryContainer: document.getElementById("gallery-container"),

    actionDock: document.getElementById("action-dock"),
    dockIndexLabel: document.getElementById("dock-index-label"),
    dockItemLabel: document.getElementById("dock-item-label"),
    dockBucketBadge: document.getElementById("dock-bucket-badge"),
    dockPrev: document.getElementById("dock-prev"),
    dockOpenLightbox: document.getElementById("dock-open-lightbox"),
    dockNext: document.getElementById("dock-next"),
    dockNoteDot: document.getElementById("dock-note-dot"),

    lightbox: document.getElementById("lightbox"),
    lbCounter: document.getElementById("lb-counter"),
    lbRoundBadge: document.getElementById("lb-round-badge"),
    lbItemId: document.getElementById("lb-item-id"),
    lbDimensions: document.getElementById("lb-dimensions"),
    lbBucketBadge: document.getElementById("lb-bucket-badge"),
    lbZoomFit: document.getElementById("lb-zoom-fit"),
    lbZoomActual: document.getElementById("lb-zoom-actual"),
    lbZoomOut: document.getElementById("lb-zoom-out"),
    lbZoomLevel: document.getElementById("lb-zoom-level"),
    lbZoomIn: document.getElementById("lb-zoom-in"),
    lbClose: document.getElementById("lb-close"),
    lbStage: document.getElementById("lb-stage"),
    lbPrev: document.getElementById("lb-prev"),
    lbNext: document.getElementById("lb-next"),
    lbImage: document.getElementById("lb-image"),
    lbImgError: document.getElementById("lb-img-error"),
    lbBadgesList: document.getElementById("lb-badges-list"),
    lbNotePreview: document.getElementById("lb-note-preview"),
    lbNoteDot: document.getElementById("lb-note-dot"),

    noteModal: document.getElementById("note-modal"),
    noteModalSub: document.getElementById("note-modal-sub"),
    noteModalClose: document.getElementById("note-modal-close"),
    noteTextarea: document.getElementById("note-textarea"),
    btnSpeechToggle: document.getElementById("btn-speech-toggle"),
    speechBtnText: document.getElementById("speech-btn-text"),
    speechStatus: document.getElementById("speech-status"),
    btnNoteClear: document.getElementById("btn-note-clear"),
    btnNoteCancel: document.getElementById("btn-note-cancel"),
    btnNoteSave: document.getElementById("btn-note-save"),

    helpModal: document.getElementById("help-modal"),
    helpModalClose: document.getElementById("help-modal-close"),

    toastContainer: document.getElementById("toast-container"),
  };

  /* ------------------------------------------------------------------------
   * Utilities
   * ---------------------------------------------------------------------- */

  function loadStoredViewMode() {
    try {
      const saved = window.localStorage.getItem(VIEW_MODE_STORAGE_KEY);
      if (saved === "masonry" || saved === "grid") return saved;
    } catch {
      // Ignore storage access errors in restricted contexts
    }
    return "grid";
  }

  function saveViewMode(mode) {
    try {
      window.localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage errors
    }
  }

  function showToast(message, kind = "info", durationMs = 3400) {
    const div = document.createElement("div");
    div.className = `toast${kind !== "info" ? ` toast-${kind}` : ""}`;
    div.textContent = message;
    el.toastContainer.appendChild(div);
    window.setTimeout(() => {
      div.remove();
    }, durationMs);
  }

  function formatDateTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function normalizeItem(raw, fallbackBatchId) {
    const flags = normalizeFlags(raw.flags);
    const tier = raw.tier === 1 || raw.tier === 2 || raw.tier === 3 ? raw.tier : null;
    const note = typeof raw.note === "string" ? raw.note : "";
    const batchId = raw.batch_id || fallbackBatchId || "";
    const round = Number.isFinite(Number(raw.round)) && Number(raw.round) >= 1 ? Number(raw.round) : 1;
    const previewUrl =
      raw.preview_url ||
      `/api/review/previews/${encodeURIComponent(batchId)}/${encodeURIComponent(raw.item_id)}/${encodeURIComponent(round)}`;

    return {
      item_id: String(raw.item_id),
      round,
      batch_id: batchId,
      filename: raw.filename || `${raw.item_id}_r${round}.webp`,
      width: Number.isFinite(Number(raw.width)) && Number(raw.width) > 0 ? Math.round(Number(raw.width)) : null,
      height: Number.isFinite(Number(raw.height)) && Number(raw.height) > 0 ? Math.round(Number(raw.height)) : null,
      pushed_at: raw.pushed_at || null,
      tier,
      flags,
      note,
      judged_at: raw.judged_at || null,
      bucket: computeBucket(tier, flags),
      preview_url: previewUrl,
    };
  }

  function normalizeBatch(raw) {
    const pushedCount = Number(raw.pushed_count ?? raw.counts?.pushed ?? 0);
    const counts = raw.counts || {
      pushed: pushedCount,
      archived: 0,
      repair: 0,
      redraw: 0,
      discarded: pushedCount,
    };
    return {
      batch_id: String(raw.batch_id),
      agent_id: String(raw.agent_id || "unknown"),
      pushed_count: pushedCount,
      judged_count: Number(raw.judged_count ?? 0),
      review_done: Boolean(raw.review_done),
      created_at: raw.created_at || "",
      previews_purged_at: raw.previews_purged_at || null,
      counts: {
        pushed: Number(counts.pushed ?? pushedCount),
        archived: Number(counts.archived ?? 0),
        repair: Number(counts.repair ?? 0),
        redraw: Number(counts.redraw ?? 0),
        discarded: Number(counts.discarded ?? 0),
      },
    };
  }

  async function apiJson(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const resp = await fetch(url, {
      ...options,
      credentials: "same-origin",
      headers,
    });
    let data = null;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
    }
    return { status: resp.status, ok: resp.ok, data };
  }

  /* ------------------------------------------------------------------------
   * Routing (#/ and #/batch/<batchId>)
   * ---------------------------------------------------------------------- */

  function navigateToList(replace = false) {
    if (state.lightbox.open) closeLightbox();
    if (state.noteModalOpen) closeNoteModal();
    const targetHash = "#/";
    if (window.location.hash !== targetHash) {
      if (replace) window.history.replaceState(null, "", targetHash);
      else window.location.hash = targetHash;
    } else {
      handleRouteChange();
    }
  }

  function navigateToBatch(batchId) {
    const targetHash = `#/batch/${encodeURIComponent(batchId)}`;
    if (window.location.hash !== targetHash) {
      window.location.hash = targetHash;
    } else {
      handleRouteChange();
    }
  }

  function parseRouteFromHash() {
    const hash = window.location.hash || "#/";
    const match = hash.match(/^#\/batch\/([^/?#]+)/);
    if (match) {
      try {
        return { route: "batch", batchId: decodeURIComponent(match[1]) };
      } catch {
        return { route: "list", batchId: null };
      }
    }
    return { route: "list", batchId: null };
  }

  async function handleRouteChange() {
    const parsed = parseRouteFromHash();
    if (parsed.route === "batch" && parsed.batchId) {
      await showBatchDetailView(parsed.batchId);
    } else {
      await showBatchListView();
    }
  }

  /* ------------------------------------------------------------------------
   * View 1: Batch List
   * ---------------------------------------------------------------------- */

  async function showBatchListView() {
    state.route = "list";
    state.currentBatchId = null;
    state.batch = null;
    state.items = [];
    state.visibleIndices = [];
    state.activeIndex = -1;
    cardDomByIndex.clear();
    closeLightbox();
    closeNoteModal();

    // Header visibility
    el.btnBackBatches.hidden = true;
    el.brandBlock.classList.remove("in-batch");
    el.batchHeaderMeta.hidden = true;
    el.batchToolbarActions.hidden = true;
    el.actionDock.hidden = true;

    el.viewBatchDetail.hidden = true;
    el.viewBatchList.hidden = false;

    await fetchAndRenderBatches();
  }

  async function fetchAndRenderBatches() {
    el.batchListLoading.hidden = false;
    el.batchListEmpty.hidden = true;
    el.batchListGrid.innerHTML = "";

    try {
      const { ok, status, data } = await apiJson("/api/review/batches");
      el.batchListLoading.hidden = true;

      if (!ok || !data || !Array.isArray(data.batches)) {
        showToast(
          status === 401 || status === 403
            ? "未通过 Cloudflare Access 登录鉴权，请刷新重新认证"
            : `获取批次列表失败 (HTTP ${status})`,
          "error"
        );
        el.batchListEmpty.hidden = false;
        return;
      }

      state.batches = data.batches.map(normalizeBatch);
      el.batchListCount.textContent =
        state.batches.length > 0 ? `共 ${state.batches.length} 个云端批次` : "";

      if (state.batches.length === 0) {
        el.batchListEmpty.hidden = false;
        return;
      }

      const frag = document.createDocumentFragment();
      for (const batch of state.batches) {
        frag.appendChild(createBatchCardElement(batch));
      }
      el.batchListGrid.appendChild(frag);
    } catch {
      el.batchListLoading.hidden = true;
      el.batchListEmpty.hidden = false;
      showToast("网络连接异常，无法获取批次列表", "error");
    }
  }

  function createBatchCardElement(batch) {
    const card = document.createElement("article");
    card.className = "batch-card";
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `进入批次 ${batch.batch_id}`);

    const pct =
      batch.pushed_count > 0
        ? Math.min(100, Math.round((batch.judged_count / batch.pushed_count) * 100))
        : 0;

    const head = document.createElement("div");
    head.className = "batch-card-head";

    const titleWrap = document.createElement("div");
    const h3 = document.createElement("h3");
    h3.className = "batch-card-id";
    h3.textContent = batch.batch_id;

    const meta = document.createElement("div");
    meta.className = "batch-card-meta";
    const agentPill = document.createElement("span");
    agentPill.className = "pill pill-agent";
    agentPill.textContent = batch.agent_id;
    const timeSpan = document.createElement("span");
    timeSpan.textContent = formatDateTime(batch.created_at);
    meta.append(agentPill, timeSpan);
    if (batch.previews_purged_at) {
      const purgedSpan = document.createElement("span");
      purgedSpan.className = "pill";
      purgedSpan.textContent = "预览已期满清理";
      meta.appendChild(purgedSpan);
    }
    titleWrap.append(h3, meta);

    const statusPill = document.createElement("span");
    statusPill.className = `pill ${batch.review_done ? "pill-done" : "pill-reviewing"}`;
    statusPill.textContent = batch.review_done ? "已审完 · 待 Agent 拉取" : "审图中";

    head.append(titleWrap, statusPill);

    const progBlock = document.createElement("div");
    progBlock.className = "batch-progress-block";
    const progLabels = document.createElement("div");
    progLabels.className = "batch-progress-labels";
    const leftLbl = document.createElement("span");
    leftLbl.textContent = `定档进度：已判 ${batch.judged_count} / ${batch.pushed_count}`;
    const rightLbl = document.createElement("span");
    rightLbl.textContent = `${pct}%`;
    progLabels.append(leftLbl, rightLbl);

    const bar = document.createElement("div");
    bar.className = "batch-progress-bar";
    const fill = document.createElement("div");
    fill.className = "batch-progress-bar-fill";
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    progBlock.append(progLabels, bar);

    const countsGrid = document.createElement("div");
    countsGrid.className = "batch-counts-grid";
    const chips = [
      { cls: "c-archived", num: batch.counts.archived, lbl: "归档" },
      { cls: "c-repair", num: batch.counts.repair, lbl: "修复" },
      { cls: "c-redraw", num: batch.counts.redraw, lbl: "重抽" },
      { cls: "c-discarded", num: batch.counts.discarded, lbl: "不收录" },
    ];
    for (const c of chips) {
      const chip = document.createElement("div");
      chip.className = `count-chip ${c.cls}`;
      const numEl = document.createElement("span");
      numEl.className = "count-chip-num";
      numEl.textContent = String(c.num);
      const lblEl = document.createElement("span");
      lblEl.className = "count-chip-lbl";
      lblEl.textContent = c.lbl;
      chip.append(numEl, lblEl);
      countsGrid.appendChild(chip);
    }

    card.append(head, progBlock, countsGrid);

    const openBatch = () => navigateToBatch(batch.batch_id);
    card.addEventListener("click", openBatch);
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openBatch();
      }
    });

    return card;
  }

  /* ------------------------------------------------------------------------
   * View 2: Batch Review Detail
   * ---------------------------------------------------------------------- */

  async function showBatchDetailView(batchId) {
    state.route = "batch";
    state.currentBatchId = batchId;
    state.filter = "all";
    closeLightbox();
    closeNoteModal();

    el.viewBatchList.hidden = true;
    el.viewBatchDetail.hidden = false;
    el.btnBackBatches.hidden = false;
    el.brandBlock.classList.add("in-batch");
    el.batchHeaderMeta.hidden = false;
    el.batchToolbarActions.hidden = false;

    syncViewModeButtons();
    await fetchAndRenderBatchDetail(batchId);
  }

  async function fetchAndRenderBatchDetail(batchId) {
    el.batchDetailLoading.hidden = false;
    el.batchItemsEmpty.hidden = true;
    el.galleryContainer.innerHTML = "";
    cardDomByIndex.clear();

    try {
      const { ok, status, data } = await apiJson(
        `/api/review/batches/${encodeURIComponent(batchId)}`
      );
      el.batchDetailLoading.hidden = true;

      if (status === 404) {
        showToast("该批次不存在，或已被 Agent 拉取确认（ack）并从云端删除", "warning", 4500);
        navigateToList(true);
        return;
      }

      if (!ok || !data || !data.batch) {
        showToast(`加载批次详情失败 (HTTP ${status})`, "error");
        return;
      }

      state.batch = normalizeBatch(data.batch);
      state.items = Array.isArray(data.items)
        ? data.items.map((it) => normalizeItem(it, state.batch.batch_id))
        : [];

      // Ensure local bucket & counts are strictly synchronized
      recomputeLocalBatchStats();

      renderBatchHeaderAndBanners();
      buildGalleryDom();
      applyFilterAndSelection(state.items.length > 0 ? 0 : -1);
    } catch {
      el.batchDetailLoading.hidden = true;
      showToast("网络异常，无法加载批次详情", "error");
    }
  }

  function recomputeLocalBatchStats() {
    if (!state.batch) return;
    const computed = computeBatchCounts(state.items, state.batch.pushed_count || state.items.length);
    state.batch.judged_count = computed.judged_count;
    state.batch.counts = computed.counts;
  }

  function renderBatchHeaderAndBanners() {
    const batch = state.batch;
    if (!batch) return;

    el.headerBatchId.textContent = batch.batch_id;
    el.headerAgentBadge.textContent = batch.agent_id;

    el.headerStatusBadge.className = `pill ${batch.review_done ? "pill-done" : "pill-reviewing"}`;
    el.headerStatusBadge.textContent = batch.review_done ? "已审完 · 待 Agent 拉取" : "审图中";

    el.headerProgressText.textContent = `已判 ${batch.judged_count} / ${batch.pushed_count}`;
    const pct =
      batch.pushed_count > 0
        ? Math.min(100, Math.round((batch.judged_count / batch.pushed_count) * 100))
        : 0;
    el.headerProgressFill.style.width = `${pct}%`;

    const c = batch.counts;
    el.headerBucketSummary.textContent = `归档 ${c.archived} · 修复 ${c.repair} · 重抽 ${c.redraw} · 淘汰 ${c.discarded}`;

    // Done / Revoke buttons + Locked banner
    el.lockedBanner.hidden = !batch.review_done;
    el.btnMarkDone.hidden = batch.review_done;
    el.btnRevokeDone.hidden = !batch.review_done;
    el.btnMarkDone.disabled = state.doneSubmitting || state.items.length === 0;
    el.btnRevokeDone.disabled = state.doneSubmitting;
    el.btnBannerRevoke.disabled = state.doneSubmitting;

    // Purged previews banner (>7 days Cron cleanup)
    el.purgedBanner.hidden = !batch.previews_purged_at;

    // Update filter pill counters
    let unjudgedCount = 0;
    for (const it of state.items) {
      if (!isItemJudged(it)) unjudgedCount += 1;
    }
    el.fltCountAll.textContent = String(state.items.length);
    el.fltCountUnjudged.textContent = String(unjudgedCount);
    el.fltCountArchived.textContent = String(c.archived);
    el.fltCountRepair.textContent = String(c.repair);
    el.fltCountRedraw.textContent = String(c.redraw);
    el.fltCountDiscarded.textContent = String(c.discarded);

    for (const btn of el.bucketFilterBar.querySelectorAll(".filter-pill")) {
      btn.classList.toggle("active", btn.dataset.filter === state.filter);
    }

    el.actionDock.hidden = state.items.length === 0;
    syncActionDock();
  }

  /* ------------------------------------------------------------------------
   * Zero-Flicker Gallery DOM (Grid & Masonry)
   * ---------------------------------------------------------------------- */

  function syncViewModeButtons() {
    const isGrid = state.viewMode === "grid";
    el.btnViewGrid.classList.toggle("active", isGrid);
    el.btnViewMasonry.classList.toggle("active", !isGrid);
    el.galleryContainer.classList.toggle("mode-grid", isGrid);
    el.galleryContainer.classList.toggle("mode-masonry", !isGrid);
  }

  function setViewMode(mode) {
    if (mode !== "grid" && mode !== "masonry") return;
    state.viewMode = mode;
    saveViewMode(mode);
    syncViewModeButtons();
    scheduleMasonryLayout();
  }

  function buildGalleryDom() {
    el.galleryContainer.innerHTML = "";
    cardDomByIndex.clear();

    const frag = document.createDocumentFragment();
    state.items.forEach((item, index) => {
      const card = createGalleryCard(item, index);
      cardDomByIndex.set(index, card);
      frag.appendChild(card);
    });
    el.galleryContainer.appendChild(frag);
    scheduleMasonryLayout();
  }

  function createGalleryCard(item, index) {
    const card = document.createElement("article");
    card.className = "gallery-card";
    card.dataset.index = String(index);
    card.dataset.itemId = item.item_id;

    // Rule 2: Pre-reserve exact aspect-ratio from D1 width/height (fallback 1 / 1) BEFORE WebP loads!
    const w = item.width && item.width > 0 ? item.width : 1;
    const h = item.height && item.height > 0 ? item.height : 1;
    const orient = h > w ? "portrait" : "landscape";

    const stage = document.createElement("div");
    stage.className = "card-stage";

    const aspectBox = document.createElement("div");
    aspectBox.className = "card-aspect-box";
    aspectBox.style.aspectRatio = `${w} / ${h}`;
    aspectBox.dataset.orient = orient;

    const img = document.createElement("img");
    img.className = "card-img";
    img.loading = index < 16 ? "eager" : "lazy";
    img.decoding = "async";
    img.alt = item.filename || item.item_id;
    img.src = item.preview_url;

    img.addEventListener("load", () => {
      img.classList.add("is-loaded");
    });

    img.addEventListener("error", () => {
      if (!aspectBox.querySelector(".card-img-fallback")) {
        const fb = document.createElement("div");
        fb.className = "card-img-fallback";
        fb.textContent = state.batch?.previews_purged_at
          ? "预览图已满 7 天清理"
          : "预览图不可用";
        aspectBox.appendChild(fb);
      }
    });

    aspectBox.appendChild(img);

    // Top overlay (#seq + round badge + expand lightbox button)
    const topOverlay = document.createElement("div");
    topOverlay.className = "card-top-overlay";

    const seqPill = document.createElement("span");
    seqPill.className = "card-seq-pill";
    seqPill.textContent =
      item.round > 1
        ? `#${String(index + 1).padStart(3, "0")} · R${item.round}`
        : `#${String(index + 1).padStart(3, "0")}`;

    const zoomBtn = document.createElement("button");
    zoomBtn.className = "card-zoom-btn";
    zoomBtn.type = "button";
    zoomBtn.title = "查看原分辨率大图";
    zoomBtn.setAttribute("aria-label", "查看原分辨率大图");
    zoomBtn.innerHTML =
      '<svg class="icon-sm" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    zoomBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      selectItem(index, false);
      openLightbox(index);
    });

    topOverlay.append(seqPill, zoomBtn);
    stage.append(aspectBox, topOverlay);

    // Card footer body
    const body = document.createElement("div");
    body.className = "card-body";

    const metaRow = document.createElement("div");
    metaRow.className = "card-meta-row";

    const filenameEl = document.createElement("span");
    filenameEl.className = "card-filename";
    filenameEl.title = `${item.item_id} (${item.filename})`;
    filenameEl.textContent = item.filename || item.item_id;

    const bucketBadge = document.createElement("span");
    bucketBadge.className = "bucket-badge";
    metaRow.append(filenameEl, bucketBadge);

    const badgesRow = document.createElement("div");
    badgesRow.className = "card-badges";

    const noteSnippet = document.createElement("p");
    noteSnippet.className = "card-note-snippet";
    noteSnippet.hidden = true;

    body.append(metaRow, badgesRow, noteSnippet);
    card.append(stage, body);

    // Interaction: click selects card; tapping an already-selected card on touch or double-clicking opens Lightbox
    card.addEventListener("click", (e) => {
      const wasActive = state.activeIndex === index;
      selectItem(index, false);
      if (wasActive && e.target.closest(".card-stage")) {
        // Second click/tap on already-active artwork stage opens Lightbox effortlessly on mobile & desktop
        openLightbox(index);
      }
    });

    card.addEventListener("dblclick", (e) => {
      e.preventDefault();
      selectItem(index, false);
      openLightbox(index);
    });

    patchCardVerdictDom(card, item);
    return card;
  }

  function renderBadgesInto(container, item) {
    container.innerHTML = "";
    let anyBadge = false;

    if (item.round > 1) {
      const rb = document.createElement("span");
      rb.className = "badge badge-round";
      rb.textContent = `R${item.round}`;
      container.appendChild(rb);
      anyBadge = true;
    }

    if (item.tier && TIER_META[item.tier]) {
      const tb = document.createElement("span");
      tb.className = `badge ${TIER_META[item.tier].cls}`;
      tb.textContent = TIER_META[item.tier].label;
      container.appendChild(tb);
      anyBadge = true;
    }

    for (const f of item.flags) {
      const meta = FLAG_META[f];
      if (!meta) continue;
      const fb = document.createElement("span");
      fb.className = `badge ${meta.cls}`;
      fb.textContent = meta.label;
      container.appendChild(fb);
      anyBadge = true;
    }

    if (!anyBadge) {
      const empty = document.createElement("span");
      empty.className = "badge-unjudged";
      empty.textContent = "未定档";
      container.appendChild(empty);
    }
  }

  function patchCardVerdictDom(card, item) {
    if (!card) return;
    const bucketBadge = card.querySelector(".bucket-badge");
    if (bucketBadge) {
      bucketBadge.className = `bucket-badge bucket-${item.bucket}`;
      bucketBadge.textContent = formatBucketLabel(item.bucket, item.tier);
    }

    const badgesRow = card.querySelector(".card-badges");
    if (badgesRow) {
      renderBadgesInto(badgesRow, item);
    }

    const noteSnippet = card.querySelector(".card-note-snippet");
    if (noteSnippet) {
      const trimmed = (item.note || "").trim();
      if (trimmed) {
        noteSnippet.hidden = false;
        noteSnippet.textContent = `备注：${trimmed}`;
      } else {
        noteSnippet.hidden = true;
        noteSnippet.textContent = "";
      }
    }
  }

  let masonryRaf = 0;
  function scheduleMasonryLayout() {
    if (masonryRaf) window.cancelAnimationFrame(masonryRaf);
    masonryRaf = window.requestAnimationFrame(() => {
      masonryRaf = 0;
      applyMasonrySpansNow();
    });
  }

  function applyMasonrySpansNow() {
    if (state.viewMode !== "masonry") {
      for (const card of cardDomByIndex.values()) {
        card.style.gridRowEnd = "";
      }
      return;
    }
    const isMobile = window.matchMedia("(max-width: 768px)").matches;
    const gapPx = isMobile ? 10 : 16;
    for (const idx of state.visibleIndices) {
      const card = cardDomByIndex.get(idx);
      if (!card || card.hidden) continue;
      const rectH = card.getBoundingClientRect().height;
      if (rectH > 0) {
        card.style.gridRowEnd = `span ${Math.ceil(rectH + gapPx)}`;
      }
    }
  }

  function itemMatchesFilter(item, filter) {
    if (filter === "all") return true;
    if (filter === "unjudged") return !isItemJudged(item);
    return item.bucket === filter;
  }

  function applyFilterAndSelection(preferredIndex, keepActiveVisible = false) {
    const visible = [];
    state.items.forEach((item, idx) => {
      const show =
        itemMatchesFilter(item, state.filter) ||
        (keepActiveVisible && idx === preferredIndex);
      const card = cardDomByIndex.get(idx);
      if (card) card.hidden = !show;
      if (show) visible.push(idx);
    });

    state.visibleIndices = visible;
    el.batchItemsEmpty.hidden = visible.length > 0 || state.items.length === 0;

    if (visible.length === 0) {
      selectItem(-1, false);
    } else if (preferredIndex >= 0 && visible.includes(preferredIndex)) {
      selectItem(preferredIndex, false);
    } else {
      selectItem(visible[0], false);
    }

    scheduleMasonryLayout();
  }

  function selectItem(index, scrollIntoView = true) {
    if (state.activeIndex >= 0) {
      const prevCard = cardDomByIndex.get(state.activeIndex);
      if (prevCard) prevCard.classList.remove("is-active");
    }

    state.activeIndex = index;

    if (index >= 0) {
      const nextCard = cardDomByIndex.get(index);
      if (nextCard) {
        nextCard.classList.add("is-active");
        if (scrollIntoView) {
          nextCard.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      }
    }

    syncActionDock();
    if (state.lightbox.open && index >= 0) {
      renderLightboxItem();
    }
  }

  function navigateRelative(delta) {
    if (state.visibleIndices.length === 0) return;

    const currentIdx = state.activeIndex;
    const pos = state.visibleIndices.indexOf(currentIdx);
    let nextTarget = -1;

    if (pos === -1) {
      nextTarget = state.visibleIndices[0];
    } else {
      const nextPos = pos + delta;
      if (nextPos < 0 || nextPos >= state.visibleIndices.length) return;
      nextTarget = state.visibleIndices[nextPos];
    }

    // Re-apply filter strictly in case previous active item was temporarily kept visible
    if (state.filter !== "all" && currentIdx >= 0 && !itemMatchesFilter(state.items[currentIdx], state.filter)) {
      applyFilterAndSelection(nextTarget, false);
    } else {
      selectItem(nextTarget, !state.lightbox.open);
    }
  }

  /* ------------------------------------------------------------------------
   * Bottom Action Dock & Lightbox Footer Sync
   * ---------------------------------------------------------------------- */

  function syncActionDock() {
    const item = state.activeIndex >= 0 ? state.items[state.activeIndex] : null;
    const locked = Boolean(state.batch?.review_done);
    const posInVisible = item ? state.visibleIndices.indexOf(state.activeIndex) : -1;

    if (!item) {
      el.dockIndexLabel.textContent = `0 / ${state.visibleIndices.length}`;
      el.dockItemLabel.textContent = "暂无选中图片";
      el.dockBucketBadge.className = "bucket-badge bucket-discarded";
      el.dockBucketBadge.textContent = "不收录";
      el.dockPrev.disabled = true;
      el.dockNext.disabled = true;
      el.dockOpenLightbox.disabled = true;
    } else {
      el.dockIndexLabel.textContent = `${posInVisible + 1} / ${state.visibleIndices.length}`;
      el.dockItemLabel.textContent =
        item.round > 1 ? `${item.filename} (R${item.round})` : item.filename;
      el.dockBucketBadge.className = `bucket-badge bucket-${item.bucket}`;
      el.dockBucketBadge.textContent = formatBucketLabel(item.bucket, item.tier);
      el.dockPrev.disabled = posInVisible <= 0;
      el.dockNext.disabled = posInVisible < 0 || posInVisible >= state.visibleIndices.length - 1;
      el.dockOpenLightbox.disabled = false;
    }

    const hasNote = Boolean(item && item.note && item.note.trim());
    el.dockNoteDot.hidden = !hasNote;
    el.lbNoteDot.hidden = !hasNote;

    // Sync selected state across BOTH main action dock AND lightbox footer buttons
    const allTierBtns = document.querySelectorAll("[data-action-tier]");
    for (const btn of allTierBtns) {
      const t = Number(btn.getAttribute("data-action-tier"));
      btn.disabled = !item || locked;
      btn.classList.toggle("is-selected", Boolean(item && item.tier === t));
    }

    const allFlagBtns = document.querySelectorAll("[data-action-flag]");
    for (const btn of allFlagBtns) {
      const f = btn.getAttribute("data-action-flag");
      btn.disabled = !item || locked;
      btn.classList.toggle("is-selected", Boolean(item && item.flags.includes(f)));
    }

    const allNoteBtns = document.querySelectorAll("[data-action-note]");
    for (const btn of allNoteBtns) {
      btn.disabled = !item || locked;
      btn.classList.toggle("is-selected", hasNote);
    }
  }

  /* ------------------------------------------------------------------------
   * Verdict Mutations (1/2/3 Tiers, H/F/O/R Flags, N Note) + Optimistic Sync
   * ---------------------------------------------------------------------- */

  function guardBatchEditable() {
    if (!state.batch) return false;
    if (state.batch.review_done) {
      showToast("本批已锁定为审完状态，请先点击「撤回审完状态」后再修改", "warning");
      return false;
    }
    return true;
  }

  function toggleTierOnActive(tierValue) {
    if (state.activeIndex < 0 || !guardBatchEditable()) return;
    const item = state.items[state.activeIndex];
    const nextTier = item.tier === tierValue ? null : tierValue;
    applyItemMutation(state.activeIndex, {
      tier: nextTier,
      flags: item.flags,
      note: item.note,
    });
  }

  function toggleFlagOnActive(flagCode) {
    if (state.activeIndex < 0 || !guardBatchEditable()) return;
    const item = state.items[state.activeIndex];
    const set = new Set(item.flags);
    if (set.has(flagCode)) set.delete(flagCode);
    else set.add(flagCode);
    const nextFlags = FLAG_ORDER.filter((f) => set.has(f));
    applyItemMutation(state.activeIndex, {
      tier: item.tier,
      flags: nextFlags,
      note: item.note,
    });
  }

  function applyItemMutation(index, nextFields) {
    const item = state.items[index];
    if (!item || !state.batch) return;

    item.tier = nextFields.tier;
    item.flags = normalizeFlags(nextFields.flags);
    item.note = typeof nextFields.note === "string" ? nextFields.note : "";
    item.bucket = computeBucket(item.tier, item.flags);
    item.judged_at = isItemJudged(item) ? new Date().toISOString() : null;

    recomputeLocalBatchStats();

    // Update UI immediately with zero image flicker
    patchCardVerdictDom(cardDomByIndex.get(index), item);
    renderBatchHeaderAndBanners();
    if (state.filter !== "all") {
      applyFilterAndSelection(index, true);
    } else {
      scheduleMasonryLayout();
    }
    if (state.lightbox.open && state.activeIndex === index) {
      renderLightboxOverlayOnly();
    }

    queueServerItemPatch(index);
  }

  function queueServerItemPatch(index) {
    const item = state.items[index];
    const batchId = state.batch?.batch_id;
    if (!item || !batchId) return;

    const key = `${batchId}:${item.item_id}:${item.round}`;
    const seq = (itemMutationSeq.get(key) || 0) + 1;
    itemMutationSeq.set(key, seq);

    const payload = {
      tier: item.tier,
      flags: [...item.flags],
      note: item.note,
    };

    const prevChain = pendingChains.get(key) || Promise.resolve();
    const nextPromise = prevChain
      .catch(() => {})
      .then(async () => {
        // If a newer keypress already arrived on this same item while waiting, skip redundant intermediate PATCH
        if (itemMutationSeq.get(key) !== seq) return;

        const url = `/api/review/batches/${encodeURIComponent(batchId)}/items/${encodeURIComponent(
          item.item_id
        )}/${encodeURIComponent(item.round)}`;

        const { ok, status, data } = await apiJson(url, {
          method: "PATCH",
          body: JSON.stringify(payload),
        });

        if (state.currentBatchId !== batchId) return;

        if (status === 409) {
          showToast("批次已被锁定为审完状态，如需改判请先撤回审完状态", "warning");
          await fetchAndRenderBatchDetail(batchId);
          return;
        }

        if (status === 404) {
          showToast("该批次已被 Agent 确认（ack）并清理", "warning", 4500);
          navigateToList(true);
          return;
        }

        if (!ok) {
          showToast(`保存定档失败 (HTTP ${status})，正在重新同步`, "error");
          await fetchAndRenderBatchDetail(batchId);
          return;
        }

        // Only apply server reconciliation if no newer keypress occurred during flight
        if (itemMutationSeq.get(key) === seq && data) {
          if (data.item) {
            const synced = normalizeItem(data.item, batchId);
            state.items[index] = synced;
            patchCardVerdictDom(cardDomByIndex.get(index), synced);
          }
          if (data.batch) {
            state.batch = normalizeBatch(data.batch);
          } else {
            recomputeLocalBatchStats();
          }
          renderBatchHeaderAndBanners();
          if (state.lightbox.open && state.activeIndex === index) {
            renderLightboxOverlayOnly();
          }
        }
      })
      .catch(() => {
        if (state.currentBatchId === batchId) {
          showToast("网络波动，定档保存失败，请检查连接后刷新", "error");
        }
      })
      .finally(() => {
        if (pendingChains.get(key) === nextPromise) {
          pendingChains.delete(key);
        }
      });

    pendingChains.set(key, nextPromise);
  }

  async function flushPendingPatches() {
    while (pendingChains.size > 0) {
      await Promise.allSettled([...pendingChains.values()]);
    }
  }

  /* ------------------------------------------------------------------------
   * 「审完本批」 & 「撤回审完状态」 (Rule 5)
   * ---------------------------------------------------------------------- */

  async function setBatchReviewDone(reviewDone) {
    if (!state.batch || state.doneSubmitting) return;
    const batchId = state.batch.batch_id;
    state.doneSubmitting = true;
    renderBatchHeaderAndBanners();

    try {
      if (reviewDone) {
        await flushPendingPatches();
      }

      const { ok, status, data } = await apiJson(
        `/api/review/batches/${encodeURIComponent(batchId)}/done`,
        {
          method: "POST",
          body: JSON.stringify({ review_done: Boolean(reviewDone) }),
        }
      );

      state.doneSubmitting = false;

      if (status === 404) {
        showToast(
          reviewDone
            ? "该批次不存在或已被清理，已返回批次列表"
            : "该批次已被 Agent 拉取确认（ack）并从云端清理，无法撤回审完状态",
          "warning",
          5000
        );
        navigateToList(true);
        return;
      }

      if (!ok || !data?.batch) {
        renderBatchHeaderAndBanners();
        showToast(`更新审完状态失败 (HTTP ${status})`, "error");
        return;
      }

      state.batch = normalizeBatch(data.batch);
      renderBatchHeaderAndBanners();

      if (state.batch.review_done) {
        showToast("已标记审完本批，等待 Agent 拉取归档", "success");
      } else {
        showToast("已撤回审完状态，可继续修改本批定档与标记", "info");
      }
    } catch {
      state.doneSubmitting = false;
      renderBatchHeaderAndBanners();
      showToast("网络请求异常，请稍后重试", "error");
    }
  }

  /* ------------------------------------------------------------------------
   * Full-Resolution Lightbox with Zoom & Pan + Left/Right Navigation
   * ---------------------------------------------------------------------- */

  function openLightbox(index) {
    if (index < 0 || index >= state.items.length) return;
    selectItem(index, false);
    state.lightbox.open = true;
    el.lightbox.hidden = false;
    document.body.style.overflow = "hidden";
    renderLightboxItem();
  }

  function closeLightbox() {
    if (!state.lightbox.open) return;
    state.lightbox.open = false;
    state.lightbox.pointers.clear();
    state.lightbox.dragging = false;
    el.lightbox.hidden = true;
    document.body.style.overflow = "";
    // Keep active card visible in grid/masonry upon closing lightbox
    if (state.activeIndex >= 0) {
      const card = cardDomByIndex.get(state.activeIndex);
      if (card) card.scrollIntoView({ block: "nearest" });
    }
  }

  function renderLightboxItem() {
    const item = state.items[state.activeIndex];
    if (!item) return;

    resetLightboxZoom("fit");
    el.lbImgError.hidden = true;
    el.lbImage.hidden = false;

    if (el.lbImage.dataset.currentSrc !== item.preview_url) {
      el.lbImage.dataset.currentSrc = item.preview_url;
      el.lbImage.src = item.preview_url;
    } else {
      updateLightboxTransformUI();
    }

    renderLightboxOverlayOnly();
    preloadNeighborImages();
  }

  function renderLightboxOverlayOnly() {
    const item = state.items[state.activeIndex];
    if (!item) return;

    const pos = state.visibleIndices.indexOf(state.activeIndex);
    el.lbCounter.textContent = `${pos + 1} / ${state.visibleIndices.length}`;

    if (item.round > 1) {
      el.lbRoundBadge.hidden = false;
      el.lbRoundBadge.textContent = `R${item.round}`;
    } else {
      el.lbRoundBadge.hidden = true;
    }

    el.lbItemId.textContent = item.filename || item.item_id;
    el.lbDimensions.textContent =
      item.width && item.height ? `${item.width}×${item.height}` : "";

    el.lbBucketBadge.className = `bucket-badge bucket-${item.bucket}`;
    el.lbBucketBadge.textContent = formatBucketLabel(item.bucket, item.tier);

    renderBadgesInto(el.lbBadgesList, item);

    const trimmedNote = (item.note || "").trim();
    if (trimmedNote) {
      el.lbNotePreview.hidden = false;
      el.lbNotePreview.textContent = `备注：${trimmedNote}`;
    } else {
      el.lbNotePreview.hidden = true;
      el.lbNotePreview.textContent = "";
    }

    el.lbPrev.disabled = pos <= 0;
    el.lbNext.disabled = pos < 0 || pos >= state.visibleIndices.length - 1;
    syncActionDock();
  }

  function preloadNeighborImages() {
    const pos = state.visibleIndices.indexOf(state.activeIndex);
    if (pos < 0) return;
    for (const offset of [-1, 1]) {
      const neighborIdx = state.visibleIndices[pos + offset];
      if (neighborIdx !== undefined && state.items[neighborIdx]) {
        const img = new Image();
        img.src = state.items[neighborIdx].preview_url;
      }
    }
  }

  function getActualPixelScale() {
    const item = state.items[state.activeIndex];
    const baseW = el.lbImage.offsetWidth;
    const natW = el.lbImage.naturalWidth || item?.width || baseW;
    if (!baseW || !natW) return 1;
    return natW / baseW;
  }

  function clampLightboxPan() {
    const lb = state.lightbox;
    if (lb.scale <= 1.005) {
      lb.panX = 0;
      lb.panY = 0;
      return;
    }
    const stageRect = el.lbStage.getBoundingClientRect();
    const baseW = el.lbImage.offsetWidth || stageRect.width;
    const baseH = el.lbImage.offsetHeight || stageRect.height;
    const scaledW = baseW * lb.scale;
    const scaledH = baseH * lb.scale;
    const maxPanX = Math.max(0, (scaledW - stageRect.width) / 2 + 48);
    const maxPanY = Math.max(0, (scaledH - stageRect.height) / 2 + 48);
    lb.panX = Math.max(-maxPanX, Math.min(maxPanX, lb.panX));
    lb.panY = Math.max(-maxPanY, Math.min(maxPanY, lb.panY));
  }

  function updateLightboxTransformUI() {
    const lb = state.lightbox;
    clampLightboxPan();
    el.lbImage.style.transform = `translate3d(${lb.panX.toFixed(1)}px, ${lb.panY.toFixed(
      1
    )}px, 0) scale(${lb.scale.toFixed(4)})`;

    const actualScale = getActualPixelScale();
    const pixelRatioPct = Math.round((lb.scale / actualScale) * 100);
    el.lbZoomLevel.textContent = `${Number.isFinite(pixelRatioPct) && pixelRatioPct > 0 ? pixelRatioPct : 100}%`;

    const isFit = Math.abs(lb.scale - 1) < 0.02;
    const isActual = Math.abs(lb.scale - actualScale) < 0.03;
    el.lbZoomFit.classList.toggle("active", isFit && lb.zoomMode === "fit");
    el.lbZoomActual.classList.toggle("active", isActual && lb.zoomMode === "actual");
    el.lbStage.classList.toggle("lb-stage-zoomed", lb.scale > 1.02);
  }

  function resetLightboxZoom(mode = "fit") {
    const lb = state.lightbox;
    if (mode === "actual") {
      lb.scale = Math.max(0.25, getActualPixelScale());
      lb.zoomMode = "actual";
    } else {
      lb.scale = 1;
      lb.zoomMode = "fit";
    }
    lb.panX = 0;
    lb.panY = 0;
    updateLightboxTransformUI();
  }

  function zoomLightboxAt(nextScale, clientX, clientY, mode = "custom") {
    const lb = state.lightbox;
    const actualScale = getActualPixelScale();
    const maxScale = Math.max(8, actualScale * 4);
    const clamped = Math.max(0.5, Math.min(maxScale, nextScale));

    const rect = el.lbStage.getBoundingClientRect();
    const ox = clientX !== undefined ? clientX - (rect.left + rect.width / 2) : 0;
    const oy = clientY !== undefined ? clientY - (rect.top + rect.height / 2) : 0;

    const prevScale = lb.scale;
    if (Math.abs(clamped - 1) < 0.03 && mode === "custom" && clamped < prevScale) {
      lb.scale = 1;
      lb.panX = 0;
      lb.panY = 0;
      lb.zoomMode = "fit";
    } else {
      const ratio = clamped / prevScale;
      lb.panX = ox - (ox - lb.panX) * ratio;
      lb.panY = oy - (oy - lb.panY) * ratio;
      lb.scale = clamped;
      lb.zoomMode = mode;
    }
    updateLightboxTransformUI();
  }

  /* ------------------------------------------------------------------------
   * Note Modal (N) + Optional Browser SpeechRecognition
   * ---------------------------------------------------------------------- */

  function setupSpeechRecognition() {
    const SpeechCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechCtor) {
      el.btnSpeechToggle.hidden = true;
      return;
    }

    el.btnSpeechToggle.hidden = false;
    const rec = new SpeechCtor();
    rec.lang = "zh-CN";
    rec.continuous = true;
    rec.interimResults = false;

    rec.addEventListener("start", () => {
      state.speechActive = true;
      el.btnSpeechToggle.classList.add("is-recording");
      el.speechBtnText.textContent = "停止语音";
      el.speechStatus.textContent = "正在聆听…";
    });

    rec.addEventListener("result", (event) => {
      let transcript = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        if (event.results[i].isFinal) {
          transcript += event.results[i][0].transcript;
        }
      }
      if (transcript) {
        const cur = el.noteTextarea.value;
        const sep = cur && !cur.endsWith(" ") && !cur.endsWith("\n") ? " " : "";
        el.noteTextarea.value = `${cur}${sep}${transcript.trim()}`;
      }
    });

    rec.addEventListener("error", () => {
      stopSpeechIfActive();
      el.speechStatus.textContent = "语音识别不可用或未授权麦克风";
    });

    rec.addEventListener("end", () => {
      state.speechActive = false;
      el.btnSpeechToggle.classList.remove("is-recording");
      el.speechBtnText.textContent = "语音转文字";
      if (el.speechStatus.textContent === "正在聆听…") {
        el.speechStatus.textContent = "";
      }
    });

    state.speechRec = rec;
  }

  function stopSpeechIfActive() {
    if (state.speechRec && state.speechActive) {
      try {
        state.speechRec.stop();
      } catch {
        // Ignore stop errors
      }
    }
    state.speechActive = false;
    el.btnSpeechToggle.classList.remove("is-recording");
    el.speechBtnText.textContent = "语音转文字";
  }

  function openNoteModal() {
    if (state.activeIndex < 0 || !guardBatchEditable()) return;
    const item = state.items[state.activeIndex];
    state.noteModalOpen = true;
    state.noteTargetIndex = state.activeIndex;
    el.noteModalSub.textContent = `${item.item_id} · R${item.round} (${item.filename})`;
    el.noteTextarea.value = item.note || "";
    el.speechStatus.textContent = "";
    el.noteModal.hidden = false;
    window.setTimeout(() => {
      el.noteTextarea.focus();
      el.noteTextarea.setSelectionRange(el.noteTextarea.value.length, el.noteTextarea.value.length);
    }, 10);
  }

  function closeNoteModal() {
    stopSpeechIfActive();
    state.noteModalOpen = false;
    state.noteTargetIndex = -1;
    el.noteModal.hidden = true;
  }

  function saveNoteFromModal() {
    if (!state.noteModalOpen || state.noteTargetIndex < 0) return;
    const idx = state.noteTargetIndex;
    const item = state.items[idx];
    const nextNote = el.noteTextarea.value.trim();
    closeNoteModal();
    if (item && item.note !== nextNote) {
      applyItemMutation(idx, {
        tier: item.tier,
        flags: item.flags,
        note: nextNote,
      });
    }
  }

  /* ------------------------------------------------------------------------
   * Event Listeners & Global Keyboard Shortcuts
   * ---------------------------------------------------------------------- */

  function isEditableTarget(target) {
    if (!target || !(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    return (
      tag === "TEXTAREA" ||
      tag === "INPUT" ||
      tag === "SELECT" ||
      target.isContentEditable
    );
  }

  function wireEvents() {
    window.addEventListener("hashchange", () => {
      handleRouteChange();
    });

    el.btnBackBatches.addEventListener("click", () => navigateToList());
    el.btnRefresh.addEventListener("click", () => {
      if (state.route === "batch" && state.currentBatchId) {
        fetchAndRenderBatchDetail(state.currentBatchId);
      } else {
        fetchAndRenderBatches();
      }
    });

    // Grid / Masonry toggle
    el.btnViewGrid.addEventListener("click", () => setViewMode("grid"));
    el.btnViewMasonry.addEventListener("click", () => setViewMode("masonry"));

    // ResizeObserver for zero-flicker Masonry spans
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (state.route === "batch" && state.viewMode === "masonry") {
          scheduleMasonryLayout();
        }
      });
      ro.observe(el.galleryContainer);
    }
    window.addEventListener("resize", () => {
      if (state.lightbox.open) updateLightboxTransformUI();
      if (state.route === "batch" && state.viewMode === "masonry") scheduleMasonryLayout();
    });

    // Filter pills
    el.bucketFilterBar.addEventListener("click", (e) => {
      const btn = e.target.closest(".filter-pill");
      if (!btn) return;
      state.filter = btn.dataset.filter || "all";
      renderBatchHeaderAndBanners();
      applyFilterAndSelection(state.activeIndex, false);
    });

    el.btnResetFilter.addEventListener("click", () => {
      state.filter = "all";
      renderBatchHeaderAndBanners();
      applyFilterAndSelection(0, false);
    });

    // Done & Revoke Done buttons
    el.btnMarkDone.addEventListener("click", () => setBatchReviewDone(true));
    el.btnRevokeDone.addEventListener("click", () => setBatchReviewDone(false));
    el.btnBannerRevoke.addEventListener("click", () => setBatchReviewDone(false));

    // Action Dock & Lightbox Footer Verdict Buttons
    document.addEventListener("click", (e) => {
      const tierBtn = e.target.closest("[data-action-tier]");
      if (tierBtn && !tierBtn.disabled) {
        toggleTierOnActive(Number(tierBtn.getAttribute("data-action-tier")));
        return;
      }
      const flagBtn = e.target.closest("[data-action-flag]");
      if (flagBtn && !flagBtn.disabled) {
        toggleFlagOnActive(flagBtn.getAttribute("data-action-flag"));
        return;
      }
      const noteBtn = e.target.closest("[data-action-note]");
      if (noteBtn && !noteBtn.disabled) {
        openNoteModal();
      }
    });

    el.dockPrev.addEventListener("click", () => navigateRelative(-1));
    el.dockNext.addEventListener("click", () => navigateRelative(1));
    el.dockOpenLightbox.addEventListener("click", () => {
      if (state.activeIndex >= 0) openLightbox(state.activeIndex);
    });

    // Lightbox controls
    el.lbClose.addEventListener("click", closeLightbox);
    el.lbPrev.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateRelative(-1);
    });
    el.lbNext.addEventListener("click", (e) => {
      e.stopPropagation();
      navigateRelative(1);
    });
    el.lbZoomFit.addEventListener("click", () => resetLightboxZoom("fit"));
    el.lbZoomActual.addEventListener("click", () => resetLightboxZoom("actual"));
    el.lbZoomIn.addEventListener("click", () =>
      zoomLightboxAt(state.lightbox.scale * 1.35, undefined, undefined, "custom")
    );
    el.lbZoomOut.addEventListener("click", () =>
      zoomLightboxAt(state.lightbox.scale / 1.35, undefined, undefined, "custom")
    );

    el.lbImage.addEventListener("load", () => {
      el.lbImgError.hidden = true;
      el.lbImage.hidden = false;
      updateLightboxTransformUI();
    });

    el.lbImage.addEventListener("error", () => {
      el.lbImage.hidden = true;
      el.lbImgError.hidden = false;
    });

    // Lightbox mouse wheel zoom
    el.lbStage.addEventListener(
      "wheel",
      (e) => {
        if (!state.lightbox.open) return;
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.18 : 1 / 1.18;
        zoomLightboxAt(state.lightbox.scale * factor, e.clientX, e.clientY, "custom");
      },
      { passive: false }
    );

    // Lightbox Pointer Events: drag-to-pan, 2-finger pinch-zoom, double-tap zoom, 1x horizontal swipe
    el.lbStage.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const lb = state.lightbox;
      el.lbStage.setPointerCapture(e.pointerId);
      lb.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (lb.pointers.size === 1) {
        lb.wasMultiTouch = false;
        lb.swipeStartX = e.clientX;
        lb.swipeStartY = e.clientY;
        lb.dragging = lb.scale > 1.02;
        if (lb.dragging) el.lbStage.classList.add("lb-stage-dragging");
      } else if (lb.pointers.size === 2) {
        lb.wasMultiTouch = true;
        lb.dragging = false;
        el.lbStage.classList.remove("lb-stage-dragging");
        const pts = [...lb.pointers.values()];
        lb.pinchPrevDist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        lb.pinchPrevMid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
      }
    });

    el.lbStage.addEventListener("pointermove", (e) => {
      const lb = state.lightbox;
      if (!lb.pointers.has(e.pointerId)) return;
      const prev = lb.pointers.get(e.pointerId);
      const cur = { x: e.clientX, y: e.clientY };
      lb.pointers.set(e.pointerId, cur);

      if (lb.pointers.size === 2) {
        const pts = [...lb.pointers.values()];
        const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
        const mid = {
          x: (pts[0].x + pts[1].x) / 2,
          y: (pts[0].y + pts[1].y) / 2,
        };
        if (lb.pinchPrevDist > 8) {
          const factor = dist / lb.pinchPrevDist;
          if (lb.pinchPrevMid) {
            lb.panX += mid.x - lb.pinchPrevMid.x;
            lb.panY += mid.y - lb.pinchPrevMid.y;
          }
          zoomLightboxAt(lb.scale * factor, mid.x, mid.y, "custom");
        }
        lb.pinchPrevDist = dist;
        lb.pinchPrevMid = mid;
      } else if (lb.pointers.size === 1 && lb.scale > 1.02 && prev) {
        lb.panX += cur.x - prev.x;
        lb.panY += cur.y - prev.y;
        updateLightboxTransformUI();
      }
    });

    const handlePointerEnd = (e) => {
      const lb = state.lightbox;
      if (!lb.pointers.has(e.pointerId)) return;
      lb.pointers.delete(e.pointerId);
      el.lbStage.classList.remove("lb-stage-dragging");

      if (lb.pointers.size === 0) {
        const dx = e.clientX - lb.swipeStartX;
        const dy = e.clientY - lb.swipeStartY;

        // Horizontal swipe navigation when at 1x Fit
        if (!lb.wasMultiTouch && lb.scale <= 1.02 && Math.abs(dx) > 56 && Math.abs(dx) > Math.abs(dy) * 1.4) {
          if (dx < 0) navigateRelative(1);
          else navigateRelative(-1);
          return;
        }

        // Touch double-tap to toggle 1:1 / 2x zoom vs Fit
        if (e.pointerType === "touch" && !lb.wasMultiTouch && Math.hypot(dx, dy) < 14) {
          const now = Date.now();
          if (now - lb.lastTapTime < 300 && Math.hypot(e.clientX - lb.lastTapX, e.clientY - lb.lastTapY) < 32) {
            lb.lastTapTime = 0;
            toggleDoubleZoomAt(e.clientX, e.clientY);
          } else {
            lb.lastTapTime = now;
            lb.lastTapX = e.clientX;
            lb.lastTapY = e.clientY;
          }
        }
      }
    };

    el.lbStage.addEventListener("pointerup", handlePointerEnd);
    el.lbStage.addEventListener("pointercancel", handlePointerEnd);

    el.lbStage.addEventListener("dblclick", (e) => {
      if (e.target.closest("button")) return;
      e.preventDefault();
      toggleDoubleZoomAt(e.clientX, e.clientY);
    });

    function toggleDoubleZoomAt(clientX, clientY) {
      if (state.lightbox.scale > 1.05) {
        resetLightboxZoom("fit");
      } else {
        const target = Math.max(getActualPixelScale(), 2);
        zoomLightboxAt(target, clientX, clientY, target === getActualPixelScale() ? "actual" : "custom");
      }
    }

    // Note Modal events
    el.noteModalClose.addEventListener("click", closeNoteModal);
    el.btnNoteCancel.addEventListener("click", closeNoteModal);
    el.btnNoteSave.addEventListener("click", saveNoteFromModal);
    el.btnNoteClear.addEventListener("click", () => {
      el.noteTextarea.value = "";
      el.noteTextarea.focus();
    });
    el.noteModal.addEventListener("click", (e) => {
      if (e.target === el.noteModal) closeNoteModal();
    });
    el.noteTextarea.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        saveNoteFromModal();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closeNoteModal();
      }
    });

    el.btnSpeechToggle.addEventListener("click", () => {
      if (!state.speechRec) return;
      if (state.speechActive) {
        stopSpeechIfActive();
      } else {
        try {
          state.speechRec.start();
        } catch {
          stopSpeechIfActive();
        }
      }
    });

    // Help Modal events
    el.btnShortcutHelp.addEventListener("click", () => {
      state.helpModalOpen = true;
      el.helpModal.hidden = false;
    });
    el.helpModalClose.addEventListener("click", () => {
      state.helpModalOpen = false;
      el.helpModal.hidden = true;
    });
    el.helpModal.addEventListener("click", (e) => {
      if (e.target === el.helpModal) {
        state.helpModalOpen = false;
        el.helpModal.hidden = true;
      }
    });

    // Global Keyboard Shortcuts (strictly suppressed in <textarea>/<input> & Note Modal)
    document.addEventListener("keydown", (e) => {
      if (state.helpModalOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          state.helpModalOpen = false;
          el.helpModal.hidden = true;
        }
        return;
      }

      // Suppress all review shortcuts while Note editor or any input/textarea has focus
      if (state.noteModalOpen || isEditableTarget(e.target)) {
        if (state.noteModalOpen && e.key === "Escape") {
          e.preventDefault();
          closeNoteModal();
        }
        return;
      }

      // Never hijack browser modifier combinations (Cmd+R, Ctrl+1, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (state.route !== "batch") return;

      const key = e.key;

      if (key === "Escape") {
        if (state.lightbox.open) {
          e.preventDefault();
          closeLightbox();
        }
        return;
      }

      if (key === "?") {
        e.preventDefault();
        state.helpModalOpen = true;
        el.helpModal.hidden = false;
        return;
      }

      if (key === "ArrowLeft") {
        e.preventDefault();
        navigateRelative(-1);
        return;
      }

      if (key === "ArrowRight") {
        e.preventDefault();
        navigateRelative(1);
        return;
      }

      if (key === "Enter" && !state.lightbox.open && !(e.target instanceof HTMLButtonElement)) {
        if (state.activeIndex >= 0) {
          e.preventDefault();
          openLightbox(state.activeIndex);
        }
        return;
      }

      // Lightbox zoom shortcuts
      if (state.lightbox.open) {
        if (key === "0") {
          e.preventDefault();
          resetLightboxZoom("fit");
          return;
        }
        if (key === "=" || key === "+") {
          e.preventDefault();
          zoomLightboxAt(state.lightbox.scale * 1.35, undefined, undefined, "custom");
          return;
        }
        if (key === "-") {
          e.preventDefault();
          zoomLightboxAt(state.lightbox.scale / 1.35, undefined, undefined, "custom");
          return;
        }
      }

      // Tier keys: 1, 2, 3 (pressing same key toggles back to null)
      if (key === "1" || key === "2" || key === "3") {
        e.preventDefault();
        toggleTierOnActive(Number(key));
        return;
      }

      // Flag keys: H, F, O, R (stackable & independent of tier)
      const upper = key.toUpperCase();
      if (upper === "H" || upper === "F" || upper === "O" || upper === "R") {
        e.preventDefault();
        toggleFlagOnActive(upper);
        return;
      }

      // Note key: N
      if (upper === "N") {
        e.preventDefault();
        openNoteModal();
      }
    });
  }

  setupSpeechRecognition();
  wireEvents();
  handleRouteChange();
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  initApp();
}
