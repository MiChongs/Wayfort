package docker

import (
	"encoding/json"
	"errors"
	"regexp"
	"strconv"
	"strings"
)

// rawContainer mirrors the CamelCase fields Docker emits with
// `--format '{{json .}}'`. We decode into this then re-stamp into our
// snake_case Container struct.
type rawContainer struct {
	ID         string `json:"ID"`
	Names      string `json:"Names"`
	Image      string `json:"Image"`
	State      string `json:"State"`
	Status     string `json:"Status"`
	Command    string `json:"Command"`
	Ports      string `json:"Ports"`
	CreatedAt  string `json:"CreatedAt"`
	SizeRootFs string `json:"Size"`
}

type rawImage struct {
	ID         string `json:"ID"`
	Repository string `json:"Repository"`
	Tag        string `json:"Tag"`
	Digest     string `json:"Digest"`
	Size       string `json:"Size"`
	CreatedAt  string `json:"CreatedAt"`
}

// parseContainers decodes one Container per non-empty line of ndjson.
func parseContainers(stdout string) ([]Container, error) {
	out := make([]Container, 0, 16)
	for i, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var r rawContainer
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			return nil, errPos(i, line, err)
		}
		out = append(out, Container{
			ID:         r.ID,
			Names:      r.Names,
			Image:      r.Image,
			State:      r.State,
			Status:     r.Status,
			Command:    r.Command,
			Ports:      r.Ports,
			CreatedAt:  r.CreatedAt,
			SizeRootFs: r.SizeRootFs,
		})
	}
	return out, nil
}

// parseImages decodes one Image per non-empty line.
func parseImages(stdout string) ([]Image, error) {
	out := make([]Image, 0, 16)
	for i, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var r rawImage
		if err := json.Unmarshal([]byte(line), &r); err != nil {
			return nil, errPos(i, line, err)
		}
		out = append(out, Image{
			ID:         r.ID,
			Repository: r.Repository,
			Tag:        r.Tag,
			Digest:     r.Digest,
			Size:       r.Size,
			CreatedAt:  r.CreatedAt,
		})
	}
	return out, nil
}

// parseVersion decodes `docker version --format '{{json .}}'` output. The
// payload has nested Client/Server sections; we surface Server when
// reachable, otherwise Client. Empty stdout (daemon socket unreachable)
// produces Available=false with a hint.
func parseVersion(stdout string) Status {
	type ver struct {
		Server struct {
			Version    string `json:"Version"`
			APIVersion string `json:"ApiVersion"`
			Os         string `json:"Os"`
		} `json:"Server"`
		Client struct {
			Version    string `json:"Version"`
			APIVersion string `json:"ApiVersion"`
			Os         string `json:"Os"`
		} `json:"Client"`
	}
	s := Status{}
	stdout = strings.TrimSpace(stdout)
	if stdout == "" {
		s.Available = false
		s.Reason = "docker command not found or daemon unreachable"
		return s
	}
	var v ver
	if err := json.Unmarshal([]byte(stdout), &v); err != nil {
		s.Available = false
		s.Reason = "could not parse docker version output (is daemon running?)"
		return s
	}
	if v.Server.Version != "" {
		s.Available = true
		s.Version = v.Server.Version
		s.APIVersion = v.Server.APIVersion
		s.OS = v.Server.Os
		return s
	}
	if v.Client.Version != "" {
		s.Available = false
		s.Reason = "docker CLI present but daemon unreachable (Cannot connect to the Docker daemon)"
		s.Version = v.Client.Version
		return s
	}
	s.Available = false
	s.Reason = "could not determine docker version"
	return s
}

func errPos(line int, raw string, err error) error {
	return errors.New("docker line " + strconv.Itoa(line) + " (" + truncate(raw, 80) + "): " + err.Error())
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

// safeContainerID returns the input if it's a plausible Docker container
// ID (lowercase hex prefix 12-64 chars, or a name made of [a-zA-Z0-9_.-]).
// Used to refuse shell-metachar smuggling on the mutating endpoints; we
// never call out to sh -c with a raw user-supplied ID otherwise.
var containerIDRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.\-]{0,127}$`)

func safeContainerID(id string) bool {
	return containerIDRe.MatchString(id)
}
