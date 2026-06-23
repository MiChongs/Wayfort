package dbstudio

import (
	"context"
	"errors"

	"gorm.io/gorm"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/dbquery"
)

// ErrUnavailable means the service was constructed without a backing
// dependency required for this call (e.g. db == nil). Stores MUST return
// it before any panic, so a deployment that didn't wire a *gorm.DB degrades
// gracefully instead of crashing.
var ErrUnavailable = errors.New("dbstudio: feature unavailable in this deployment")

// Service is the top-level entry point for cross-subproject Db Studio
// business state. Each handler reaches one of the per-feature stores via
// the named accessor. Every store is nil-safe: calls against an unwired
// service return ErrUnavailable rather than touching a nil *gorm.DB.
type Service struct {
	db      *gorm.DB
	dbq     *dbquery.Service
	auditor *audit.Writer

	savedQueries  *SavedQueriesStore
	pinnedResults *PinnedResultsStore
	history       *QueryHistoryStore
	viewProfiles  *ViewProfilesStore
	erModels      *ERModelsStore
	applier       *ObjectApplier
}

// NewService wires all per-feature stores against the shared deps. Any
// dep may be nil; stores degrade to ErrUnavailable in that case.
func NewService(db *gorm.DB, dbq *dbquery.Service, auditor *audit.Writer) *Service {
	s := &Service{db: db, dbq: dbq, auditor: auditor}
	s.savedQueries = &SavedQueriesStore{db: db}
	s.pinnedResults = &PinnedResultsStore{db: db}
	s.history = &QueryHistoryStore{db: db}
	s.viewProfiles = &ViewProfilesStore{db: db}
	s.erModels = &ERModelsStore{db: db}
	s.applier = &ObjectApplier{dbq: dbq, auditor: auditor}
	return s
}

// SavedQueries returns the saved-query folder store.
func (s *Service) SavedQueries() *SavedQueriesStore { return s.savedQueries }

// PinnedResults returns the pinned-result store.
func (s *Service) PinnedResults() *PinnedResultsStore { return s.pinnedResults }

// QueryHistory returns the query-execution history store.
func (s *Service) QueryHistory() *QueryHistoryStore { return s.history }

// ViewProfiles returns the per-table view-profile store.
func (s *Service) ViewProfiles() *ViewProfilesStore { return s.viewProfiles }

// ERModels returns the ER-diagram model store.
func (s *Service) ERModels() *ERModelsStore { return s.erModels }

// ObjectApplier returns the DDL diff/apply orchestrator.
func (s *Service) ObjectApplier() *ObjectApplier { return s.applier }

// ensureDB returns ErrUnavailable when no GORM db is wired.
func (s *Service) ensureDB() error {
	if s == nil || s.db == nil {
		return ErrUnavailable
	}
	return nil
}

// Context returns a derived context with the audit writer attached.
// Phase 1 stub — real wiring lands in sub-project plans.
func (s *Service) Context(ctx context.Context) context.Context { return ctx }
