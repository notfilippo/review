import {
  TREE_STATUS_ADDED,
  TREE_STATUS_DELETED,
  TREE_STATUS_MODIFIED,
  TREE_STATUS_RENAMED,
} from "./constants.js";

export function buildReviewFiles(session, parsePatchFiles, processFile) {
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

export function orderFilesForTree(files, prepareFileTreeInput) {
  if (typeof prepareFileTreeInput !== "function" || files.length < 2) {
    return files;
  }
  const byPath = new Map(files.map((file) => [file.name, file]));
  return prepareFileTreeInput(files.map((file) => file.name))
    .paths
    .map((path) => byPath.get(path))
    .filter(Boolean);
}

export function gitStatus(type) {
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
