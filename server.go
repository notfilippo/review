package main

import (
	"crypto/rand"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"net/http"
	"slices"
	"strings"
	"sync"
)

const (
	reviewTokenBytes = 16
	commentKindRange = "range"
)

//go:embed internal/static
var embeddedStatic embed.FS

type ReviewComment struct {
	ID        string `json:"id"`
	Path      string `json:"path"`
	Kind      string `json:"kind"`
	Side      string `json:"side,omitempty"`
	EndSide   string `json:"endSide,omitempty"`
	StartLine int    `json:"startLine,omitempty"`
	EndLine   int    `json:"endLine,omitempty"`
	Text      string `json:"text"`
}

type reviewSession struct {
	token       string
	patch       string
	files       []PatchFile
	filePatches map[string]string
	vcs         *vcsSource

	mu       sync.Mutex
	comments []ReviewComment
	done     chan struct{}
	once     sync.Once
}

type sessionResponse struct {
	Patch        string                `json:"patch"`
	Files        []PatchFile           `json:"files"`
	FileContexts []fileContextResponse `json:"fileContexts,omitempty"`
	Comments     []ReviewComment       `json:"comments"`
}

type commentsRequest struct {
	Comments []ReviewComment `json:"comments"`
}

type fileContentsResponse struct {
	Name     string `json:"name"`
	Contents string `json:"contents"`
}

type fileContextResponse struct {
	Patch   string               `json:"patch"`
	OldFile fileContentsResponse `json:"oldFile"`
	NewFile fileContentsResponse `json:"newFile"`
}

func newReviewSession(input reviewInput) (*reviewSession, error) {
	token, err := newToken()
	if err != nil {
		return nil, err
	}
	files := parsePatchFiles(input.patch)
	return &reviewSession{
		token:       token,
		patch:       input.patch,
		files:       files,
		filePatches: mapFilePatches(input.patch),
		vcs:         input.vcs,
		done:        make(chan struct{}),
	}, nil
}

func newToken() (string, error) {
	var raw [reviewTokenBytes]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func (s *reviewSession) routes() http.Handler {
	staticRoot, err := fs.Sub(embeddedStatic, "internal/static")
	if err != nil {
		panic(err)
	}

	mux := http.NewServeMux()
	staticHandler := http.FileServer(http.FS(staticRoot))
	mux.Handle("/static/", http.StripPrefix("/static/", staticHandler))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		http.ServeFileFS(w, r, staticRoot, "index.html")
	})
	mux.HandleFunc("/api/session", s.handleSession)
	mux.HandleFunc("/api/comments", s.handleComments)
	mux.HandleFunc("/api/complete", s.handleComplete)
	return mux
}

func (s *reviewSession) handleSession(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r, http.MethodGet) {
		return
	}

	contexts, err := s.fileContexts()
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}

	resp := sessionResponse{
		Patch:        s.patch,
		Files:        slices.Clone(s.files),
		FileContexts: contexts,
		Comments:     s.commentsSnapshot(),
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *reviewSession) fileContexts() ([]fileContextResponse, error) {
	if s.vcs == nil || !s.vcs.supportsFileContext {
		return nil, nil
	}

	contexts := make([]fileContextResponse, 0, len(s.files))
	for _, file := range s.files {
		rawPatch := s.rawFilePatch(file)
		if rawPatch == "" {
			continue
		}
		context, err := s.fileContext(file, rawPatch)
		if err != nil {
			return nil, err
		}
		contexts = append(contexts, context)
	}
	return contexts, nil
}

func (s *reviewSession) rawFilePatch(file PatchFile) string {
	rawPatch := s.filePatches[file.displayPath()]
	if rawPatch == "" && file.PrevPath != "" {
		rawPatch = s.filePatches[file.PrevPath]
	}
	return rawPatch
}

func (s *reviewSession) handleComments(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r, http.MethodPut) {
		return
	}

	if err := s.replaceCommentsFromRequest(r); err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	writeOK(w)
}

func (s *reviewSession) handleComplete(w http.ResponseWriter, r *http.Request) {
	if !s.allow(w, r, http.MethodPost) {
		return
	}

	if r.Body != nil && r.ContentLength != 0 {
		if err := s.replaceCommentsFromRequest(r); err != nil {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
	}

	s.once.Do(func() {
		close(s.done)
	})
	writeOK(w)
}

func (s *reviewSession) allow(w http.ResponseWriter, r *http.Request, method string) bool {
	if !s.authorized(r) {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	if r.Method != method {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
		return false
	}
	return true
}

func (s *reviewSession) fileContext(file PatchFile, rawPatch string) (fileContextResponse, error) {
	oldPath, newPath := file.contextPaths()

	oldContents := ""
	if file.Status != fileStatusAdded {
		contents, err := s.vcs.oldFileContents(oldPath)
		if err != nil {
			return fileContextResponse{}, fmt.Errorf("read old file %s: %w", oldPath, err)
		}
		oldContents = contents
	}

	newContents := ""
	if file.Status != fileStatusDeleted {
		contents, err := s.vcs.newFileContents(newPath)
		if err != nil {
			return fileContextResponse{}, fmt.Errorf("read new file %s: %w", newPath, err)
		}
		newContents = contents
	}

	return fileContextResponse{
		Patch: rawPatch,
		OldFile: fileContentsResponse{
			Name:     oldPath,
			Contents: oldContents,
		},
		NewFile: fileContentsResponse{
			Name:     newPath,
			Contents: newContents,
		},
	}, nil
}

func (s *reviewSession) authorized(r *http.Request) bool {
	token := r.Header.Get("X-Review-Token")
	if token == "" {
		token = r.URL.Query().Get("token")
	}
	return token != "" && token == s.token
}

func (s *reviewSession) commentsSnapshot() []ReviewComment {
	s.mu.Lock()
	defer s.mu.Unlock()
	return slices.Clone(s.comments)
}

func (s *reviewSession) replaceCommentsFromRequest(r *http.Request) error {
	comments, err := decodeComments(r)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.comments = normalizeComments(comments)
	return nil
}

func decodeComments(r *http.Request) ([]ReviewComment, error) {
	defer r.Body.Close()
	var req commentsRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		return nil, err
	}
	return req.Comments, nil
}

func normalizeComments(comments []ReviewComment) []ReviewComment {
	normalized := make([]ReviewComment, 0, len(comments))
	for _, comment := range comments {
		comment.Text = strings.TrimSpace(comment.Text)
		comment.Path = strings.TrimSpace(comment.Path)
		if comment.Path == "" || comment.Text == "" {
			continue
		}
		comment.Kind = commentKindRange
		if comment.StartLine <= 0 {
			continue
		}
		if comment.Side == "" && comment.EndSide != "" {
			comment.Side = comment.EndSide
		}
		if comment.EndSide == "" {
			comment.EndSide = comment.Side
		}
		if comment.EndLine <= 0 {
			comment.EndLine = comment.StartLine
		}
		if comment.EndLine < comment.StartLine {
			comment.StartLine, comment.EndLine = comment.EndLine, comment.StartLine
			comment.Side, comment.EndSide = comment.EndSide, comment.Side
		}
		normalized = append(normalized, comment)
	}
	return normalized
}

func writeOK(w http.ResponseWriter) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"error": message})
}
