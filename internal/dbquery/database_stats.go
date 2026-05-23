package dbquery

import (
	"context"
	"fmt"
)

// DatabaseStats is the per-database health snapshot the DB Studio
// status bar consumes. Engine-specific fields are best-effort; PG/
// MySQL expose them via separate catalog views, and Dameng has its
// own V$ tables. Missing values come back as 0 / "".
type DatabaseStats struct {
	// SizeBytes is the on-disk size of the connected database. For
	// PG: pg_database_size(current_database()). MySQL: sum of
	// information_schema.TABLES.DATA_LENGTH + INDEX_LENGTH.
	SizeBytes int64 `json:"size_bytes"`
	// TableCount counts user tables + views + matviews; PG omits
	// pg_catalog / information_schema, MySQL omits the system schemas.
	TableCount int `json:"table_count"`
	// Connections is the current backend count visible to the
	// connecting role. PG: pg_stat_activity rows; MySQL: SHOW
	// STATUS LIKE 'Threads_connected'.
	Connections int `json:"connections"`
	// Version is the engine version string (e.g. "PostgreSQL 15.4 on x86_64-…").
	Version string `json:"version"`
	// Uptime is the server uptime in seconds, when the engine exposes
	// it. PG: now() - pg_postmaster_start_time(). MySQL: GLOBAL
	// STATUS 'Uptime'. Dameng: V$INSTANCE.STARTUP_TIME.
	UptimeSeconds int64 `json:"uptime_seconds"`
}

// DatabaseStatsFor returns a one-shot health snapshot for the connected
// (node, database). Each engine implements its own query plan because
// the catalog shapes differ; the returned struct is engine-neutral so
// the UI doesn't have to branch.
func (s *Service) DatabaseStatsFor(ctx context.Context, nodeID, userID uint64,
	database string) (*DatabaseStats, error) {
	pl, err := s.getOrOpen(ctx, nodeID, userID, database)
	if err != nil {
		return nil, err
	}
	switch pl.family() {
	case FamilyPostgres:
		return statsPostgres(ctx, pl)
	case FamilyMySQL:
		return statsMySQL(ctx, pl)
	case FamilyOracle:
		return statsDameng(ctx, pl)
	}
	return nil, fmt.Errorf("dbquery: stats not implemented for protocol %q", pl.protocol)
}

func statsPostgres(ctx context.Context, pl *pool) (*DatabaseStats, error) {
	st := &DatabaseStats{}
	// One round-trip via four SELECTs would be cleaner with a CTE, but
	// some Chinese PG forks treat pg_database_size as a system function
	// that needs explicit privileges in unprivileged roles. Issuing
	// separately lets each call fail soft (we report 0 instead of
	// failing the whole stats panel).
	_ = pl.db.QueryRowContext(ctx, "SELECT pg_database_size(current_database())").Scan(&st.SizeBytes)
	_ = pl.db.QueryRowContext(ctx, `
		SELECT count(*) FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE c.relkind IN ('r','p','v','m')
		  AND n.nspname NOT IN ('pg_catalog','information_schema')`).Scan(&st.TableCount)
	_ = pl.db.QueryRowContext(ctx,
		"SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()").Scan(&st.Connections)
	_ = pl.db.QueryRowContext(ctx, "SELECT version()").Scan(&st.Version)
	_ = pl.db.QueryRowContext(ctx,
		"SELECT EXTRACT(EPOCH FROM (now() - pg_postmaster_start_time()))::bigint").Scan(&st.UptimeSeconds)
	return st, nil
}

func statsMySQL(ctx context.Context, pl *pool) (*DatabaseStats, error) {
	st := &DatabaseStats{}
	_ = pl.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0)
		FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = DATABASE()`).Scan(&st.SizeBytes)
	_ = pl.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM information_schema.TABLES
		WHERE TABLE_SCHEMA = DATABASE()`).Scan(&st.TableCount)
	// SHOW STATUS LIKE 'Threads_connected' returns two columns; we
	// can't ROW_VALUE on that — query Threads_connected via the
	// performance_schema GLOBAL_STATUS table (MySQL 5.7+ / 8.x / TiDB).
	var name, value string
	_ = pl.db.QueryRowContext(ctx,
		"SHOW STATUS LIKE 'Threads_connected'").Scan(&name, &value)
	if value != "" {
		fmt.Sscanf(value, "%d", &st.Connections)
	}
	_ = pl.db.QueryRowContext(ctx, "SELECT VERSION()").Scan(&st.Version)
	name = ""
	value = ""
	_ = pl.db.QueryRowContext(ctx, "SHOW STATUS LIKE 'Uptime'").Scan(&name, &value)
	if value != "" {
		fmt.Sscanf(value, "%d", &st.UptimeSeconds)
	}
	return st, nil
}

func statsDameng(ctx context.Context, pl *pool) (*DatabaseStats, error) {
	st := &DatabaseStats{}
	// DM exposes tablespace summaries; we sum BLOCKS across user
	// tablespaces. Each block is 8 KiB by default.
	_ = pl.db.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(BYTES), 0) FROM SYS.DBA_DATA_FILES`).Scan(&st.SizeBytes)
	_ = pl.db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM SYS.ALL_OBJECTS
		WHERE OBJECT_TYPE IN ('TABLE','VIEW','MATERIALIZED VIEW')
		  AND OWNER NOT IN ('SYS','SYSDBA','SYSAUDITOR','SYSSSO','CTISYS')`).Scan(&st.TableCount)
	_ = pl.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM V$SESSIONS WHERE STATE = 'ACTIVE'").Scan(&st.Connections)
	_ = pl.db.QueryRowContext(ctx, "SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1").Scan(&st.Version)
	_ = pl.db.QueryRowContext(ctx,
		"SELECT EXTRACT(SECOND FROM (SYSDATE - STARTUP_TIME))::INT FROM V$INSTANCE").Scan(&st.UptimeSeconds)
	return st, nil
}
