package main

import (
	"sort"
	"strconv"
	"strings"
)

const (
	fileStatusAdded    = "added"
	fileStatusDeleted  = "deleted"
	fileStatusModified = "modified"
	fileStatusRenamed  = "renamed"
)

type PatchFile struct {
	Path     string `json:"path"`
	PrevPath string `json:"prevPath,omitempty"`
	Status   string `json:"status"`
}

func (file PatchFile) displayPath() string {
	return coalesce(file.Path, file.PrevPath)
}

func (file PatchFile) contextPaths() (string, string) {
	oldPath := coalesce(file.PrevPath, file.Path)
	newPath := coalesce(file.Path, oldPath)
	return oldPath, newPath
}

func coalesce(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func parsePatchFiles(patch string) []PatchFile {
	var files []PatchFile
	current := PatchFile{}
	hasCurrent := false

	flush := func() {
		if !hasCurrent {
			return
		}
		if current.Path == "" {
			current.Path = current.PrevPath
		}
		if current.Status == "" {
			current.Status = fileStatusModified
		}
		if current.Path != "" {
			files = append(files, current)
		}
		current = PatchFile{}
		hasCurrent = false
	}

	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			flush()
			hasCurrent = true
			prev, next := parseDiffGitLine(line)
			current.PrevPath = prev
			current.Path = next
			current.Status = fileStatusModified
		case hasCurrent && strings.HasPrefix(line, "new file mode "):
			current.Status = fileStatusAdded
		case hasCurrent && strings.HasPrefix(line, "deleted file mode "):
			current.Status = fileStatusDeleted
		case hasCurrent && strings.HasPrefix(line, "rename from "):
			current.PrevPath = normalizePatchPath(strings.TrimPrefix(line, "rename from "))
			current.Status = fileStatusRenamed
		case hasCurrent && strings.HasPrefix(line, "rename to "):
			current.Path = normalizePatchPath(strings.TrimPrefix(line, "rename to "))
			current.Status = fileStatusRenamed
		case strings.HasPrefix(line, "--- "):
			if !hasCurrent {
				hasCurrent = true
			}
			prev := normalizePatchHeaderPath(strings.TrimPrefix(line, "--- "))
			if prev != "" {
				current.PrevPath = prev
			}
		case strings.HasPrefix(line, "+++ "):
			if !hasCurrent {
				hasCurrent = true
			}
			next := normalizePatchHeaderPath(strings.TrimPrefix(line, "+++ "))
			if next != "" {
				current.Path = next
			}
		}
	}
	flush()

	return dedupePatchFiles(files)
}

func parseDiffGitLine(line string) (string, string) {
	rest := strings.TrimPrefix(line, "diff --git ")
	prev, next, ok := splitDiffGitPaths(rest)
	if !ok {
		return "", ""
	}
	return normalizePrefixedPatchPath(prev), normalizePrefixedPatchPath(next)
}

func normalizePatchHeaderPath(path string) string {
	path = strings.TrimSpace(path)
	if idx := strings.IndexByte(path, '\t'); idx >= 0 {
		path = path[:idx]
	}
	if path == "/dev/null" {
		return ""
	}
	return normalizePrefixedPatchPath(path)
}

func normalizePatchPath(path string) string {
	path = strings.TrimSpace(path)
	if unquoted, err := strconv.Unquote(path); err == nil {
		path = unquoted
	} else {
		path = strings.Trim(path, "\"")
	}
	return path
}

func normalizePrefixedPatchPath(path string) string {
	path = normalizePatchPath(path)
	path = strings.TrimPrefix(path, "a/")
	path = strings.TrimPrefix(path, "b/")
	return path
}

func splitDiffGitPaths(rest string) (string, string, bool) {
	rest = strings.TrimSpace(rest)
	if rest == "" {
		return "", "", false
	}
	if strings.HasPrefix(rest, "\"") {
		prev, remaining, ok := splitQuotedPath(rest)
		if !ok {
			return "", "", false
		}
		next := strings.TrimSpace(remaining)
		if next == "" {
			return "", "", false
		}
		if strings.HasPrefix(next, "\"") {
			quotedNext, trailing, ok := splitQuotedPath(next)
			if ok && strings.TrimSpace(trailing) == "" {
				return prev, quotedNext, true
			}
		}
		return prev, next, true
	}
	return splitUnquotedDiffGitPaths(rest)
}

func splitQuotedPath(value string) (string, string, bool) {
	escaped := false
	for idx := 1; idx < len(value); idx++ {
		switch {
		case escaped:
			escaped = false
		case value[idx] == '\\':
			escaped = true
		case value[idx] == '"':
			return value[:idx+1], value[idx+1:], true
		}
	}
	return "", "", false
}

func splitUnquotedDiffGitPaths(rest string) (string, string, bool) {
	firstPrev := ""
	firstNext := ""
	for idx := strings.Index(rest, " b/"); idx >= 0; {
		prev := rest[:idx]
		next := strings.TrimSpace(rest[idx+1:])
		if strings.HasPrefix(prev, "a/") && strings.HasPrefix(next, "b/") {
			if firstPrev == "" {
				firstPrev = prev
				firstNext = next
			}
			if normalizePrefixedPatchPath(prev) == normalizePrefixedPatchPath(next) {
				return prev, next, true
			}
		}
		nextStart := idx + len(" b/")
		nextIdx := strings.Index(rest[nextStart:], " b/")
		if nextIdx < 0 {
			break
		}
		idx = nextStart + nextIdx
	}
	return firstPrev, firstNext, firstPrev != ""
}

func dedupePatchFiles(files []PatchFile) []PatchFile {
	seen := make(map[string]int, len(files))
	out := make([]PatchFile, 0, len(files))
	for _, file := range files {
		key := file.displayPath()
		if key == "" {
			continue
		}
		if existing, ok := seen[key]; ok {
			out[existing] = file
			continue
		}
		seen[key] = len(out)
		out = append(out, file)
	}
	return out
}

// parsePatch parses the git patch in a single pass, returning the deduped file
// list and a map from each path to the raw per-file patch chunk it belongs to.
func parsePatch(patch string) ([]PatchFile, map[string]string) {
	chunks := splitGitFilePatches(patch)
	if len(chunks) == 0 {
		// No "diff --git" headers (plain unified diff); the per-file chunk map is
		// meaningless, so fall back to a whole-patch parse for the file list.
		return parsePatchFiles(patch), nil
	}

	files := make([]PatchFile, 0, len(chunks))
	filePatches := make(map[string]string)
	for _, chunk := range chunks {
		for _, file := range parsePatchFiles(chunk) {
			files = append(files, file)
			if file.Path != "" {
				filePatches[file.Path] = chunk
			}
			if file.PrevPath != "" {
				filePatches[file.PrevPath] = chunk
			}
		}
	}
	return dedupePatchFiles(files), filePatches
}

func splitGitFilePatches(patch string) []string {
	var patches []string
	start := -1
	for lineStart := 0; lineStart < len(patch); {
		lineEnd := strings.IndexByte(patch[lineStart:], '\n')
		if lineEnd == -1 {
			lineEnd = len(patch)
		} else {
			lineEnd += lineStart + 1
		}

		if strings.HasPrefix(patch[lineStart:lineEnd], "diff --git ") {
			if start >= 0 {
				patches = append(patches, patch[start:lineStart])
			}
			start = lineStart
		}
		lineStart = lineEnd
	}
	if start >= 0 {
		patches = append(patches, patch[start:])
	}
	return patches
}

func sortedCommentPaths(comments []ReviewComment) []string {
	seen := make(map[string]struct{}, len(comments))
	paths := make([]string, 0, len(comments))
	for _, comment := range comments {
		if comment.Path == "" {
			continue
		}
		if _, ok := seen[comment.Path]; ok {
			continue
		}
		seen[comment.Path] = struct{}{}
		paths = append(paths, comment.Path)
	}
	sort.Strings(paths)
	return paths
}
