import { setCurrentPath } from "./diff-view.js";
import { isNarrowViewport, setTreeCollapsed } from "./layout.js";
import { gitStatus } from "./patch-files.js";
import { els, state } from "./state.js";

export function setupTree(FileTree) {
  state.tree = new FileTree({
    paths: state.files.map((file) => file.treePath),
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    search: true,
    gitStatus: state.files.map((file) => ({ path: file.treePath, status: gitStatus(file.type) })),
    onSelectionChange(selectedPaths) {
      if (state.syncingTree) {
        return;
      }
      const path = selectedTreeFilePath(selectedPaths);
      if (!path) {
        return;
      }
      const file = state.filesByTreePath.get(path);
      if (!file) {
        return;
      }
      syncTreeSelection(file.reviewId, selectedPaths);
      if (isNarrowViewport()) {
        setTreeCollapsed(true);
      }
      setCurrentPath(file.reviewId, { scrollDiff: true, selectTree: false });
    },
  });
  state.tree.render({ containerWrapper: els.tree });
}

function selectedTreeFilePath(selectedPaths) {
  const focusedPath = state.tree.getFocusedPath?.() || "";
  if (state.filesByTreePath.has(focusedPath) && selectedPaths.includes(focusedPath)) {
    return focusedPath;
  }
  return [...selectedPaths].reverse().find((path) => state.filesByTreePath.has(path)) || "";
}

export function syncTreeSelection(path, selectedPaths = state.tree.getSelectedPaths?.() || []) {
  const file = state.filesByPath.get(path);
  const treePath = file?.treePath || path;
  const item = state.tree && state.tree.getItem(treePath);
  if (!item) {
    return;
  }
  if (item.isSelected() && selectedPaths.length === 1 && selectedPaths[0] === treePath) {
    return;
  }

  state.syncingTree = true;
  try {
    for (const selectedPath of selectedPaths) {
      if (selectedPath !== treePath) {
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
