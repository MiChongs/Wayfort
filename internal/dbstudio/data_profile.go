package dbstudio

import (
	"context"

	"github.com/michongs/wayfort/internal/dbquery"
)

// DataProfileStore delegates to a dbquery adapter's profiler.Profiler to
// produce column-level statistics for a table. Unlike the GORM-backed
// stores it has no persistence layer of its own — results are computed on
// demand. Phase 1 stub — concrete delegation lands in sub-project C.
type DataProfileStore struct{ dbq *dbquery.Service }

// DataProfile is the aggregated profiling result for one table.
type DataProfile struct {
	Schema  string
	Table   string
	Columns []ColumnProfile
}

// ColumnProfile bundles the per-column statistics surfaced to the UI.
type ColumnProfile struct {
	Name      string
	Count     int64
	NullCount int64
	Distinct  int64
}

// Profile computes the data profile for (schema, table) on nodeID.
func (s *DataProfileStore) Profile(ctx context.Context, nodeID int64, schema, table string) (DataProfile, error) {
	if s == nil || s.dbq == nil {
		return DataProfile{}, ErrUnavailable
	}
	panic("dbstudio.DataProfileStore.Profile: phase-1 stub; implement in sub-project C plan")
}
