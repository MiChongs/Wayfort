package dbquery

import (
	"context"
	"fmt"
)

// TriggerInfo describes one trigger attached to a table. Returned by
// LoadTriggers; rendered as a section in StructureTab.
type TriggerInfo struct {
	Name     string `json:"name"`
	// Timing is BEFORE / AFTER / INSTEAD OF.
	Timing string `json:"timing"`
	// Event is INSERT / UPDATE / DELETE / TRUNCATE (PG) or a combo string.
	Event string `json:"event"`
	// Statement is the trigger function body for PG (pg_get_triggerdef)
	// or the ACTION_STATEMENT for MySQL. Truncated to keep the panel
	// readable.
	Statement string `json:"statement"`
	// Enabled is true when the trigger fires (PG: tgenabled = 'O' / 'A').
	Enabled bool `json:"enabled"`
}

// LoadTriggers returns every trigger on the given table. Powers the
// Structure tab's Triggers section. Engines that don't expose
// programmable triggers (most OLAP — StarRocks / Doris) return an
// empty slice + nil error so the UI just shows the "无" state.
func (s *Service) LoadTriggers(ctx context.Context, nodeID, userID uint64,
	database, schema, table string) ([]TriggerInfo, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.family() {
	case FamilyPostgres:
		return loadTriggersPostgres(ctx, pl, schema, table)
	case FamilyMySQL:
		return loadTriggersMySQL(ctx, pl, schema, table)
	case FamilyOracle:
		return loadTriggersDameng(ctx, pl, schema, table)
	}
	return []TriggerInfo{}, nil
}

func loadTriggersPostgres(ctx context.Context, pl *pool, schema, table string) ([]TriggerInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  t.tgname,
		  CASE
		    WHEN (t.tgtype & 2) <> 0 THEN 'BEFORE'
		    WHEN (t.tgtype & 64) <> 0 THEN 'INSTEAD OF'
		    ELSE 'AFTER'
		  END AS timing,
		  CASE
		    WHEN (t.tgtype & 4) <> 0 THEN 'INSERT'
		    WHEN (t.tgtype & 8) <> 0 THEN 'DELETE'
		    WHEN (t.tgtype & 16) <> 0 THEN 'UPDATE'
		    WHEN (t.tgtype & 32) <> 0 THEN 'TRUNCATE'
		    ELSE 'OTHER'
		  END AS event,
		  pg_get_triggerdef(t.oid, true),
		  CASE t.tgenabled WHEN 'D' THEN false ELSE true END
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2
		  AND NOT t.tgisinternal
		ORDER BY t.tgname`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("postgres triggers: %w", err)
	}
	defer rows.Close()
	out := []TriggerInfo{}
	for rows.Next() {
		var t TriggerInfo
		if err := rows.Scan(&t.Name, &t.Timing, &t.Event, &t.Statement, &t.Enabled); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadTriggersMySQL(ctx context.Context, pl *pool, schema, table string) ([]TriggerInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  TRIGGER_NAME,
		  ACTION_TIMING,
		  EVENT_MANIPULATION,
		  ACTION_STATEMENT,
		  1
		FROM information_schema.TRIGGERS
		WHERE EVENT_OBJECT_SCHEMA = ? AND EVENT_OBJECT_TABLE = ?
		ORDER BY TRIGGER_NAME`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("mysql triggers: %w", err)
	}
	defer rows.Close()
	out := []TriggerInfo{}
	for rows.Next() {
		var t TriggerInfo
		var enabled int
		if err := rows.Scan(&t.Name, &t.Timing, &t.Event, &t.Statement, &enabled); err != nil {
			return nil, err
		}
		t.Enabled = enabled == 1
		out = append(out, t)
	}
	return out, rows.Err()
}

func loadTriggersDameng(ctx context.Context, pl *pool, schema, table string) ([]TriggerInfo, error) {
	rows, err := pl.db.QueryContext(ctx, `
		SELECT
		  TRIGGER_NAME,
		  TRIGGER_TYPE,
		  TRIGGERING_EVENT,
		  NVL(TRIGGER_BODY, ''),
		  CASE STATUS WHEN 'ENABLED' THEN 1 ELSE 0 END
		FROM SYS.ALL_TRIGGERS
		WHERE TABLE_OWNER = :1 AND TABLE_NAME = :2
		ORDER BY TRIGGER_NAME`, schema, table)
	if err != nil {
		return nil, fmt.Errorf("dameng triggers: %w", err)
	}
	defer rows.Close()
	out := []TriggerInfo{}
	for rows.Next() {
		var t TriggerInfo
		var enabled int
		if err := rows.Scan(&t.Name, &t.Timing, &t.Event, &t.Statement, &enabled); err != nil {
			return nil, err
		}
		t.Enabled = enabled == 1
		out = append(out, t)
	}
	return out, rows.Err()
}
