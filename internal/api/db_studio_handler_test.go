package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/michongs/wayfort/internal/dbstudio"
)

// setupDBStudioTestRouter wires the handler under test onto a bare Gin
// engine mirroring the /dbstudio/* mount the real router registers.
func setupDBStudioTestRouter(h *DBStudioHandler) *gin.Engine {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.POST("/dbstudio/connections/parse-uri", h.ParseURI)
	r.GET("/dbstudio/er-models", h.ERModelStub)
	r.POST("/dbstudio/er-models", h.ERModelStub)
	return r
}

// TestDBStudioParseURIHandler_MySQL verifies a well-formed Navicat-style URI
// is parsed into the expected ConnectionURI fields and returned as 200 JSON.
func TestDBStudioParseURIHandler_MySQL(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))
	r := setupDBStudioTestRouter(h)

	body := strings.NewReader(`{"uri":"mysql://u:p@h:3306/d?ssl=true"}`)
	req := httptest.NewRequest(http.MethodPost, "/dbstudio/connections/parse-uri", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var out dbstudio.ConnectionURI
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out.Scheme != "mysql" || out.Port != 3306 || out.Database != "d" || out.Host != "h" {
		t.Fatalf("parsed: %+v", out)
	}
}

// TestDBStudioParseURIHandler_Invalid verifies a garbage URI surfaces as 400
// rather than reaching the (nil) db layer.
func TestDBStudioParseURIHandler_Invalid(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))
	r := setupDBStudioTestRouter(h)

	body := strings.NewReader(`{"uri":"garbage"}`)
	req := httptest.NewRequest(http.MethodPost, "/dbstudio/connections/parse-uri", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestDBStudioParseURIHandler_BadJSON verifies malformed JSON bodies surface
// as 400 before the URI is even read.
func TestDBStudioParseURIHandler_BadJSON(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))
	r := setupDBStudioTestRouter(h)

	body := strings.NewReader(`{not json`)
	req := httptest.NewRequest(http.MethodPost, "/dbstudio/connections/parse-uri", body)
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rec.Code, rec.Body.String())
	}
}

// TestDBStudioERStub_NotImplemented verifies every ER-model route returns a
// stable 501 so the UI can branch on "not yet built".
func TestDBStudioERStub_NotImplemented(t *testing.T) {
	h := NewDBStudioHandler(dbstudio.NewService(nil, nil, nil))
	r := setupDBStudioTestRouter(h)

	for _, m := range []string{http.MethodGet, http.MethodPost} {
		req := httptest.NewRequest(m, "/dbstudio/er-models", nil)
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, req)
		if rec.Code != http.StatusNotImplemented {
			t.Fatalf("%s /er-models: expected 501, got %d", m, rec.Code)
		}
	}
}
