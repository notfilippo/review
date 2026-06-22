import {
  DIFF_STYLE_SPLIT,
  SIDEBAR_RESIZE_STEP,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "./constants.js";
import { allFilesCollapsed } from "./diff-view.js";
import { setIconButton } from "./icons.js";
import { els, narrowViewportQuery, state } from "./state.js";
import { readStorageValue, writeStorageValue } from "./storage.js";

export function isNarrowViewport() {
  return narrowViewportQuery.matches;
}

export function setTreeCollapsed(collapsed) {
  state.treeCollapsed = collapsed;
  els.workspace.classList.toggle("tree-collapsed", collapsed);
  els.workspace.classList.toggle("tree-open", !collapsed);
  els.treeToggle.setAttribute("aria-pressed", String(!collapsed));
  syncTreeToggle();
}

export function syncTreeToggle() {
  const bottomSheet = isNarrowViewport();
  const treeLabel = state.treeCollapsed ? "Show file tree" : "Hide file tree";
  const iconName = bottomSheet
    ? (state.treeCollapsed ? "PanelBottomOpen" : "PanelBottomClose")
    : (state.treeCollapsed ? "PanelLeftOpen" : "PanelLeftClose");
  setIconButton(els.treeToggle, iconName, treeLabel);
}

export function syncLayoutToggle() {
  const iconName = state.diffStyle === DIFF_STYLE_SPLIT ? "Columns2" : "Rows2";
  setIconButton(els.layoutToggle, iconName, `${state.diffStyle} diff`);
}

export function syncCollapseToggle() {
  const expand = allFilesCollapsed();
  setIconButton(
    els.collapseToggle,
    expand ? "ChevronsUpDown" : "ChevronsDownUp",
    expand ? "Expand all files" : "Collapse all files",
  );
}

export function bindSidebarResizer() {
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

export function restoreSidebarWidth() {
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
