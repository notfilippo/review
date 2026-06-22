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

	program, plan, err := source.diffPlan(options)
	if err != nil {
		return reviewInput{}, err
	}
	source.fromRev = plan.contextFrom
	source.toRev = plan.contextTo
	source.supportsFileContext = plan.supportsFileContext

	patch, err := runCommand(program, appendPathFilters(plan.args, options.paths)...)
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

// diffPlan is the resolved diff invocation: the command args plus the revision
// pair used to load full-file context. Building both together from one switch
// keeps the diff and file-context views from drifting apart and resolves the
// git base revision at most once.
type diffPlan struct {
	args                []string
	contextFrom         string
	contextTo           string
	supportsFileContext bool
}

func (source *vcsSource) diffPlan(options cliOptions) (string, diffPlan, error) {
	switch source.kind {
	case vcsJJ:
		return "jj", source.jjDiffPlan(options), nil
	case vcsGit:
		plan, err := source.gitDiffPlan(options)
		return "git", plan, err
	default:
		return "", diffPlan{}, errors.New("unsupported VCS")
	}
}

func (source *vcsSource) jjDiffPlan(options cliOptions) diffPlan {
	args := []string{"--no-pager", "--color=never", "-R", source.root, "diff", "--git"}
	switch {
	case options.fromRev != "" || options.toRev != "":
		if options.fromRev != "" {
			args = append(args, "--from", options.fromRev)
		}
		if options.toRev != "" {
			args = append(args, "--to", options.toRev)
		}
		return diffPlan{
			args:                args,
			contextFrom:         coalesce(options.fromRev, "@"),
			contextTo:           coalesce(options.toRev, "@"),
			supportsFileContext: true,
		}
	case len(options.revisions) == 0:
		return diffPlan{args: args, contextFrom: "@-", contextTo: "@", supportsFileContext: true}
	default:
		for _, revision := range options.revisions {
			args = append(args, "-r", revision)
		}
		if len(options.revisions) == 1 && isSimpleJJRevision(options.revisions[0]) {
			revision := options.revisions[0]
			return diffPlan{args: args, contextFrom: revision + "-", contextTo: revision, supportsFileContext: true}
		}
		return diffPlan{args: args}
	}
}

func (source *vcsSource) gitDiffPlan(options cliOptions) (diffPlan, error) {
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
		return diffPlan{args: args, contextFrom: options.fromRev, contextTo: options.toRev, supportsFileContext: true}, nil
	case options.fromRev != "":
		args = append(args, options.fromRev)
		return diffPlan{args: args}, nil
	case options.toRev != "":
		args = append(args, "HEAD", options.toRev)
		return diffPlan{args: args, contextFrom: "HEAD", contextTo: options.toRev, supportsFileContext: true}, nil
	case len(options.revisions) == 1:
		baseRevision, err := source.gitCommitBaseRevision(options.revisions[0])
		if err != nil {
			return diffPlan{}, err
		}
		args = append(args, baseRevision, options.revisions[0])
		return diffPlan{args: args, contextFrom: baseRevision, contextTo: options.revisions[0], supportsFileContext: true}, nil
	case len(options.revisions) > 1:
		return diffPlan{}, errors.New("git mode supports at most one -r revision")
	default:
		return diffPlan{args: args}, nil
	}
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
