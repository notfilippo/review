import "./style.css";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Rows2,
  Trash2,
  X,
  createElement,
} from "lucide";

const DIFF_STYLE_STORAGE_KEY = "review.diffStyle";
const SIDEBAR_WIDTH_STORAGE_KEY = "review.sidebarWidth";
const DIFF_STYLE_SPLIT = "split";
const DIFF_STYLE_UNIFIED = "unified";
const DIFF_THEME = { light: "pierre-light", dark: "pierre-dark" };
const NARROW_VIEWPORT_QUERY = "(max-width: 56.25rem)";
const FALLBACK_ROOT_FONT_SIZE = 16;
const DIFF_BOTTOM_PADDING_REM = 0.5;
const SIDEBAR_RESIZE_STEP = 16;
const DEFAULT_COMMENT_SIDE = "additions";
const COMMENT_KIND_RANGE = "range";
const TREE_STATUS_ADDED = "added";
const TREE_STATUS_DELETED = "deleted";
const TREE_STATUS_MODIFIED = "modified";
const TREE_STATUS_RENAMED = "renamed";
const NEXT_FILE_KEYS = new Set(["j", "]"]);
const PREVIOUS_FILE_KEYS = new Set(["k", "["]);

const narrowViewportQuery = window.matchMedia(NARROW_VIEWPORT_QUERY);
const icons = {
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Columns2,
  PanelBottomClose,
  PanelBottomOpen,
  PanelLeftClose,
  PanelLeftOpen,
  Pencil,
  Rows2,
  Trash2,
  X,
};

const state = {
  token: new URLSearchParams(window.location.search).get("token") || "",
  comments: [],
  files: [],
  filesByPath: new Map(),
  currentPath: "",
  diffStyle: readSavedDiffStyle(),
  diffStats: { files: 0, additions: 0, deletions: 0, lines: 0 },
  codeView: null,
  tree: null,
  draft: null,
  editingId: "",
  hoveredCommentId: "",
  treeCollapsed: false,
  collapsedFiles: new Set(),
  syncingTree: false,
  renderVersion: 0,
  completed: false,
};

const els = {
  status: document.querySelector("#status"),
  workspace: document.querySelector(".workspace"),
  sidebar: document.querySelector(".sidebar"),
  sidebarResizer: document.querySelector("#sidebar-resizer"),
  tree: document.querySelector("#tree"),
  treeBackdrop: document.querySelector("#tree-backdrop"),
  diff: document.querySelector("#diff"),
  diffStats: document.querySelector("#diff-stats"),
  diffStatsSummary: document.querySelector("#diff-stats-summary"),
  commentSummary: document.querySelector("#comment-summary"),
  treeToggle: document.querySelector("#tree-toggle"),
  layoutToggle: document.querySelector("#layout-toggle"),
  collapseToggle: document.querySelector("#collapse-toggle"),
  done: document.querySelector("#done"),
};

init();

async function init() {
  try {
    if (!state.token) {
      throw new Error("Missing review token");
    }
    bindActions();
    const [
      { CodeView, getFiletypeFromFileName, parsePatchFiles, processFile },
      { FileTree, prepareFileTreeInput },
      { getOrCreateWorkerPoolSingleton, terminateWorkerPoolSingleton },
    ] = await Promise.all([
      import("@pierre/diffs"),
      import("@pierre/trees"),
      import("@pierre/diffs/worker"),
    ]);
    bindWorkerCleanup(terminateWorkerPoolSingleton);
    renderDiffLoading("Loading review");
    const session = await requestJSON("/api/session");
    state.comments = Array.isArray(session.comments) ? session.comments : [];
    renderDiffLoading("Processing diff");
    await afterNextPaint();
    state.files = buildReviewFiles(session, parsePatchFiles, processFile);
    if (state.files.length === 0 && Array.isArray(session.files)) {
      state.files = session.files.map((file) => ({ name: file.path, type: file.status, hunks: [] }));
    }
    state.files = orderFilesForTree(state.files, prepareFileTreeInput);
    state.filesByPath = new Map(state.files.map((file) => [file.name, file]));
    state.diffStats = computeDiffStats(session.patch, state.files.length);

    setupTree(FileTree);
    const workerManager = createDiffWorkerManager(getOrCreateWorkerPoolSingleton, state.files, getFiletypeFromFileName);
    state.codeView = new CodeView(codeViewOptions(), workerManager);
    els.diff.replaceChildren();
    state.codeView.setup(els.diff);
    renderDiffStats();
    syncCommentSummary();

    const firstFile = state.files[0];
    if (firstFile) {
      renderDiffs();
      setCurrentPath(firstFile.name, { scrollDiff: false, selectTree: true });
      els.status.textContent = `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
    } else {
      els.status.textContent = "No files";
      renderDiffMessage("annotation-empty", "No files found in patch.");
    }
  } catch (error) {
    if (state.completed) {
      return;
    }
    renderFatal(error);
  }
}

function renderDiffLoading(message) {
  els.diff.replaceChildren();
  const loader = document.createElement("div");
  loader.className = "diff-loading";
  loader.setAttribute("role", "status");
  loader.setAttribute("aria-live", "polite");

  const spinner = document.createElement("span");
  spinner.className = "diff-loading-spinner";
  spinner.setAttribute("aria-hidden", "true");

  const label = document.createElement("span");
  label.textContent = message;
  loader.append(spinner, label);
  els.diff.append(loader);
  els.status.textContent = message;
}

function renderDiffMessage(className, message) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = message;
  els.diff.replaceChildren(node);
}

function afterNextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      setTimeout(resolve, 0);
    });
  });
}

function flattenParsedPatch(parsedPatches) {
  const files = [];
  const seen = new Set();
  for (const patch of parsedPatches || []) {
    for (const file of patch.files || []) {
      if (!seen.has(file.name)) {
        seen.add(file.name);
        files.push(file);
      }
    }
  }
  return files;
}

function buildReviewFiles(session, parsePatchFiles, processFile) {
  const parsedFiles = flattenParsedPatch(parsePatchFiles(session.patch, "review", true));
  const contexts = Array.isArray(session.fileContexts) ? session.fileContexts : [];
  if (contexts.length === 0 || typeof processFile !== "function") {
    return parsedFiles;
  }

  const contextFiles = new Map();
  for (const context of contexts) {
    const file = processContextFile(context, processFile);
    if (!file) {
      continue;
    }
    contextFiles.set(file.name, file);
    if (file.prevName) {
      contextFiles.set(file.prevName, file);
    }
    if (context.oldFile && context.oldFile.name) {
      contextFiles.set(context.oldFile.name, file);
    }
    if (context.newFile && context.newFile.name) {
      contextFiles.set(context.newFile.name, file);
    }
  }

  if (parsedFiles.length === 0) {
    return [...new Set(contextFiles.values())];
  }
  return parsedFiles.map((file) => contextFiles.get(file.name) || contextFiles.get(file.prevName) || file);
}

function processContextFile(context, processFile) {
  if (!context || typeof context.patch !== "string" || !context.oldFile || !context.newFile) {
    return undefined;
  }
  try {
    return processFile(context.patch, {
      cacheKey: `review-context-${context.oldFile.name}:${context.newFile.name}`,
      isGitDiff: true,
      oldFile: context.oldFile,
      newFile: context.newFile,
      throwOnError: true,
    });
  } catch (error) {
    console.warn("Could not process file context", context, error);
    return undefined;
  }
}

function orderFilesForTree(files, prepareFileTreeInput) {
  if (typeof prepareFileTreeInput !== "function" || files.length < 2) {
    return files;
  }
  const byPath = new Map(files.map((file) => [file.name, file]));
  return prepareFileTreeInput(files.map((file) => file.name))
    .paths
    .map((path) => byPath.get(path))
    .filter(Boolean);
}

function computeDiffStats(patch, fileCount) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      additions += 1;
    } else if (line.startsWith("-")) {
      deletions += 1;
    }
  }
  return {
    files: fileCount,
    additions,
    deletions,
    lines: additions + deletions,
  };
}

function renderDiffStats() {
  const stats = state.diffStats;
  els.diffStatsSummary.textContent = `${stats.lines.toLocaleString()} lines`;
  els.diffStats.replaceChildren(
    createChangeBar(stats),
    createStatGrid(
      createStatItem("Files", stats.files),
      createStatItem("Additions", stats.additions, "addition"),
      createStatItem("Deletions", stats.deletions, "deletion"),
      createStatItem("Lines", stats.lines),
    ),
  );
}

function createChangeBar(stats) {
  const bar = document.createElement("div");
  bar.className = "change-bar";
  const additions = document.createElement("span");
  additions.className = "addition";
  additions.style.flexGrow = String(stats.additions || 0);
  const deletions = document.createElement("span");
  deletions.className = "deletion";
  deletions.style.flexGrow = String(stats.deletions || 0);
  if (stats.lines === 0) {
    additions.style.flexGrow = "1";
  }
  bar.append(additions, deletions);
  return bar;
}

function createStatGrid(...items) {
  const grid = document.createElement("dl");
  grid.className = "diff-stats-grid";
  grid.append(...items);
  return grid;
}

function createStatItem(label, value, tone = "") {
  const fragment = document.createDocumentFragment();
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.className = tone;
  detail.textContent = value.toLocaleString();
  fragment.append(term, detail);
  return fragment;
}

function setupTree(FileTree) {
  state.tree = new FileTree({
    paths: state.files.map((file) => file.name),
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    search: true,
    gitStatus: state.files.map((file) => ({ path: file.name, status: gitStatus(file.type) })),
    onSelectionChange(selectedPaths) {
      if (state.syncingTree) {
        return;
      }
      const path = selectedTreeFilePath(selectedPaths);
      if (!path) {
        return;
      }
      syncTreeSelection(path, selectedPaths);
      if (isNarrowViewport()) {
        setTreeCollapsed(true);
      }
      setCurrentPath(path, { scrollDiff: true, selectTree: false });
    },
  });
  state.tree.render({ containerWrapper: els.tree });
}

function selectedTreeFilePath(selectedPaths) {
  const focusedPath = state.tree.getFocusedPath?.() || "";
  if (state.filesByPath.has(focusedPath) && selectedPaths.includes(focusedPath)) {
    return focusedPath;
  }
  return [...selectedPaths].reverse().find((path) => state.filesByPath.has(path)) || "";
}

function codeViewOptions() {
  return {
    diffStyle: state.diffStyle,
    theme: DIFF_THEME,
    layout: { paddingTop: 0, paddingBottom: rem(DIFF_BOTTOM_PADDING_REM), gap: 0 },
    overflow: "scroll",
    stickyHeaders: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    lineHoverHighlight: "both",
    hunkSeparators: "line-info",
    renderHeaderPrefix(fileDiff) {
      return createFileHeaderToggle(fileDiff);
    },
    onGutterUtilityClick(range, context) {
      startDraft(context?.item?.id, range);
    },
    renderAnnotation(annotation) {
      const comment = findAnnotationComment(annotation.metadata?.commentId);
      if (!comment) {
        return undefined;
      }
      return createAnnotationCard(comment);
    },
    onLineSelectionEnd(range, context) {
      startDraft(context?.item?.id, range);
    },
  };
}

function createDiffWorkerManager(getOrCreateWorkerPoolSingleton, files, getFiletypeFromFileName) {
  try {
    return getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => new DiffsWorker(),
      },
      highlighterOptions: {
        theme: DIFF_THEME,
        langs: languagesForFiles(files, getFiletypeFromFileName),
      },
    });
  } catch (error) {
    console.warn("Could not start diff worker pool", error);
    return undefined;
  }
}

function languagesForFiles(files, getFiletypeFromFileName) {
  if (typeof getFiletypeFromFileName !== "function") {
    return [];
  }
  const languages = new Set();
  for (const file of files) {
    const language = getFiletypeFromFileName(file.name);
    if (language && language !== "text") {
      languages.add(language);
    }
  }
  return [...languages];
}

function bindWorkerCleanup(terminateWorkerPoolSingleton) {
  if (typeof terminateWorkerPoolSingleton !== "function") {
    return;
  }
  window.addEventListener("pagehide", terminateWorkerPoolSingleton, { once: true });
}

function bindActions() {
  syncTreeToggle();
  setIconButton(els.done, "Check", "Finish review");
  syncLayoutToggle();
  syncCollapseToggle();
  restoreSidebarWidth();
  setTreeCollapsed(isNarrowViewport());
  bindSidebarResizer();

  els.treeToggle.addEventListener("click", () => {
    setTreeCollapsed(!state.treeCollapsed);
  });

  els.treeBackdrop.addEventListener("click", () => {
    setTreeCollapsed(true);
  });

  narrowViewportQuery.addEventListener("change", (event) => {
    setTreeCollapsed(event.matches);
  });
  window.addEventListener("resize", () => {
    syncTreeToggle();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && isNarrowViewport() && !state.treeCollapsed) {
      setTreeCollapsed(true);
      return;
    }
    handleFileShortcut(event);
  });

  els.layoutToggle.addEventListener("click", () => {
    state.diffStyle = state.diffStyle === DIFF_STYLE_SPLIT ? DIFF_STYLE_UNIFIED : DIFF_STYLE_SPLIT;
    saveDiffStyle(state.diffStyle);
    syncLayoutToggle();
    if (!state.codeView) {
      return;
    }
    state.codeView.setOptions(codeViewOptions());
    renderDiffsAtSameScrollPosition();
  });

  els.collapseToggle.addEventListener("click", toggleAllFilesCollapsed);

  els.done.addEventListener("click", async () => {
    els.done.disabled = true;
    state.draft = null;
    clearActiveComment();
    if (state.codeView) {
      renderDiffs();
    }
    await requestJSON("/api/complete", {
      method: "POST",
      body: JSON.stringify({ comments: state.comments }),
    });
    state.completed = true;
    els.status.textContent = "Completed";
    closeReviewWindow();
  });
}

function closeReviewWindow() {
  window.close();
  setTimeout(() => {
    els.status.textContent = "Completed, close this tab";
  }, 250);
}

function syncTreeToggle() {
  const bottomSheet = isNarrowViewport();
  const treeLabel = state.treeCollapsed ? "Show file tree" : "Hide file tree";
  const iconName = bottomSheet
    ? (state.treeCollapsed ? "PanelBottomOpen" : "PanelBottomClose")
    : (state.treeCollapsed ? "PanelLeftOpen" : "PanelLeftClose");
  setIconButton(
    els.treeToggle,
    iconName,
    treeLabel,
  );
}

function syncLayoutToggle() {
  const iconName = state.diffStyle === DIFF_STYLE_SPLIT ? "Columns2" : "Rows2";
  setIconButton(els.layoutToggle, iconName, `${state.diffStyle} diff`);
}

function syncCollapseToggle() {
  const expand = allFilesCollapsed();
  setIconButton(
    els.collapseToggle,
    expand ? "ChevronsUpDown" : "ChevronsDownUp",
    expand ? "Expand all files" : "Collapse all files",
  );
}

function setIconButton(button, iconName, label) {
  const icon = createLucideIcon(iconName);
  if (icon) {
    button.replaceChildren(icon);
  } else {
    button.textContent = label;
  }
  button.setAttribute("aria-label", label);
  button.title = label;
}

function createLucideIcon(iconName) {
  const iconNode = icons[iconName];
  if (!iconNode) {
    return undefined;
  }
  const svg = createElement(iconNode);
  svg.classList.add("icon");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  return svg;
}

function setCurrentPath(path, options = {}) {
  const { scrollDiff = true, selectTree = false } = options;
  state.currentPath = path;
  if (state.tree && selectTree) {
    syncTreeSelection(path);
  }
  if (state.tree) {
    state.tree.scrollToPath(path, { focus: false, offset: "nearest" });
  }
  if (scrollDiff) {
    scrollToCurrentFile("smooth");
  }
}

function syncTreeSelection(path, selectedPaths = state.tree.getSelectedPaths?.() || []) {
  const item = state.tree && state.tree.getItem(path);
  if (!item) {
    return;
  }
  if (item.isSelected() && selectedPaths.length === 1 && selectedPaths[0] === path) {
    return;
  }

  state.syncingTree = true;
  try {
    for (const selectedPath of selectedPaths) {
      if (selectedPath !== path) {
        state.tree.getItem(selectedPath)?.deselect();
      }
    }
    if (!item.isSelected()) {
      item.select();
    }
  } finally {
    state.syncingTree = false;
  }
}

function renderDiffs() {
  nextRenderVersion();
  state.codeView.setItems(state.files.map((file) => codeViewItem(file)));
  state.codeView.render(true);
  applyActiveSelection();
  syncCommentSummary();
  syncCollapseToggle();
}

function codeViewItem(file) {
  return {
    id: file.name,
    type: "diff",
    fileDiff: file,
    annotations: annotationsForPath(file.name),
    collapsed: state.collapsedFiles.has(file.name),
    version: state.renderVersion,
  };
}

function nextRenderVersion() {
  state.renderVersion += 1;
}

function refreshFileDiff(path) {
  const file = state.filesByPath.get(path);
  if (!file || !state.codeView) {
    return false;
  }

  nextRenderVersion();
  if (!state.codeView.getItem(file.name)) {
    return false;
  }

  const updated = state.codeView.updateItem(codeViewItem(file));
  if (updated) {
    applyActiveSelection();
    syncCommentSummary();
    syncCollapseToggle();
  }
  return updated;
}

function scrollToCurrentFile(behavior) {
  if (!state.currentPath || !state.codeView) {
    return;
  }
  state.codeView.scrollTo({
    type: "item",
    id: state.currentPath,
    align: "start",
    behavior,
  });
}

function handleFileShortcut(event) {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target)) {
    return;
  }
  const key = event.key.toLowerCase();
  if (NEXT_FILE_KEYS.has(key)) {
    event.preventDefault();
    moveCurrentFile(1);
  } else if (PREVIOUS_FILE_KEYS.has(key)) {
    event.preventDefault();
    moveCurrentFile(-1);
  }
}

function moveCurrentFile(delta) {
  if (state.files.length === 0) {
    return;
  }

  const currentIndex = state.files.findIndex((file) => file.name === state.currentPath);
  const fallbackIndex = delta > 0 ? -1 : state.files.length;
  const nextIndex = clamp(
    currentIndex === -1 ? fallbackIndex + delta : currentIndex + delta,
    0,
    state.files.length - 1,
  );
  const nextFile = state.files[nextIndex];
  if (nextFile && nextFile.name !== state.currentPath) {
    setCurrentPath(nextFile.name, { scrollDiff: true, selectTree: true });
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isEditableTarget(target) {
  if (!(target instanceof Element)) {
    return false;
  }
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || target.isContentEditable;
}

function annotationsForPath(path) {
  const comments = state.comments.filter((comment) => comment.path === path && comment.kind === COMMENT_KIND_RANGE);
  if (state.draft && state.draft.path === path && state.draft.kind === COMMENT_KIND_RANGE) {
    comments.push(state.draft);
  }
  return comments.map((comment) => ({
    side: annotationSide(comment),
    lineNumber: annotationLine(comment),
    metadata: { commentId: comment.id },
  }));
}

function startDraft(path, range) {
  if (!range || !path || !state.filesByPath.has(path)) {
    return;
  }
  const normalized = normalizeRange(range);
  setCurrentPath(path, { scrollDiff: false, selectTree: true });
  clearActiveComment();
  state.draft = {
    id: `draft-${crypto.randomUUID()}`,
    kind: COMMENT_KIND_RANGE,
    path,
    ...normalized,
    text: "",
    draft: true,
  };
  renderDiffs();
}

function setTreeCollapsed(collapsed) {
  state.treeCollapsed = collapsed;
  els.workspace.classList.toggle("tree-collapsed", collapsed);
  els.workspace.classList.toggle("tree-open", !collapsed);
  els.treeToggle.setAttribute("aria-pressed", String(!collapsed));
  syncTreeToggle();
}

function isNarrowViewport() {
  return narrowViewportQuery.matches;
}

function bindSidebarResizer() {
  els.sidebarResizer.addEventListener("pointerdown", (event) => {
    if (isNarrowViewport()) {
      return;
    }
    event.preventDefault();
    els.workspace.classList.add("sidebar-resizing");
    const pointerId = event.pointerId;
    els.sidebarResizer.setPointerCapture(pointerId);

    const resize = (moveEvent) => {
      setSidebarWidth(moveEvent.clientX - els.workspace.getBoundingClientRect().left);
    };
    const stop = () => {
      els.workspace.classList.remove("sidebar-resizing");
      els.sidebarResizer.removeEventListener("pointermove", resize);
      els.sidebarResizer.removeEventListener("pointerup", stop);
      els.sidebarResizer.removeEventListener("pointercancel", stop);
      if (els.sidebarResizer.hasPointerCapture(pointerId)) {
        els.sidebarResizer.releasePointerCapture(pointerId);
      }
      saveSidebarWidth();
    };

    els.sidebarResizer.addEventListener("pointermove", resize);
    els.sidebarResizer.addEventListener("pointerup", stop);
    els.sidebarResizer.addEventListener("pointercancel", stop);
  });

  els.sidebarResizer.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    setSidebarWidth(currentSidebarWidth() + direction * SIDEBAR_RESIZE_STEP);
    saveSidebarWidth();
  });
}

function restoreSidebarWidth() {
  const width = Number(readStorageValue(SIDEBAR_WIDTH_STORAGE_KEY));
  if (Number.isFinite(width) && width > 0) {
    setSidebarWidth(width);
  }
}

function setSidebarWidth(width) {
  const nextWidth = Math.max(0, width);
  els.workspace.style.setProperty("--sidebar-width", `${nextWidth}px`);
  els.sidebarResizer.setAttribute("aria-valuenow", String(Math.round(nextWidth)));
}

function currentSidebarWidth() {
  return els.sidebar.getBoundingClientRect().width;
}

function saveSidebarWidth() {
  writeStorageValue(SIDEBAR_WIDTH_STORAGE_KEY, String(Math.round(currentSidebarWidth())));
}

function rem(value) {
  const rootSize = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return value * (Number.isFinite(rootSize) ? rootSize : FALLBACK_ROOT_FONT_SIZE);
}

function readSavedDiffStyle() {
  const value = readStorageValue(DIFF_STYLE_STORAGE_KEY);
  if (value === DIFF_STYLE_SPLIT || value === DIFF_STYLE_UNIFIED) {
    return value;
  }
  return DIFF_STYLE_SPLIT;
}

function saveDiffStyle(diffStyle) {
  writeStorageValue(DIFF_STYLE_STORAGE_KEY, diffStyle);
}

function readStorageValue(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    // Storage can be disabled.
    return null;
  }
}

function writeStorageValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage can be disabled.
  }
}

function toggleFileCollapsed(path) {
  if (!path || !state.filesByPath.has(path)) {
    return;
  }
  const itemTop = state.codeView.getTopForItem(path);
  const wasAboveViewport = itemTop != null && itemTop < state.codeView.getScrollTop();
  if (state.collapsedFiles.has(path)) {
    state.collapsedFiles.delete(path);
  } else {
    state.collapsedFiles.add(path);
  }
  if (!refreshFileDiff(path)) {
    renderDiffsAtSameScrollPosition();
    return;
  }
  if (wasAboveViewport) {
    state.codeView.scrollTo({
      type: "item",
      id: path,
      align: "start",
      behavior: "instant",
    });
  }
}

function toggleAllFilesCollapsed() {
  if (!state.codeView) {
    return;
  }
  if (allFilesCollapsed()) {
    state.collapsedFiles.clear();
  } else {
    state.collapsedFiles = new Set(state.files.map((file) => file.name));
  }
  renderDiffsAtSameScrollPosition();
}

function renderDiffsAtSameScrollPosition() {
  const scrollTop = state.codeView.getScrollTop();
  renderDiffs();
  queueMicrotask(() => {
    state.codeView.scrollTo({
      type: "position",
      position: scrollTop,
      behavior: "instant",
    });
  });
}

function allFilesCollapsed() {
  return state.files.length > 0 && state.files.every((file) => state.collapsedFiles.has(file.name));
}

function createFileHeaderToggle(fileDiff) {
  const path = fileDiff && fileDiff.name;
  if (!path) {
    return undefined;
  }
  return createFileCollapseButton(path);
}

function createFileCollapseButton(path) {
  const collapsed = state.collapsedFiles.has(path);
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button file-collapse-button";
  setIconButton(
    button,
    collapsed ? "ChevronRight" : "ChevronDown",
    collapsed ? "Expand file" : "Collapse file",
  );
  button.setAttribute("aria-expanded", String(!collapsed));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleFileCollapsed(path);
  });
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  return button;
}

function createAnnotationAction(iconName, label, className = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button annotation-icon-button${className ? ` ${className}` : ""}`;
  setIconButton(button, iconName, label);
  return button;
}

function createAnnotationCard(comment) {
  const card = document.createElement("article");
  card.className = "annotation-card";
  stopDiffEvents(card);
  card.addEventListener("mouseenter", () => {
    state.hoveredCommentId = comment.id;
    applyActiveSelection();
  });
  card.addEventListener("mouseleave", () => {
    if (state.hoveredCommentId === comment.id) {
      clearHoveredComment();
      applyActiveSelection();
    }
  });

  const meta = document.createElement("div");
  meta.className = "annotation-meta";
  meta.textContent = comment.draft ? `New comment · ${rangeLabel(comment)}` : `You · ${rangeLabel(comment)}`;
  card.append(meta);

  if (comment.draft || state.editingId === comment.id) {
    card.append(createAnnotationEditor(comment));
    return card;
  }

  const text = document.createElement("div");
  text.className = "annotation-text";
  text.textContent = comment.text;
  card.append(text);

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  const edit = createAnnotationAction("Pencil", "Edit");
  edit.addEventListener("click", () => {
    state.draft = null;
    state.editingId = comment.id;
    clearHoveredComment();
    renderDiffs();
  });
  const remove = createAnnotationAction("Trash2", "Delete", "danger");
  remove.addEventListener("click", async () => {
    await deleteComment(comment.id);
  });
  actions.append(edit, remove);
  card.append(actions);
  return card;
}

function createAnnotationEditor(comment) {
  const fragment = document.createDocumentFragment();
  const textarea = document.createElement("textarea");
  textarea.placeholder = "Add comment";
  textarea.value = comment.text || "";
  textarea.addEventListener("keydown", (event) => {
    if (isSubmitShortcut(event)) {
      event.preventDefault();
      void saveInlineComment(comment, textarea.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelInlineComment(comment);
    }
  });

  const actions = document.createElement("div");
  actions.className = "annotation-actions";
  const cancel = createAnnotationAction("X", "Cancel");
  cancel.addEventListener("click", () => {
    cancelInlineComment(comment);
  });
  const save = createAnnotationAction("Check", "Save", "primary");
  save.addEventListener("click", async () => {
    await saveInlineComment(comment, textarea.value);
  });
  actions.append(cancel, save);

  fragment.append(textarea, actions);
  queueMicrotask(() => textarea.focus());
  return fragment;
}

function isSubmitShortcut(event) {
  return event.key === "Enter" && (event.metaKey || event.ctrlKey);
}

function cancelInlineComment(comment) {
  if (comment.draft) {
    state.draft = null;
  }
  clearActiveComment();
  renderDiffs();
}

async function saveInlineComment(comment, value) {
  const text = value.trim();
  if (!text) {
    return;
  }

  if (comment.draft) {
    const { draft, ...saved } = comment;
    state.comments.push({
      ...saved,
      id: crypto.randomUUID(),
      text,
    });
    state.draft = null;
  } else {
    const existing = state.comments.find((item) => item.id === comment.id);
    if (existing) {
      existing.text = text;
    }
  }

  clearActiveComment();
  renderDiffs();
  await saveComments();
}

async function deleteComment(id) {
  state.comments = state.comments.filter((comment) => comment.id !== id);
  if (state.editingId === id) {
    state.editingId = "";
  }
  if (state.hoveredCommentId === id) {
    clearHoveredComment();
  }
  renderDiffs();
  await saveComments();
}

function clearActiveComment() {
  state.editingId = "";
  clearHoveredComment();
}

function clearHoveredComment() {
  state.hoveredCommentId = "";
}

function findAnnotationComment(id) {
  if (!id) {
    return undefined;
  }
  if (state.draft && state.draft.id === id) {
    return state.draft;
  }
  return state.comments.find((comment) => comment.id === id);
}

function activeSelectionComment() {
  if (state.draft) {
    return state.draft;
  }
  const id = state.editingId || state.hoveredCommentId;
  return id ? state.comments.find((comment) => comment.id === id) : undefined;
}

function applyActiveSelection() {
  if (!state.codeView) {
    return;
  }
  const comment = activeSelectionComment();
  if (!comment) {
    state.codeView.clearSelectedLines({ notify: false });
    return;
  }
  queueMicrotask(() => {
    state.codeView.setSelectedLines({
      id: comment.path,
      range: selectionRange(comment),
    }, { notify: false });
  });
}

function syncCommentSummary() {
  const count = state.comments.length;
  els.commentSummary.textContent = `${count} comment${count === 1 ? "" : "s"}`;
}

async function saveComments() {
  await requestJSON("/api/comments", {
    method: "PUT",
    body: JSON.stringify({ comments: state.comments }),
  });
  syncCommentSummary();
}

async function requestJSON(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Review-Token": state.token,
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(await responseErrorMessage(response));
  }
  return response.json();
}

async function responseErrorMessage(response) {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = await response.json();
    return body.error || message;
  } catch {
    return message;
  }
}

function normalizeRange(range) {
  if (range.start <= range.end) {
    return {
      side: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
      startLine: range.start,
      endLine: range.end,
      endSide: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    };
  }
  return {
    side: range.endSide || range.side || DEFAULT_COMMENT_SIDE,
    startLine: range.end,
    endLine: range.start,
    endSide: range.side || range.endSide || DEFAULT_COMMENT_SIDE,
  };
}

function selectionRange(comment) {
  return {
    start: comment.startLine,
    side: comment.side || DEFAULT_COMMENT_SIDE,
    end: comment.endLine,
    endSide: comment.endSide || comment.side || DEFAULT_COMMENT_SIDE,
  };
}

function annotationLine(comment) {
  return comment.endLine || comment.startLine;
}

function annotationSide(comment) {
  return comment.endSide || comment.side || DEFAULT_COMMENT_SIDE;
}

function rangeLabel(comment) {
  const side = comment.side || "line";
  if (comment.startLine === comment.endLine) {
    return `${side} line ${comment.startLine}`;
  }
  return `${side} lines ${comment.startLine}-${comment.endLine}`;
}

function gitStatus(type) {
  switch (type) {
    case "new":
      return TREE_STATUS_ADDED;
    case "deleted":
      return TREE_STATUS_DELETED;
    case "rename-pure":
    case "rename-changed":
      return TREE_STATUS_RENAMED;
    default:
      return TREE_STATUS_MODIFIED;
  }
}

function stopDiffEvents(node) {
  for (const eventName of ["click", "pointerdown", "keydown"]) {
    node.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function renderFatal(error) {
  els.status.textContent = "Error";
  renderDiffMessage("error", error instanceof Error ? error.message : String(error));
}
