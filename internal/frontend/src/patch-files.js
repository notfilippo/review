import {
  TREE_STATUS_ADDED,
  TREE_STATUS_DELETED,
  TREE_STATUS_MODIFIED,
  TREE_STATUS_RENAMED,
} from "./constants.js";

export function buildReviewFiles(session, parsePatchFiles, processFile) {
  const files = parseReviewFiles(session, parsePatchFiles, processFile);
  return files.map(decorateReviewFile);
}

export function fileCommentKey(path) {
  return path;
}

function parseReviewFiles(session, parsePatchFiles, processFile) {
  const parsedFiles = flattenParsedPatch(parsePatchFiles(session.patch || "", "review", true));
  const contexts = Array.isArray(session.file_contexts) ? session.file_contexts : [];
  let files = parsedFiles;
  if (contexts.length > 0 && typeof processFile === "function") {
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
      if (context.old_file && context.old_file.name) {
        contextFiles.set(context.old_file.name, file);
      }
      if (context.new_file && context.new_file.name) {
        contextFiles.set(context.new_file.name, file);
      }
    }
    files = parsedFiles.length === 0
      ? [...new Set(contextFiles.values())]
      : parsedFiles.map((file) => contextFiles.get(file.name) || contextFiles.get(file.prevName) || file);
  }

  if (files.length === 0 && Array.isArray(session.files)) {
    files = session.files.map((file) => ({ name: file.path, prevName: file.prev_path, type: file.status, hunks: [] }));
  }

  return files;
}

function decorateReviewFile(file) {
  const path = file.name || file.path || file.prevName || file.prev_path || "unknown";
  return {
    ...file,
    name: path,
    reviewId: path,
    treePath: path,
    commentKey: fileCommentKey(path),
  };
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

function processContextFile(context, processFile) {
  if (!context || typeof context.patch !== "string" || !context.old_file || !context.new_file) {
    return undefined;
  }
  try {
    return processFile(context.patch, {
      cacheKey: `review-context-${context.old_file.name}:${context.new_file.name}`,
      isGitDiff: true,
      oldFile: context.old_file,
      newFile: context.new_file,
      throwOnError: true,
    });
  } catch (error) {
    console.warn("Could not process file context", context, error);
    return undefined;
  }
}

export function orderFilesForTree(files, prepareFileTreeInput) {
  if (typeof prepareFileTreeInput !== "function" || files.length < 2) {
    return files;
  }
  const byPath = new Map(files.map((file) => [file.treePath, file]));
  return prepareFileTreeInput(files.map((file) => file.treePath))
    .paths
    .map((path) => byPath.get(path))
    .filter(Boolean);
}

export function gitStatus(type) {
  switch (type) {
    case "Added":
    case "new":
      return TREE_STATUS_ADDED;
    case "Deleted":
    case "deleted":
      return TREE_STATUS_DELETED;
    case "Renamed":
    case "rename-pure":
    case "rename-changed":
      return TREE_STATUS_RENAMED;
    case "Modified":
    default:
      return TREE_STATUS_MODIFIED;
  }
}
