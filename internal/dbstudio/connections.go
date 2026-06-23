// Package dbstudio orchestrates cross-subproject Db Studio business state.
// Lives one layer above internal/dbquery; consumes its Adapter system.
//
// Phase 1 ships only the package skeleton: the Service entry point, the
// per-feature store types, and a fully working ParseConnectionURI. Every
// GORM-backed CRUD method is nil-safe (returns ErrUnavailable when no
// *gorm.DB is wired) and panics with a sub-project pointer otherwise —
// concrete persistence lands in those plans.
package dbstudio

import (
	"errors"
	"fmt"
	"net/url"
	"strconv"
)

// ConnectionURI is the normalised result of parsing a Navicat-style
// quick-connect URI. The node-creation form pre-fills its fields.
type ConnectionURI struct {
	Scheme   string
	User     string
	Password string
	Host     string
	Port     int
	Database string
	Params   map[string]string
}

// ParseConnectionURI parses a connection URI
// ("mysql://user:pass@host:3306/db?ssl=true") into a normalised struct
// the node-creation form can prefill. Schemes without a host (or a
// syntactically invalid URI) return an error.
func ParseConnectionURI(raw string) (ConnectionURI, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return ConnectionURI{}, fmt.Errorf("parse uri: %w", err)
	}
	if u.Scheme == "" || u.Host == "" {
		return ConnectionURI{}, errors.New("uri missing scheme or host")
	}

	out := ConnectionURI{
		Scheme: u.Scheme,
		Host:   u.Hostname(),
		Params: map[string]string{},
	}
	if u.User != nil {
		out.User = u.User.Username()
		if pw, ok := u.User.Password(); ok {
			out.Password = pw
		}
	}
	if portStr := u.Port(); portStr != "" {
		p, err := strconv.Atoi(portStr)
		if err != nil {
			return ConnectionURI{}, fmt.Errorf("invalid port: %w", err)
		}
		out.Port = p
	}
	if len(u.Path) > 1 {
		out.Database = u.Path[1:] // strip leading '/'
	}
	for k, v := range u.Query() {
		if len(v) > 0 {
			out.Params[k] = v[0]
		}
	}
	return out, nil
}
