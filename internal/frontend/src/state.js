import { DIFF_STYLE_SPLIT, NARROW_VIEWPORT_QUERY } from "./constants.js";

export const narrowViewportQuery = window.matchMedia(NARROW_VIEWPORT_QUERY);

// Single mutable store shared across modules. diffStyle is seeded from storage
// in init() before the diff renders.
export const state = {
  token: new URLSearchParams(window.location.search).get("token") || "",
  comments: [],
  files: [],
  filesByPath: new Map(),
  currentPath: "",
  diffStyle: DIFF_STYLE_SPLIT,
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

export const els = {
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
