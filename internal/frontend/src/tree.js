import { setCurrentPath } from "./diff-view.js";
import { isNarrowViewport, setTreeCollapsed } from "./layout.js";
import { gitStatus } from "./patch-files.js";
import { els, state } from "./state.js";

export function setupTree(FileTree) {
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

export function syncTreeSelection(path, selectedPaths = state.tree.getSelectedPaths?.() || []) {
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
