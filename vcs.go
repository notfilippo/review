package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	git "github.com/go-git/go-git/v6"
	"github.com/go-git/go-git/v6/plumbing"
	"github.com/go-git/go-git/v6/plumbing/object"
)

type vcsKind string

const (
	vcsJJ  vcsKind = "jj"
	vcsGit vcsKind = "git"

	gitEmptyTreeHash = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
)

type vcsSource struct {
	kind                vcsKind
	root                string
	fromRev             string
	toRev               string
	supportsFileContext bool
	repo                *git.Repository
	fromHash            plumbing.Hash
	toHash              plumbing.Hash
}

func loadVCSReviewInput(options cliOptions) (reviewInput, error) {
	kind, root, err := detectVCS(options.cwd)
	if err != nil {
		return reviewInput{}, err
	}

	source := &vcsSource{
		kind: kind,
		root: root,
	}
	options.paths, err = normalizePathFilters(root, options.cwd, options.paths)
	if err != nil {
		return reviewInput{}, err
	}
	source.fromRev, source.toRev, source.supportsFileContext, err = source.resolveFileContextRevisions(options)
	if err != nil {
		return reviewInput{}, err
	}

	patch, err := source.diff(options)
	if err != nil {
		return reviewInput{}, err
	}
	if strings.TrimSpace(patch) == "" {
		return reviewInput{}, errors.New("VCS diff is empty")
	}
	if source.supportsFileContext {
		if err := source.prepareFileContext(); err != nil {
			return reviewInput{}, err
		}
	}
	return reviewInput{
		patch: patch,
		vcs:   source,
	}, nil
}

func detectVCS(cwd string) (vcsKind, string, error) {
	if root, ok := findRepoRoot(cwd, ".jj"); ok {
		return vcsJJ, root, nil
	}
	if root, ok := findRepoRoot(cwd, ".git"); ok {
		return vcsGit, root, nil
	}
	return "", "", errors.New("no jj or git repository found")
}

func findRepoRoot(dir, marker string) (string, bool) {
	for {
		if _, err := os.Stat(filepath.Join(dir, marker)); err == nil {
			return dir, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", false
		}
		dir = parent
	}
}

func (source *vcsSource) diff(options cliOptions) (string, error) {
	switch source.kind {
	case vcsJJ:
		return source.jjDiff(options)
	case vcsGit:
		return source.gitDiff(options)
	default:
		return "", errors.New("unsupported VCS")
	}
}

func (source *vcsSource) jjDiff(options cliOptions) (string, error) {
	args := []string{"--no-pager", "--color=never", "-R", source.root, "diff", "--git"}
	if options.fromRev != "" || options.toRev != "" {
		if options.fromRev != "" {
			args = append(args, "--from", options.fromRev)
		}
		if options.toRev != "" {
			args = append(args, "--to", options.toRev)
		}
	} else {
		for _, revision := range options.revisions {
			args = append(args, "-r", revision)
		}
	}
	return runCommand("jj", appendPathFilters(args, options.paths)...)
}

func (source *vcsSource) gitDiff(options cliOptions) (string, error) {
	args := []string{
		"-C", source.root,
		"diff",
		"--no-ext-diff",
		"--no-color",
		"--src-prefix=a/",
		"--dst-prefix=b/",
	}
	switch {
	case options.fromRev != "" && options.toRev != "":
		args = append(args, options.fromRev, options.toRev)
	case options.fromRev != "":
		args = append(args, options.fromRev)
	case options.toRev != "":
		args = append(args, "HEAD", options.toRev)
	case len(options.revisions) == 1:
		baseRevision, err := source.gitCommitBaseRevision(options.revisions[0])
		if err != nil {
			return "", err
		}
		args = append(args, baseRevision, options.revisions[0])
	case len(options.revisions) > 1:
		return "", errors.New("git mode supports at most one -r revision")
	}
	return runCommand("git", appendPathFilters(args, options.paths)...)
}

func appendPathFilters(args []string, paths []string) []string {
	if len(paths) == 0 {
		return args
	}
	args = append(args, "--")
	return append(args, paths...)
}

func normalizePathFilters(root, cwd string, paths []string) ([]string, error) {
	if len(paths) == 0 {
		return nil, nil
	}
	root, err := canonicalDir(root)
	if err != nil {
		return nil, err
	}
	if cwd == "" {
		cwd, err = os.Getwd()
		if err != nil {
			return nil, err
		}
	}
	cwd, err = canonicalDir(cwd)
	if err != nil {
		return nil, err
	}
	normalized := make([]string, 0, len(paths))
	for _, path := range paths {
		fullPath := path
		if !filepath.IsAbs(fullPath) {
			fullPath = filepath.Join(cwd, path)
		} else if resolved, err := filepath.EvalSymlinks(fullPath); err == nil {
			fullPath = resolved
		}
		rel, err := filepath.Rel(root, filepath.Clean(fullPath))
		if err != nil {
			return nil, err
		}
		if rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, fmt.Errorf("path %q is outside repository", path)
		}
		normalized = append(normalized, filepath.ToSlash(rel))
	}
	return normalized, nil
}

func canonicalDir(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	resolved, err := filepath.EvalSymlinks(absolute)
	if err != nil {
		return "", err
	}
	return resolved, nil
}

func (source *vcsSource) resolveFileContextRevisions(options cliOptions) (string, string, bool, error) {
	switch source.kind {
	case vcsJJ:
		fromRev, toRev, ok := resolveJJFileContextRevisions(options)
		return fromRev, toRev, ok, nil
	case vcsGit:
		return source.resolveGitFileContextRevisions(options)
	default:
		return "", "", false, nil
	}
}

func resolveJJFileContextRevisions(options cliOptions) (string, string, bool) {
	if options.fromRev != "" || options.toRev != "" {
		fromRev := options.fromRev
		if fromRev == "" {
			fromRev = "@"
		}
		toRev := options.toRev
		if toRev == "" {
			toRev = "@"
		}
		return fromRev, toRev, true
	}
	if len(options.revisions) == 0 {
		return "@-", "@", true
	}
	if len(options.revisions) == 1 && isSimpleJJRevision(options.revisions[0]) {
		return options.revisions[0] + "-", options.revisions[0], true
	}
	return "", "", false
}

func (source *vcsSource) resolveGitFileContextRevisions(options cliOptions) (string, string, bool, error) {
	switch {
	case options.fromRev != "" && options.toRev != "":
		return options.fromRev, options.toRev, true, nil
	case options.toRev != "":
		return "HEAD", options.toRev, true, nil
	case len(options.revisions) == 1:
		baseRevision, err := source.gitCommitBaseRevision(options.revisions[0])
		if err != nil {
			return "", "", false, err
		}
		return baseRevision, options.revisions[0], true, nil
	default:
		return "", "", false, nil
	}
}

func isSimpleJJRevision(revision string) bool {
	if revision == "" {
		return false
	}
	return !strings.ContainsAny(revision, " \t\n()|&~:")
}

func (source *vcsSource) prepareFileContext() error {
	repo, err := source.openGitRepository()
	if err != nil {
		return err
	}
	source.repo = repo

	fromHash, err := source.resolveCommitHash(source.fromRev)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", source.fromRev, err)
	}
	toHash, err := source.resolveCommitHash(source.toRev)
	if err != nil {
		return fmt.Errorf("resolve %s: %w", source.toRev, err)
	}
	source.fromHash = fromHash
	source.toHash = toHash
	return nil
}

func (source *vcsSource) resolveCommitHash(revision string) (plumbing.Hash, error) {
	switch source.kind {
	case vcsJJ:
		return source.resolveJJCommitHash(revision)
	case vcsGit:
		return source.resolveGitCommitHash(revision)
	default:
		return plumbing.ZeroHash, errors.New("unsupported VCS")
	}
}

func (source *vcsSource) resolveJJCommitHash(revision string) (plumbing.Hash, error) {
	output, err := runCommand(
		"jj",
		"--no-pager",
		"--color=never",
		"-R",
		source.root,
		"log",
		"-r",
		revision,
		"--no-graph",
		"-T",
		"commit_id ++ \"\\n\"",
	)
	if err != nil {
		return plumbing.ZeroHash, err
	}
	lines := strings.Fields(output)
	if len(lines) != 1 {
		return plumbing.ZeroHash, fmt.Errorf("expected one commit id, got %d", len(lines))
	}
	hash, ok := plumbing.FromHex(lines[0])
	if !ok {
		return plumbing.ZeroHash, fmt.Errorf("invalid commit id %q", lines[0])
	}
	return hash, nil
}

func (source *vcsSource) resolveGitCommitHash(revision string) (plumbing.Hash, error) {
	if revision == gitEmptyTreeHash {
		return plumbing.ZeroHash, nil
	}
	hash, err := source.repo.ResolveRevision(plumbing.Revision(revision))
	if err != nil {
		return plumbing.ZeroHash, err
	}
	return *hash, nil
}

func (source *vcsSource) gitCommitBaseRevision(revision string) (string, error) {
	repo, err := source.openGitRepository()
	if err != nil {
		return "", err
	}
	hash, err := repo.ResolveRevision(plumbing.Revision(revision))
	if err != nil {
		return "", err
	}
	commit, err := repo.CommitObject(*hash)
	if err != nil {
		return "", err
	}
	if commit.NumParents() == 0 {
		return gitEmptyTreeHash, nil
	}
	parent, err := commit.Parent(0)
	if err != nil {
		return "", err
	}
	return parent.Hash.String(), nil
}

func (source *vcsSource) openGitRepository() (*git.Repository, error) {
	if source.repo != nil {
		return source.repo, nil
	}
	repo, err := git.PlainOpen(source.root)
	if err != nil {
		return nil, err
	}
	source.repo = repo
	return repo, nil
}

func (source *vcsSource) oldFileContents(path string) (string, error) {
	return source.gitFileContents(source.fromHash, path)
}

func (source *vcsSource) newFileContents(path string) (string, error) {
	return source.gitFileContents(source.toHash, path)
}

func (source *vcsSource) gitFileContents(commitHash plumbing.Hash, path string) (string, error) {
	if source.repo == nil {
		return "", errors.New("git repository is not open")
	}
	if commitHash.IsZero() {
		return "", object.ErrFileNotFound
	}
	commit, err := source.repo.CommitObject(commitHash)
	if err != nil {
		return "", err
	}
	file, err := commit.File(path)
	if err != nil {
		return "", err
	}
	return file.Contents()
}

func runCommand(name string, args ...string) (string, error) {
	var stdout bytes.Buffer
	var stderr bytes.Buffer
	cmd := exec.Command(name, args...)
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("%s %s: %s", name, strings.Join(args, " "), message)
	}
	return stdout.String(), nil
}
