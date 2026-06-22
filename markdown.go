package main

import (
	"fmt"
	"strings"
)

func formatMarkdown(comments []ReviewComment, files []PatchFile) string {
	comments = normalizeComments(comments)
	if len(comments) == 0 {
		return "No comments.\n"
	}

	commentsByPath := make(map[string][]ReviewComment, len(comments))
	for _, comment := range comments {
		commentsByPath[comment.Path] = append(commentsByPath[comment.Path], comment)
	}

	var builder strings.Builder
	wrotePath := make(map[string]struct{}, len(files))
	for _, file := range files {
		path := file.displayPath()
		if path == "" {
			continue
		}
		if _, ok := wrotePath[path]; ok {
			continue
		}
		if pathComments := commentsByPath[path]; len(pathComments) > 0 {
			writePathComments(&builder, file, pathComments)
			wrotePath[path] = struct{}{}
		}
	}

	for _, path := range sortedCommentPaths(comments) {
		if _, ok := wrotePath[path]; ok {
			continue
		}
		writePathComments(&builder, PatchFile{Path: path}, commentsByPath[path])
	}

	return builder.String()
}

func writePathComments(builder *strings.Builder, file PatchFile, comments []ReviewComment) {
	path := file.displayPath()

	if builder.Len() > 0 {
		builder.WriteByte('\n')
	}
	fmt.Fprintf(builder, "### %s\n\n", path)
	if file.PrevPath != "" && file.PrevPath != path {
		fmt.Fprintf(builder, "_Renamed from `%s`._\n\n", file.PrevPath)
	}
	for _, comment := range comments {
		fmt.Fprintf(builder, "- %s: %s\n", commentLocation(comment), indentCommentText(comment.Text))
	}
}

func commentLocation(comment ReviewComment) string {
	side := comment.Side
	if side == "" {
		side = "line"
	}
	endSide := comment.EndSide
	if endSide == "" {
		endSide = side
	}
	if comment.StartLine == comment.EndLine {
		return fmt.Sprintf("%s line %d", side, comment.StartLine)
	}
	if endSide != side {
		return fmt.Sprintf("%s line %d to %s line %d", side, comment.StartLine, endSide, comment.EndLine)
	}
	return fmt.Sprintf("%s lines %d-%d", side, comment.StartLine, comment.EndLine)
}

func indentCommentText(text string) string {
	text = strings.TrimSpace(text)
	if !strings.Contains(text, "\n") {
		return text
	}
	return strings.ReplaceAll(text, "\n", "\n  ")
}
