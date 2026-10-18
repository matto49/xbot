package web

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"unicode/utf8"

	"xbot/tools"
)

// A single lock also serializes aliases (symlinks and hard links) and saves
// made through different WebChannel instances. It is not a cross-process lock.
var fsSaveMu sync.Mutex

// JSON escaping can expand one content byte to six bytes (e.g. control chars).
const maxFsWriteRequestSize = 6*maxFileReadSize + 64*1024

func fsContentVersion(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func fsWriteError(w http.ResponseWriter, status int, code, message string) {
	writeAPIResponse(w, status, apiResponse{OK: false, Error: &apiError{Code: code, Message: message}})
}

// fsLocalAccess uses the same canonical session resolver as the session REST
// APIs. Remote/offline/denied sandboxes never fall back to server file access.
// The runner file protocol has no conditional atomic replacement operation;
// exposing its unconditional WriteFile as safe save would silently lose edits.
func (wc *WebChannel) fsLocalAccess(w http.ResponseWriter, r *http.Request, channel, chatID string) bool {
	sel, ok := wc.resolveAPISession(w, r, senderIDFromContext(r.Context()), channel, chatID)
	if !ok {
		return false
	}
	sb := tools.GetSandbox()
	if resolver, ok := sb.(tools.SandboxResolver); ok {
		sb = resolver.SandboxForSession(sel.Channel + ":" + sel.ChatID)
	}
	if sb == nil || sb.Name() != "none" {
		fsWriteError(w, http.StatusNotImplemented, "safe_save_unsupported", "File editing is unavailable for this execution target: runner conditional atomic writes are not supported")
		return false
	}
	return true
}

// handleFsWrite conditionally replaces an existing, complete UTF-8 text file.
// expectedVersion is the SHA-256 returned by /api/fs/read, never a timestamp.
func (wc *WebChannel) handleFsWrite(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		fsWriteError(w, 405, "method_not_allowed", "method not allowed")
		return
	}
	if senderIDFromContext(r.Context()) == "" {
		fsWriteError(w, 401, "unauthorized", "unauthorized")
		return
	}
	var body struct {
		Path            string  `json:"path"`
		Content         *string `json:"content"`
		ExpectedVersion string  `json:"expectedVersion"`
		Channel         string  `json:"channel,omitempty"`
		ChatID          string  `json:"chat_id,omitempty"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxFsWriteRequestSize)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&body)
	if err == nil {
		var extra any
		if e := decoder.Decode(&extra); e != io.EOF {
			if e == nil {
				err = errors.New("extra JSON value")
			} else {
				err = e
			}
		}
	}
	if err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			fsWriteError(w, 413, "request_too_large", "request body is too large")
		} else {
			fsWriteError(w, 400, "invalid_request", "invalid request body")
		}
		return
	}
	versionBytes, versionErr := hex.DecodeString(body.ExpectedVersion)
	if body.Path == "" || body.Content == nil || versionErr != nil || len(versionBytes) != sha256.Size {
		fsWriteError(w, 400, "invalid_request", "path, content and a SHA-256 expectedVersion are required")
		return
	}
	if strings.HasPrefix(body.Path, "embedded:") {
		fsWriteError(w, 403, "read_only", "embedded files are read-only")
		return
	}
	if !filepath.IsAbs(body.Path) {
		fsWriteError(w, http.StatusBadRequest, "invalid_request", "path must be absolute")
		return
	}
	path, err := resolveSafePath(body.Path)
	if err != nil {
		fsWriteError(w, 403, "unsafe_path", err.Error())
		return
	}
	if !wc.fsLocalAccess(w, r, body.Channel, body.ChatID) {
		return
	}
	data := []byte(*body.Content)
	if len(data) > maxFileReadSize {
		fsWriteError(w, 413, "file_too_large", "content exceeds the 2 MiB editing limit")
		return
	}
	if !utf8.Valid(data) || isBinaryData(data) {
		fsWriteError(w, 415, "not_text", "only UTF-8 text without NUL bytes can be saved")
		return
	}
	fsSaveMu.Lock()
	defer fsSaveMu.Unlock()
	// Follow existing read semantics for symlinks, replacing their target rather
	// than replacing the symlink itself.
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		fsSaveIOError(w, err)
		return
	}
	original, info, err := fsReadEditable(path)
	if err != nil {
		fsSaveIOError(w, err)
		return
	}
	if fsContentVersion(original) != strings.ToLower(body.ExpectedVersion) {
		fsWriteError(w, 409, "version_conflict", "file changed since it was opened; reload before saving")
		return
	}
	// Atomic replacement must not bypass a read-only file's permission bits.
	if info.Mode().Perm()&0222 == 0 {
		fsWriteError(w, 403, "permission_denied", "file is read-only")
		return
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".xbot-save-*")
	if err != nil {
		fsSaveIOError(w, err)
		return
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(data); err == nil {
		err = tmp.Chmod(info.Mode())
	}
	if err == nil {
		err = tmp.Sync()
	}
	closeErr := tmp.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		fsSaveIOError(w, err)
		return
	}
	// Re-read the *entire* target immediately before rename, not just size/mtime.
	current, currentInfo, err := fsReadEditable(path)
	if err != nil {
		fsSaveIOError(w, err)
		return
	}
	if !os.SameFile(info, currentInfo) || info.Mode() != currentInfo.Mode() || fsContentVersion(current) != fsContentVersion(original) {
		fsWriteError(w, 409, "version_conflict", "file changed during save; reload before saving")
		return
	}
	// Rename is atomic publication, NOT an atomic compare-and-swap against
	// external writers. Ancestors can also be renamed/replaced after the check;
	// EvalSymlinks is not a pinned directory handle. This endpoint preserves the
	// authenticated whole-host boundary and does not sandbox hostile processes.
	if err = os.Rename(tmp.Name(), path); err != nil {
		fsSaveIOError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"path": body.Path, "version": fsContentVersion(data), "size": len(data)})
}

var errFsNotText = errors.New("only complete UTF-8 text files can be edited")
var errFsTooLarge = errors.New("file exceeds the 2 MiB editing limit")

func fsReadEditable(path string) ([]byte, os.FileInfo, error) {
	initial, err := os.Stat(path)
	if err != nil {
		return nil, nil, err
	}
	if !initial.Mode().IsRegular() {
		return nil, nil, errFsNotText
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, nil, errFsNotText
	}
	if info.Size() > maxFileReadSize {
		return nil, nil, errFsTooLarge
	}
	data, err := io.ReadAll(io.LimitReader(f, maxFileReadSize+1))
	if err != nil {
		return nil, nil, err
	}
	if len(data) > maxFileReadSize {
		return nil, nil, errFsTooLarge
	}
	if !utf8.Valid(data) || isBinaryData(data) {
		return nil, nil, errFsNotText
	}
	return data, info, nil
}

func fsSaveIOError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errFsTooLarge):
		fsWriteError(w, 413, "file_too_large", err.Error())
	case errors.Is(err, errFsNotText):
		fsWriteError(w, 415, "not_text", err.Error())
	case os.IsNotExist(err):
		fsWriteError(w, 409, "version_conflict", "file no longer exists; reload before saving")
	case os.IsPermission(err):
		fsWriteError(w, 403, "permission_denied", "permission denied")
	default:
		fsWriteError(w, 500, "save_failed", err.Error())
	}
}
