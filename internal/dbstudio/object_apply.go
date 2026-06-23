package dbstudio

import (
	"context"
	"errors"

	"github.com/michongs/wayfort/internal/audit"
	"github.com/michongs/wayfort/internal/dbquery"
	"github.com/michongs/wayfort/internal/dbquery/designer"
)

// ObjectApplier orchestrates DDL diff + apply against a live node via the
// dbquery Service, recording each change through the audit writer. Phase 1
// stub — concrete orchestration lands in sub-project B.
type ObjectApplier struct {
	dbq     *dbquery.Service
	auditor *audit.Writer
}

// Diff computes the designer.Change set between two object specs on nodeID.
func (a *ObjectApplier) Diff(ctx context.Context, nodeID int64, oldSpec, newSpec any) ([]designer.Change, error) {
	if a == nil || a.dbq == nil {
		return nil, ErrUnavailable
	}
	return nil, errors.New("dbstudio.ObjectApplier.Diff: phase-1 stub; implement in sub-project B plan")
}

// Apply executes a change set against nodeID, auditing each statement.
func (a *ObjectApplier) Apply(ctx context.Context, nodeID int64, changes []designer.Change) error {
	if a == nil || a.dbq == nil {
		return ErrUnavailable
	}
	return errors.New("dbstudio.ObjectApplier.Apply: phase-1 stub; implement in sub-project B plan")
}
