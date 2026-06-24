package completion

import (
	"context"
	"testing"

	"github.com/DATA-DOG/go-sqlmock"
)

func TestDamengSnapshot(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()

	mock.ExpectQuery(`SELECT USERNAME FROM SYS\.ALL_USERS`).
		WillReturnRows(sqlmock.NewRows([]string{"USERNAME"}).AddRow("APP_USER"))
	mock.ExpectQuery(`SELECT OWNER, OBJECT_NAME, OBJECT_TYPE FROM SYS\.ALL_OBJECTS`).
		WillReturnRows(sqlmock.NewRows([]string{"OWNER", "OBJECT_NAME", "OBJECT_TYPE"}).
			AddRow("APP_USER", "ORDERS", "TABLE"))
	mock.ExpectQuery(`SELECT OWNER, TABLE_NAME, COLUMN_NAME, DATA_TYPE, NULLABLE FROM SYS\.ALL_TAB_COLUMNS`).
		WillReturnRows(sqlmock.NewRows([]string{"OWNER", "TABLE_NAME", "COLUMN_NAME", "DATA_TYPE", "NULLABLE"}).
			AddRow("APP_USER", "ORDERS", "ID", "NUMBER", "N"))
	mock.ExpectQuery(`SELECT OWNER, OBJECT_NAME FROM SYS\.ALL_OBJECTS WHERE OBJECT_TYPE='FUNCTION'`).
		WillReturnRows(sqlmock.NewRows([]string{"OWNER", "OBJECT_NAME"}).
			AddRow("APP_USER", "MY_FUNC"))

	snap, err := NewDameng(db).Snapshot(context.Background(), "DMDB")
	if err != nil {
		t.Fatal(err)
	}
	if len(snap.Tables) != 1 || snap.Tables[0].Name != "ORDERS" {
		t.Fatalf("tables: %+v", snap.Tables)
	}
}
