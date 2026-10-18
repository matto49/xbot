package web

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"xbot/tools"
)

func fsWriteRequest(t *testing.T, path, content, version string) *httptest.ResponseRecorder {
	t.Helper()
	body, err := json.Marshal(map[string]string{"path": path, "content": content, "expectedVersion": version})
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "/api/fs/write", bytes.NewReader(body))
	r = r.WithContext(contextWithSenderID(r.Context(), "fs-writer"))
	w := httptest.NewRecorder()
	(&WebChannel{}).handleFsWrite(w, r)
	return w
}

func TestFsWriteDiskAndConflict(t *testing.T) {
	path := filepath.Join(t.TempDir(), "test.go")
	if err := os.WriteFile(path, []byte("original"), 0600); err != nil {
		t.Fatal(err)
	}
	version := fsContentVersion([]byte("original"))
	w := fsWriteRequest(t, path, "changed", version)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(path)
	if string(data) != "changed" {
		t.Fatalf("disk: %q", data)
	}
	info, _ := os.Stat(path)
	if info.Mode().Perm() != 0600 {
		t.Fatal(info.Mode())
	}
	w = fsWriteRequest(t, path, "overwrite", version)
	if w.Code != 409 || !strings.Contains(w.Body.String(), "version_conflict") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	data, _ = os.ReadFile(path)
	if string(data) != "changed" {
		t.Fatalf("conflict overwrote disk: %q", data)
	}
}

func TestFsWriteRejectsUnsafe(t *testing.T) {
	for _, tc := range []struct {
		name, content, path string
		status              int
	}{
		{"binary", "a\x00b", "", 415}, {"invalid UTF8", string([]byte{255}), "", 415},
		{"large", strings.Repeat("a", maxFileReadSize+1), "", 413},
		{"embedded", "x", "embedded:debug/SKILL.md", 403},
		{"traversal", "x", "/tmp/../file", 403},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := tc.path
			if path == "" {
				path = filepath.Join(t.TempDir(), "file")
				if err := os.WriteFile(path, []byte(tc.content), 0600); err != nil {
					t.Fatal(err)
				}
			}
			w := fsWriteRequest(t, path, "new", fsContentVersion([]byte(tc.content)))
			if w.Code != tc.status {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			if tc.path == "" {
				data, _ := os.ReadFile(path)
				if string(data) != tc.content {
					t.Fatal("changed disk")
				}
			}
		})
	}
}

func TestFsWriteConcurrent(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(path, []byte("old"), 0600)
	version := fsContentVersion([]byte("old"))
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, content := range []string{"first", "second"} {
		wg.Add(1)
		go func(content string) { defer wg.Done(); statuses <- fsWriteRequest(t, path, content, version).Code }(content)
	}
	wg.Wait()
	close(statuses)
	counts := map[int]int{}
	for status := range statuses {
		counts[status]++
	}
	if counts[200] != 1 || counts[409] != 1 {
		t.Fatal(counts)
	}
	data, _ := os.ReadFile(path)
	if string(data) != "first" && string(data) != "second" {
		t.Fatalf("disk %q", data)
	}
}

func TestFsWriteLimitsAndAuth(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		auth       bool
		status     int
	}{
		{"unauthenticated", `{}`, false, 401},
		{"oversized request", strings.Repeat(" ", maxFsWriteRequestSize+1), true, 413},
		{"trailing JSON", `{} {}`, true, 400},
		{"missing version", `{"path":"/tmp/file","content":""}`, true, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/fs/write", strings.NewReader(tc.body))
			if tc.auth {
				r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
			}
			w := httptest.NewRecorder()
			(&WebChannel{}).handleFsWrite(w, r)
			if w.Code != tc.status {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
		})
	}
	path := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(path, []byte("old"), 0600)
	w := fsWriteRequest(t, path, strings.Repeat("a", maxFileReadSize+1), fsContentVersion([]byte("old")))
	if w.Code != 413 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(path)
	if string(data) != "old" {
		t.Fatal("changed disk")
	}
}

func TestFsReadEditableVersion(t *testing.T) {
	for _, tc := range []struct {
		name, content       string
		editable, truncated bool
	}{
		{"empty", "", true, false}, {"text", "hello 世界", true, false},
		{"late binary", strings.Repeat("a", binarySniffSize+1) + "\x00", false, false},
		{"invalid UTF8", string([]byte{255}), false, false},
		{"truncated", strings.Repeat("a", maxFileReadSize+1), false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "file")
			_ = os.WriteFile(path, []byte(tc.content), 0600)
			r := httptest.NewRequest(http.MethodGet, "/api/fs/read?path="+path, nil)
			r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
			w := httptest.NewRecorder()
			(&WebChannel{}).handleFsRead(w, r)
			if w.Code != 200 {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			var envelope struct {
				Data fsReadResponse `json:"data"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
				t.Fatal(err)
			}
			result := envelope.Data
			if (result.Version != "") != tc.editable || result.ReadOnly == tc.editable || result.Truncated != tc.truncated {
				t.Fatalf("%+v", result)
			}
			if tc.editable && result.Version != fsContentVersion([]byte(tc.content)) {
				t.Fatal("incorrect version")
			}
		})
	}
}

func TestFsWriteSymlinkAndReadOnly(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "file")
	link := filepath.Join(dir, "link")
	_ = os.WriteFile(path, []byte("old"), 0600)
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	w := fsWriteRequest(t, link, "new", fsContentVersion([]byte("old")))
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	info, _ := os.Lstat(link)
	if info.Mode()&os.ModeSymlink == 0 {
		t.Fatal("symlink replaced")
	}
	data, _ := os.ReadFile(path)
	if string(data) != "new" {
		t.Fatal("target not saved")
	}
	_ = os.Chmod(path, 0400)
	w = fsWriteRequest(t, path, "other", fsContentVersion([]byte("new")))
	if w.Code != 403 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	data, _ = os.ReadFile(path)
	if string(data) != "new" {
		t.Fatal("read-only file changed")
	}
}

// Resolve to a nonlocal target without a live runner; neither path may touch host disk.
type fsNonlocalSandbox struct{ tools.NoneSandbox }

func (*fsNonlocalSandbox) Name() string { return "runner-offline" }

func TestFsWriteNonlocalNeverWritesHost(t *testing.T) {
	old := tools.GetSandbox()
	tools.SetSandbox(&fsNonlocalSandbox{})
	defer tools.SetSandbox(old)
	path := filepath.Join(t.TempDir(), "host-file")
	_ = os.WriteFile(path, []byte("host"), 0600)
	w := fsWriteRequest(t, path, "remote-edit", fsContentVersion([]byte("host")))
	if w.Code != 501 || !strings.Contains(w.Body.String(), "safe_save_unsupported") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	data, _ := os.ReadFile(path)
	if string(data) != "host" {
		t.Fatal("nonlocal save wrote host")
	}
	r := httptest.NewRequest(http.MethodGet, "/api/fs/read?path="+path, nil)
	r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
	w = httptest.NewRecorder()
	(&WebChannel{}).handleFsRead(w, r)
	if w.Code != 501 || strings.Contains(w.Body.String(), `"content":"host"`) {
		t.Fatalf("host read exposed to nonlocal target: %d %s", w.Code, w.Body.String())
	}
}

func TestFsWriteEmbeddedAndMissing(t *testing.T) {
	r := httptest.NewRequest(http.MethodGet, "/api/fs/read?path=embedded:debug/SKILL.md", nil)
	r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
	w := httptest.NewRecorder()
	(&WebChannel{}).handleFsRead(w, r)
	if w.Code != 200 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	var envelope struct {
		Data fsReadResponse `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &envelope)
	if !envelope.Data.ReadOnly || envelope.Data.Version != "" {
		t.Fatal("embedded content editable")
	}
	path := filepath.Join(t.TempDir(), "deleted")
	w = fsWriteRequest(t, path, "new", fsContentVersion([]byte("old")))
	if w.Code != 409 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("missing file recreated")
	}
}

func TestFsWriteRequiresAbsolutePath(t *testing.T) {
	w := fsWriteRequest(t, "relative-editor-file.txt", "new", fsContentVersion([]byte("old")))
	if w.Code != 400 || !strings.Contains(w.Body.String(), "absolute") {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestFsReadPermissionReadOnly(t *testing.T) {
	path := filepath.Join(t.TempDir(), "file")
	if err := os.WriteFile(path, []byte("text"), 0400); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/fs/read?path="+path, nil)
	r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
	w := httptest.NewRecorder()
	(&WebChannel{}).handleFsRead(w, r)
	var envelope struct {
		Data fsReadResponse `json:"data"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &envelope)
	if w.Code != 200 || !envelope.Data.ReadOnly {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

func TestFsWriteAuthenticatedPOSTIntegration(t *testing.T) {
	db := newTestDB(t)
	wc, _ := newTestWebChannel(t, db)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/auth/register", wc.handleRegister)
	mux.HandleFunc("/api/auth/login", wc.handleLogin)
	mux.HandleFunc("/api/fs/write", wc.authenticatedPOST(wc.handleFsWrite))
	mux.HandleFunc("/api/fs/read", wc.authenticatedPOST(wc.handleFsReadPOST))
	server := httptest.NewServer(mux)
	defer server.Close()
	cookie := registerAndGetCookie(t, server)
	path := filepath.Join(t.TempDir(), "file")
	_ = os.WriteFile(path, []byte("old"), 0600)
	call := func(endpoint string, body any, auth bool) (*http.Response, []byte) {
		t.Helper()
		encoded, _ := json.Marshal(body)
		req, _ := http.NewRequest(http.MethodPost, server.URL+endpoint, bytes.NewReader(encoded))
		if auth {
			req.Header.Set("Cookie", cookie)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		data, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatal(err)
		}
		return resp, data
	}
	resp, data := call("/api/fs/read", map[string]string{"path": path}, true)
	var envelope struct {
		Data fsReadResponse `json:"data"`
	}
	_ = json.Unmarshal(data, &envelope)
	if resp.StatusCode != 200 || envelope.Data.Version == "" {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	payload := map[string]string{"path": path, "content": "saved via authenticated route", "expectedVersion": envelope.Data.Version}
	resp, data = call("/api/fs/write", payload, false)
	if resp.StatusCode != 401 {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	resp, data = call("/api/fs/write", payload, true)
	if resp.StatusCode != 200 {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	// Round-trip the maximum text size through the real authentication middleware,
	// with both ordinary and JSON-escaped content larger than its former 1 MiB cap.
	current := payload["content"]
	for _, content := range []string{
		strings.Repeat("a", maxFileReadSize),
		strings.Repeat("\t", maxFileReadSize),
	} {
		largePayload := map[string]string{"path": path, "content": content, "expectedVersion": fsContentVersion([]byte(current))}
		encoded, _ := json.Marshal(largePayload)
		if len(encoded) <= maxBodySize {
			t.Fatal("test must exceed the former middleware cap")
		}
		resp, data = call("/api/fs/write", largePayload, true)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("%d %s", resp.StatusCode, data)
		}
		disk, err := os.ReadFile(path)
		if err != nil || string(disk) != content {
			t.Fatal("large authenticated save did not reach disk intact", err)
		}
		current = content
	}
	// Replacement text limit is independent from encoded-request size.
	tooLarge := map[string]string{"path": path, "content": strings.Repeat("a", maxFileReadSize+1), "expectedVersion": fsContentVersion([]byte(current))}
	resp, data = call("/api/fs/write", tooLarge, true)
	if resp.StatusCode != http.StatusRequestEntityTooLarge || !bytes.Contains(data, []byte(`"code":"file_too_large"`)) {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	// A syntactically valid JSON string above the request envelope limit must
	// fail at the streaming body cap, before decoding and before disk mutation.
	oversizedRequest := map[string]string{"path": path, "content": strings.Repeat("a", maxFsWriteRequestSize+1), "expectedVersion": fsContentVersion([]byte(current))}
	resp, data = call("/api/fs/write", oversizedRequest, true)
	if resp.StatusCode != http.StatusRequestEntityTooLarge || !bytes.Contains(data, []byte(`"code":"request_too_large"`)) {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
	disk, err := os.ReadFile(path)
	if err != nil || string(disk) != current {
		t.Fatal("rejected request changed disk", err)
	}

	resp, data = call("/api/fs/write", payload, true)
	if resp.StatusCode != 409 || !bytes.Contains(data, []byte(`"code":"version_conflict"`)) {
		t.Fatalf("%d %s", resp.StatusCode, data)
	}
}

func TestFsLocalAccessSandboxBoundary(t *testing.T) {
	original := tools.GetSandbox()
	if original == nil {
		t.Fatal("GetSandbox must initialize a default sandbox")
	}
	defer tools.SetSandbox(original)
	for _, tc := range []struct {
		name   string
		sb     tools.Sandbox
		status int
	}{
		{"local", &tools.NoneSandbox{}, 200},
		{"nil", nil, 501},
		{"offline", &fsNonlocalSandbox{}, 501},
	} {
		t.Run(tc.name, func(t *testing.T) {
			tools.SetSandbox(tc.sb)
			r := httptest.NewRequest(http.MethodPost, "/api/fs/write", nil)
			r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
			w := httptest.NewRecorder()
			ok := (&WebChannel{}).fsLocalAccess(w, r, "", "")
			if w.Code != tc.status || ok != (tc.status == 200) {
				t.Fatalf("ok=%v status=%d", ok, w.Code)
			}
		})
	}
}

func TestFsWriteAbsentAuthContext(t *testing.T) {
	// The handler must reject before resolveAPISession's empty-selection branch
	// can construct a default session with an empty sender identity.
	r := httptest.NewRequest(http.MethodPost, "/api/fs/write", strings.NewReader(`{"path":"/tmp/no-write","content":"x","expectedVersion":"`+fsContentVersion(nil)+`"}`))
	w := httptest.NewRecorder()
	(&WebChannel{}).handleFsWrite(w, r)
	if w.Code != 401 {
		t.Fatalf("%d %s", w.Code, w.Body.String())
	}
}

// A session-aware resolver proves that the POST adapter preserves the supplied
// execution target rather than silently falling back to the user's current one.
type fsRawSessionSandbox struct {
	tools.NoneSandbox
	resolved string
}

func (s *fsRawSessionSandbox) SandboxForSession(key string) tools.Sandbox {
	s.resolved = key
	if key == "web:remote-image" {
		return &fsNonlocalSandbox{}
	}
	return &tools.NoneSandbox{}
}

func TestFsRawNonlocalCannotReadHost(t *testing.T) {
	old := tools.GetSandbox()
	sandbox := &fsRawSessionSandbox{}
	tools.SetSandbox(sandbox)
	defer tools.SetSandbox(old)
	path := filepath.Join(t.TempDir(), "host.png")
	image := []byte("\x89PNG\r\n\x1a\nhost-only-image")
	if err := os.WriteFile(path, image, 0600); err != nil {
		t.Fatal(err)
	}
	for _, postAdapter := range []bool{false, true} {
		name := "direct raw"
		if postAdapter {
			name = "POST read raw adapter"
		}
		t.Run(name, func(t *testing.T) {
			var r *http.Request
			if postAdapter {
				body, _ := json.Marshal(map[string]any{"path": path, "raw": true, "channel": "web", "chat_id": "remote-image"})
				r = httptest.NewRequest(http.MethodPost, "/api/fs/read", bytes.NewReader(body))
			} else {
				r = httptest.NewRequest(http.MethodGet, "/api/fs/raw?path="+url.QueryEscape(path)+"&channel=web&chat_id=remote-image", nil)
			}
			r = r.WithContext(contextWithSenderID(r.Context(), "writer"))
			w := httptest.NewRecorder()
			wc := &WebChannel{}
			if postAdapter {
				wc.handleFsReadPOST(w, r)
			} else {
				wc.handleFsRaw(w, r)
			}
			if w.Code != 501 || bytes.Contains(w.Body.Bytes(), image) {
				t.Fatalf("host image exposed: %d %s", w.Code, w.Body.String())
			}
			if sandbox.resolved != "web:remote-image" {
				t.Fatalf("resolved %q", sandbox.resolved)
			}
		})
	}
}
