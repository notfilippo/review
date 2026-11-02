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
    return { ...processed, name: file.path, status: file.status };
  } catch (error) {
    console.warn("Could not process file", file.path, error);
    return undefined;
  }
}

export function orderFilesForTree(files, prepareFileTreeInput) {
  if (files.length < 2) {
    return files;
  }
  const byPath = new Map(files.map((file) => [file.name, file]));
  return prepareFileTreeInput(files.map((file) => file.name))
    .paths
    .map((path) => byPath.get(path))
    .filter(Boolean);
}
