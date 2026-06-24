package profiler

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestMySQLBasicStats(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max", "avg", "std"}).
			AddRow(1000, 12, 800, "alpha", "zulu", 42.5, 8.1))
	s, err := NewMySQL(db).BasicStats(context.Background(), "public", "users", "name")
	if err != nil {
		t.Fatal(err)
	}
	if s.Count != 1000 || s.Distinct != 800 || s.NullCount != 12 {
		t.Fatalf("stats: %+v", s)
	}
	if s.Min != "alpha" || s.Max != "zulu" {
		t.Fatalf("min/max: %+v", s)
	}
	if s.Avg != 42.5 || s.StdDev != 8.1 {
		t.Fatalf("avg/std: %+v", s)
	}
}

func TestMySQLBasicStatsRetryOnNonNumeric(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	// First (7-col) query "fails" by returning a row whose AVG/STD scan errors:
	// simulate by returning only 5 columns so Scan errors mid-row.
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max"}).
			AddRow(500, 5, 400, "a", "z"))
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max"}).
			AddRow(500, 5, 400, "a", "z"))
	s, err := NewMySQL(db).BasicStats(context.Background(), "public", "users", "name")
	if err != nil {
		t.Fatal(err)
	}
	if s.Count != 500 || s.Distinct != 400 || s.NullCount != 5 {
		t.Fatalf("retry stats: %+v", s)
	}
}

func TestMySQLTopN(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT .* GROUP BY .* ORDER BY").
		WillReturnRows(sqlmock.NewRows([]string{"v", "c"}).
			AddRow("alice", 50).AddRow("bob", 40))
	out, err := NewMySQL(db).TopN(context.Background(), "public", "users", "name", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Count != 50 || out[1].Value != "bob" {
		t.Fatalf("topn: %+v", out)
	}
}

func TestMySQLDistribution(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("NTILE").WillReturnRows(sqlmock.NewRows([]string{"lo", "hi", "cnt"}).
		AddRow(0, 10, 50).AddRow(10, 20, 30))
	h, err := NewMySQL(db).Distribution(context.Background(), "public", "users", "age", 20)
	if err != nil {
		t.Fatal(err)
	}
	if len(h.Buckets) != 2 {
		t.Fatalf("buckets: %d", len(h.Buckets))
	}
}

func TestMySQLPatterns(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	for range commonPatterns {
		mock.ExpectQuery("REGEXP").WillReturnRows(sqlmock.NewRows([]string{"cnt"}).AddRow(5))
	}
	out, err := NewMySQL(db).Patterns(context.Background(), "public", "users", "email")
	if err != nil {
		t.Fatal(err)
	}
	if len(out) == 0 {
		t.Fatal("expected pattern matches")
	}
}

func TestMySQLNoDB(t *testing.T) {
	if _, err := NewMySQL(nil).BasicStats(context.Background(), "s", "t", "c"); err != errNoDB {
		t.Fatalf("want errNoDB, got %v", err)
	}
}
