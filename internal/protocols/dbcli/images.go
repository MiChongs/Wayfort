// Package dbcli launches an ephemeral Docker container holding the appropriate
// database CLI client (mysql, psql, redis-cli, mongosh) and pipes it to the
// browser session pump. The container has a tight TTL, no persistent volume,
// and the credential is passed via environment variable to avoid shell history.
package dbcli

import (
	"fmt"

	"github.com/michongs/wayfort/internal/model"
)

// LaunchSpec captures the per-protocol launch parameters.
type LaunchSpec struct {
	Image   string
	Command []string
	Env     []string
}

// Build produces the full container launch spec given the node, the resolved
// (user, password) tuple, and the configured image overrides.
func Build(node *model.Node, user, password string, images map[string]string) (LaunchSpec, error) {
	if node == nil {
		return LaunchSpec{}, fmt.Errorf("nil node")
	}
	host := node.Host
	port := node.Port
	db := optionsValue(node, "database")
	switch node.EffectiveProtocol() {
	case model.NodeProtoMySQL:
		image := pick(images, "mysql", "mysql:8.0")
		args := []string{"mysql", "-h", host, "-P", itoa(port, 3306), "-u", user}
		if password != "" {
			args = append(args, "-p"+password)
		}
		if db != "" {
			args = append(args, db)
		}
		return LaunchSpec{Image: image, Command: args}, nil

	case model.NodeProtoPostgres:
		image := pick(images, "postgres", "postgres:16-alpine")
		args := []string{"psql", "-h", host, "-p", itoa(port, 5432), "-U", user}
		if db != "" {
			args = append(args, "-d", db)
		}
		env := []string{}
		if password != "" {
			env = append(env, "PGPASSWORD="+password)
		}
		return LaunchSpec{Image: image, Command: args, Env: env}, nil

	case model.NodeProtoRedis:
		image := pick(images, "redis", "redis:7-alpine")
		args := []string{"redis-cli", "-h", host, "-p", itoa(port, 6379)}
		if password != "" {
			args = append(args, "-a", password)
		}
		return LaunchSpec{Image: image, Command: args}, nil

	case model.NodeProtoMongo:
		image := pick(images, "mongo", "mongo:7")
		uri := fmt.Sprintf("mongodb://%s:%d/%s", host, defaultPort(port, 27017), db)
		if user != "" {
			uri = fmt.Sprintf("mongodb://%s:%s@%s:%d/%s", user, password, host, defaultPort(port, 27017), db)
		}
		args := []string{"mongosh", "--quiet", uri}
		return LaunchSpec{Image: image, Command: args}, nil
	}
	return LaunchSpec{}, fmt.Errorf("unsupported db cli protocol %q", node.Protocol)
}

func optionsValue(n *model.Node, key string) string {
	// Lazy non-JSON parser: ProtoOptions is typically a small JSON object; we
	// do a single Unmarshal in the bridge package. For DB CLI we only need
	// "database", so we keep it inline to avoid a circular import.
	if n.ProtoOptions == "" {
		return ""
	}
	return findJSONString(n.ProtoOptions, key)
}

func findJSONString(s, key string) string {
	// Cheap scan, good enough for short JSON blobs like {"database":"app"}.
	needle := "\"" + key + "\""
	i := indexOf(s, needle)
	if i < 0 {
		return ""
	}
	j := i + len(needle)
	for j < len(s) && (s[j] == ' ' || s[j] == ':' || s[j] == '\t') {
		j++
	}
	if j >= len(s) || s[j] != '"' {
		return ""
	}
	j++
	start := j
	for j < len(s) && s[j] != '"' {
		if s[j] == '\\' && j+1 < len(s) {
			j += 2
			continue
		}
		j++
	}
	return s[start:j]
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func defaultPort(v, def int) int {
	if v <= 0 {
		return def
	}
	return v
}

func itoa(v, def int) string { return fmt.Sprintf("%d", defaultPort(v, def)) }

func pick(m map[string]string, key, fallback string) string {
	if v, ok := m[key]; ok && v != "" {
		return v
	}
	return fallback
}
