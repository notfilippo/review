import {
  DIFF_BOTTOM_PADDING_REM,
  DIFF_THEME,
  NEXT_FILE_KEYS,
  PREVIOUS_FILE_KEYS,
} from "./constants.js";
import createDiffsWorker from "https://esm.sh/@pierre/diffs@1.2.11/worker/worker-portable.js?worker";
import {
  annotationsForFile,
  applyActiveSelection,
  createAnnotationCard,
  findAnnotationComment,
  startDraft,
  syncCommentSummary,
} from "./comments.js";
import { setIconButton } from "./icons.js";
import { syncCollapseToggle } from "./layout.js";
import { els, state } from "./state.js";
import { syncTreeSelection } from "./tree.js";
import { clamp, isEditableTarget, rem } from "./util.js";

export function renderDiffLoading(message) {
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

export function renderDiffMessage(className, message) {
  const node = document.createElement("div");
  node.className = className;
  node.textContent = message;
  els.diff.replaceChildren(node);
}

export function renderFatal(error) {
  els.status.textContent = "Error";
  renderDiffMessage("error", error instanceof Error ? error.message : String(error));
}

export function codeViewOptions() {
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
      return createFileHeaderPrefix(fileDiff);
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

export function createDiffWorkerManager(getOrCreateWorkerPoolSingleton, files, getFiletypeFromFileName) {
  try {
    return getOrCreateWorkerPoolSingleton({
      poolOptions: {
        workerFactory: () => createDiffsWorker(),
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

export function bindWorkerCleanup(terminateWorkerPoolSingleton) {
  if (typeof terminateWorkerPoolSingleton !== "function") {
    return;
  }
  window.addEventListener("pagehide", terminateWorkerPoolSingleton, { once: true });
}

export function setCurrentPath(path, options = {}) {
  const { scrollDiff = true, selectTree = false } = options;
  state.currentPath = path;
  const file = state.filesByPath.get(path);
  if (state.tree && selectTree) {
    syncTreeSelection(path);
  }
  if (state.tree && file) {
    state.tree.scrollToPath(file.treePath, { focus: false, offset: "nearest" });
  }
  if (scrollDiff) {
    scrollToCurrentFile("smooth");
  }
}

export function renderDiffs() {
  nextRenderVersion();
  state.codeView.setItems(state.files.map((file) => codeViewItem(file)));
  state.codeView.render(true);
  applyActiveSelection();
  syncCommentSummary();
  syncCollapseToggle();
}

function codeViewItem(file) {
  return {
    id: file.reviewId,
    type: "diff",
    fileDiff: file,
    annotations: annotationsForFile(file),
    collapsed: state.collapsedFiles.has(file.reviewId),
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
  if (!state.codeView.getItem(file.reviewId)) {
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

export function handleFileShortcut(event) {
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

  const currentIndex = state.files.findIndex((file) => file.reviewId === state.currentPath);
  const fallbackIndex = delta > 0 ? -1 : state.files.length;
  const nextIndex = clamp(
    currentIndex === -1 ? fallbackIndex + delta : currentIndex + delta,
    0,
    state.files.length - 1,
  );
  const nextFile = state.files[nextIndex];
  if (nextFile && nextFile.reviewId !== state.currentPath) {
    setCurrentPath(nextFile.reviewId, { scrollDiff: true, selectTree: true });
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

export function toggleAllFilesCollapsed() {
  if (!state.codeView) {
    return;
  }
  state.collapsedFiles = allFilesCollapsed() ? new Set() : new Set(state.files.map((file) => file.reviewId));
  renderDiffsAtSameScrollPosition();
}

export function renderDiffsAtSameScrollPosition() {
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

export function allFilesCollapsed() {
  return state.files.length > 0 && state.files.every((file) => state.collapsedFiles.has(file.reviewId));
}

function createFileHeaderPrefix(fileDiff) {
  if (!fileDiff?.reviewId) {
    return undefined;
  }
  const wrapper = document.createElement("span");
  wrapper.className = "file-header-prefix";
  wrapper.append(createFileCollapseButton(fileDiff.reviewId));
  return wrapper;
}

function createFileCollapseButton(reviewId) {
  const collapsed = state.collapsedFiles.has(reviewId);
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
    toggleFileCollapsed(reviewId);
  });
  button.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
  });
  return button;
}
