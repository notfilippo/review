import {
  TREE_STATUS_ADDED,
  TREE_STATUS_DELETED,
  TREE_STATUS_MODIFIED,
} from "./constants.js";

// Each session file carries its patch and both full versions, so Pierre can
// expand unchanged context locally.
export function buildReviewFiles(session, processFile) {
  return (session.files || []).map((file) => processReviewFile(file, processFile)).filter(Boolean);
}

function processReviewFile(file, processFile) {
  try {
    const processed = processFile(file.patch, {
      cacheKey: `review-${file.path}`,
      isGitDiff: true,
      oldFile: file.old_file,
      newFile: file.new_file,
      throwOnError: true,
    });
    return { ...processed, name: file.path, reviewId: file.path, status: file.status };
  } catch (error) {
    console.warn("Could not process file", file.path, error);
    return undefined;
  }
}

export function orderFilesForTree(files, prepareFileTreeInput) {
  if (files.length < 2) {
    return files;
  }
  const byPath = new Map(files.map((file) => [file.reviewId, file]));
  return prepareFileTreeInput(files.map((file) => file.reviewId))
    .paths
    .map((path) => byPath.get(path))
    .filter(Boolean);
}

export function gitStatus(status) {
  switch (status) {
    case "Added":
      return TREE_STATUS_ADDED;
    case "Deleted":
      return TREE_STATUS_DELETED;
    default:
      return TREE_STATUS_MODIFIED;
  }
}
