import {
  DIFF_STYLE_SPLIT,
  DIFF_STYLE_STORAGE_KEY,
  DIFF_STYLE_UNIFIED,
} from "./constants.js";
import { requestJSON } from "./api.js";
import { clearActiveComment, handleCommentShortcut, syncCommentSummary } from "./comments.js";
import {
  bindWorkerCleanup,
  codeViewOptions,
  createDiffWorkerManager,
  handleFileShortcut,
  renderDiffLoading,
  renderDiffMessage,
  renderDiffs,
  renderDiffsAtSameScrollPosition,
  renderFatal,
  setCurrentPath,
  toggleAllFilesCollapsed,
} from "./diff-view.js";
import { setIconButton } from "./icons.js";
import {
  bindSidebarResizer,
  isNarrowViewport,
  restoreSidebarWidth,
  setSidebarTab,
  setupSidebarTabs,
  setTreeCollapsed,
  syncCollapseToggle,
  syncLayoutToggle,
  syncTreeToggle,
} from "./layout.js";
import { buildReviewFiles, fileCommentKey, orderFilesForTree } from "./patch-files.js";
import { computeDiffStats, renderDiffStats } from "./stats.js";
import {
  handleSearchKey,
  refreshSearchResults,
  setupSearch,
} from "./search.js";
import { els, narrowViewportQuery, state } from "./state.js";
import { readSavedDiffStyle, writeStorageValue } from "./storage.js";
import { setupTree } from "./tree.js";
import { afterNextPaint } from "./util.js";

state.diffStyle = readSavedDiffStyle();

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
    state.files = orderFilesForTree(state.files, prepareFileTreeInput);
    state.filesByPath = new Map(state.files.map((file) => [file.reviewId, file]));
    state.filesByTreePath = new Map(state.files.map((file) => [file.treePath, file]));
    state.fileKeyToReviewId = new Map(state.files.map((file) => [fileCommentKey(file.name), file.reviewId]));
    state.patchText = session.patch || "";
    state.diffStats = computeDiffStats(state.patchText, state.files.length);
    refreshSearchResults();

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
      setCurrentPath(firstFile.reviewId, { scrollDiff: false, selectTree: true });
      els.status.textContent = statusText();
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

function statusText() {
  return `${state.files.length} file${state.files.length === 1 ? "" : "s"}`;
}

function bindActions() {
  syncTreeToggle();
  setIconButton(els.done, "Check", "Finish review");
  syncLayoutToggle();
  syncCollapseToggle();
  setupSidebarTabs();
  setupSearch();
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
    if (handleSearchKey(event)) {
      return;
    }
    if (event.key === "Escape" && isNarrowViewport() && !state.treeCollapsed) {
      setTreeCollapsed(true);
      return;
    }
    if (handleCommentShortcut(event)) {
      setSidebarTab("comments");
      return;
    }
    handleFileShortcut(event);
  });

  els.layoutToggle.addEventListener("click", () => {
    state.diffStyle = state.diffStyle === DIFF_STYLE_SPLIT ? DIFF_STYLE_UNIFIED : DIFF_STYLE_SPLIT;
    writeStorageValue(DIFF_STYLE_STORAGE_KEY, state.diffStyle);
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
