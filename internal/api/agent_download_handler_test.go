package api

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"go.uber.org/zap"
)

func newDownloadHandler(dist string) *AgentDownloadHandler {
	return &AgentDownloadHandler{
		DistDir:    dist,
		PublicHost: "bastion.example",
		AgentAddr:  ":8443",
		Logger:     zap.NewNop(),
	}
}

func dlGET(h *AgentDownloadHandler, target string) *httptest.ResponseRecorder {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/dl/gateway-agent", h.Binary)
	r.GET("/dl/gateway-agent.sh", h.Script)
	req := httptest.NewRequest(http.MethodGet, target, nil)
	req.Host = "bastion.example"
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	return w
}

func TestAgentBinary_NotConfigured(t *testing.T) {
	w := dlGET(newDownloadHandler(""), "/dl/gateway-agent")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when dist dir empty, got %d", w.Code)
	}
}

func TestAgentBinary_UnsupportedArch(t *testing.T) {
	w := dlGET(newDownloadHandler(t.TempDir()), "/dl/gateway-agent?os=plan9&arch=sparc")
	if w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for unsupported os/arch, got %d", w.Code)
	}
}

func TestAgentBinary_NotStaged(t *testing.T) {
	w := dlGET(newDownloadHandler(t.TempDir()), "/dl/gateway-agent?os=linux&arch=amd64")
	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("want 503 when binary missing, got %d", w.Code)
	}
	if !strings.Contains(w.Body.String(), "build-agent.sh") {
		t.Fatalf("503 body should tell the operator how to build it: %q", w.Body.String())
	}
}

func TestAgentBinary_ServesStaged(t *testing.T) {
	dir := t.TempDir()
	want := []byte("\x7fELF-fake-binary")
	if err := os.WriteFile(filepath.Join(dir, "gateway-agent-linux-amd64"), want, 0o755); err != nil {
		t.Fatal(err)
	}
	w := dlGET(newDownloadHandler(dir), "/dl/gateway-agent") // defaults linux/amd64
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (%s)", w.Code, w.Body.String())
	}
	if w.Body.String() != string(want) {
		t.Fatalf("served body does not match staged binary")
	}
	if cd := w.Header().Get("Content-Disposition"); !strings.Contains(cd, "gateway-agent") {
		t.Fatalf("want attachment disposition, got %q", cd)
	}
}

func TestAgentScript_BakesURLs(t *testing.T) {
	w := dlGET(newDownloadHandler(t.TempDir()), "/dl/gateway-agent.sh")
	if w.Code != http.StatusOK {
		t.Fatalf("want 200, got %d", w.Code)
	}
	body := w.Body.String()
	for _, want := range []string{
		"wss://bastion.example:8443", // baked --server URL (from PublicHost)
		"/dl/gateway-agent?os=linux", // binary download URL
		"enroll --server",            // runs enroll, passing "$@" through
	} {
		if !strings.Contains(body, want) {
			t.Fatalf("install script missing %q:\n%s", want, body)
		}
	}
}

func TestPortOf(t *testing.T) {
	cases := map[string]string{
		":8443":        "8443",
		"0.0.0.0:9000": "9000",
		"":             "",
		"noport":       "",
	}
	for in, want := range cases {
		if got := portOf(in); got != want {
			t.Errorf("portOf(%q)=%q want %q", in, got, want)
		}
	}
}
