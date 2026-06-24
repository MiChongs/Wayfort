package profiler

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestDamengBasicStats(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max", "avg", "std"}).
			AddRow(1000, 12, 800, "alpha", "zulu", 42.5, 8.1))
	s, err := NewDameng(db).BasicStats(context.Background(), "public", "users", "name")
	if err != nil {
		t.Fatal(err)
	}
	if s.Count != 1000 || s.Distinct != 800 || s.NullCount != 12 {
		t.Fatalf("stats: %+v", s)
	}
	if s.Avg != 42.5 || s.StdDev != 8.1 {
		t.Fatalf("avg/std: %+v", s)
	}
}

func TestDamengBasicStatsRetryOnNonNumeric(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max"}).
			AddRow(500, 5, 400, "a", "z"))
	mock.ExpectQuery("SELECT").
		WillReturnRows(sqlmock.NewRows([]string{"count", "null", "distinct", "min", "max"}).
			AddRow(500, 5, 400, "a", "z"))
	s, err := NewDameng(db).BasicStats(context.Background(), "public", "users", "name")
	if err != nil {
		t.Fatal(err)
	}
	if s.Count != 500 || s.Distinct != 400 || s.NullCount != 5 {
		t.Fatalf("retry stats: %+v", s)
	}
}

func TestDamengTopN(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatalf("sqlmock: %v", err)
	}
	defer db.Close()
	mock.ExpectQuery("SELECT .* GROUP BY .* ORDER BY").
		WillReturnRows(sqlmock.NewRows([]string{"v", "c"}).
			AddRow("alice", 50).AddRow("bob", 40))
	out, err := NewDameng(db).TopN(context.Background(), "public", "users", "name", 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(out) != 2 || out[0].Count != 50 || out[1].Value != "bob" {
		t.Fatalf("topn: %+v", out)
	}
}

func TestDamengNoDB(t *testing.T) {
	if _, err := NewDameng(nil).BasicStats(context.Background(), "s", "t", "c"); err != errNoDB {
		t.Fatalf("want errNoDB, got %v", err)
	}
}
