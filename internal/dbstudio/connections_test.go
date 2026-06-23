package dbstudio

import "testing"

func TestParseConnectionURI_MySQL(t *testing.T) {
	uri, err := ParseConnectionURI("mysql://user:pass@db.example.com:3306/myschema?ssl=true&charset=utf8mb4")
	if err != nil {
		t.Fatal(err)
	}
	if uri.Scheme != "mysql" {
		t.Fatalf("scheme: %s", uri.Scheme)
	}
	if uri.User != "user" || uri.Password != "pass" {
		t.Fatalf("auth: %+v", uri)
	}
	if uri.Host != "db.example.com" || uri.Port != 3306 {
		t.Fatalf("host: %+v", uri)
	}
	if uri.Database != "myschema" {
		t.Fatalf("db: %s", uri.Database)
	}
	if uri.Params["ssl"] != "true" || uri.Params["charset"] != "utf8mb4" {
		t.Fatalf("params: %+v", uri.Params)
	}
}

func TestParseConnectionURI_Redis(t *testing.T) {
	uri, err := ParseConnectionURI("redis://:secret@cache:6379/2")
	if err != nil {
		t.Fatal(err)
	}
	if uri.Scheme != "redis" || uri.Port != 6379 || uri.Database != "2" {
		t.Fatalf("redis: %+v", uri)
	}
}

func TestParseConnectionURI_Invalid(t *testing.T) {
	if _, err := ParseConnectionURI("not a uri"); err == nil {
		t.Fatal("expected error on garbage uri")
	}
}
