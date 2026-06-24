package api

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

// TestDBStudioHandlers_NilSvc verifies every Phase 2 W2 store endpoint
// answers 503 (never 500/404) when the dbstudio service is unconfigured.
// The store handlers short-circuit on a nil Svc before touching claims or
// the request body, so the assertion holds for list / create / :id / mutation
// verbs alike.
func TestDBStudioHandlers_NilSvc(t *testing.T) {
	gin.SetMode(gin.TestMode)
	h := NewDBStudioHandler(nil) // nil Svc → every endpoint 503s

	cases := []struct {
		method, pattern, path string
		handler               gin.HandlerFunc
	}{
		// Saved queries (A5)
		{"GET", "/saved-queries", "/saved-queries", h.SavedQueriesList},
		{"POST", "/saved-queries", "/saved-queries", h.SavedQueriesCreate},
		{"PUT", "/saved-queries/:id", "/saved-queries/1", h.SavedQueriesUpdate},
		{"DELETE", "/saved-queries/:id", "/saved-queries/1", h.SavedQueriesDelete},
		// Query history (A6)
		{"GET", "/query-history", "/query-history", h.QueryHistoryList},
		// Pinned results (A7)
		{"GET", "/pinned-results", "/pinned-results", h.PinnedResultsList},
		{"POST", "/pinned-results", "/pinned-results", h.PinnedResultsCreate},
		{"GET", "/pinned-results/:id", "/pinned-results/1", h.PinnedResultsGet},
		{"DELETE", "/pinned-results/:id", "/pinned-results/1", h.PinnedResultsDelete},
		// View profiles (C2)
		{"GET", "/view-profiles", "/view-profiles", h.ViewProfilesList},
		{"POST", "/view-profiles", "/view-profiles", h.ViewProfilesCreate},
		{"GET", "/view-profiles/:id", "/view-profiles/1", h.ViewProfilesGet},
		{"PUT", "/view-profiles/:id", "/view-profiles/1", h.ViewProfilesUpdate},
		{"DELETE", "/view-profiles/:id", "/view-profiles/1", h.ViewProfilesDelete},
		{"POST", "/view-profiles/:id/set-default", "/view-profiles/1/set-default", h.ViewProfilesSetDefault},
	}
	for _, c := range cases {
		r := gin.New()
		r.Handle(c.method, c.pattern, c.handler)
		var body io.Reader
		if c.method == http.MethodPost || c.method == http.MethodPut {
			body = strings.NewReader("{}")
		}
		rec := httptest.NewRecorder()
		r.ServeHTTP(rec, httptest.NewRequest(c.method, c.path, body))
		if rec.Code != http.StatusServiceUnavailable {
			t.Errorf("%s %s: expected 503, got %d (%s)", c.method, c.path, rec.Code, rec.Body.String())
		}
	}
}

// TestDBStudioHandlers_NilSvcClaimsOrder confirms a nil Svc wins over a
// missing-claims 401 — the feature-disabled contract must dominate so a
// partially configured deployment never leaks a 401 that implies the route
// is otherwise live.
func TestDBStudioHandlers_NilSvcClaimsOrder(t *testing.T) {
	gin.SetMode(gin.TestMode)
	r := gin.New()
	r.GET("/saved-queries", NewDBStudioHandler(nil).SavedQueriesList)
	rec := httptest.NewRecorder()
	r.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/saved-queries", nil))
	if rec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 (svc-nil beats claims-missing), got %d", rec.Code)
	}
}
