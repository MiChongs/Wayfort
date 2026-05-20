package dbquery

import (
	"context"
	"fmt"
)

// BuildRowsSQL validates table/ordering metadata and returns a dialect-quoted
// SELECT used by the browse-table endpoint.
func (s *Service) BuildRowsSQL(ctx context.Context, nodeID, userID uint64,
	database, schema, table, orderBy, orderDir string, limit, offset int) (string, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return "", err
	}
	cols, err := loadColumnsForPool(ctx, pl, schema, table)
	if err != nil {
		return "", err
	}
	if len(cols) == 0 {
		return "", fmt.Errorf("table %s.%s has no columns or doesn't exist", schema, table)
	}
	knownCols := map[string]bool{}
	for _, col := range cols {
		knownCols[col.Name] = true
	}
	if orderBy != "" && !knownCols[orderBy] {
		return "", fmt.Errorf("order_by column %q not in table", orderBy)
	}
	adapter, err := s.adapterForPool(pl)
	if err != nil {
		return "", err
	}
	return adapter.Dialect().BuildRowsSQL(schema, table, orderBy, orderDir, limit, offset)
}

func (s *Service) adapterForPool(pl *pool) (Adapter, error) {
	if pl == nil {
		return nil, fmt.Errorf("dbquery: pool not initialized")
	}
	if pl.adapter != nil {
		return pl.adapter, nil
	}
	registry := s.registry
	if registry == nil {
		registry = DefaultRegistry()
	}
	adapter, ok := registry.Get(pl.protocol)
	if !ok {
		return nil, fmt.Errorf("dbquery: protocol %q not supported", pl.protocol)
	}
	return adapter, nil
}
