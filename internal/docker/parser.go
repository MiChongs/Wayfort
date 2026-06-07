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

// imageRefRe allows repo[:tag][@digest] / image IDs.
var imageRefRe = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,200}$`)

func safeImageRef(s string) bool { return imageRefRe.MatchString(s) }

func safePruneWhat(s string) bool {
	switch s {
	case "system", "image", "container", "volume", "builder", "network":
		return true
	}
	return false
}

func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// parseInspect decodes `docker inspect <cid>` (a one-element array) into the
// curated ContainerDetail, keeping the pretty-printed element as Raw.
func parseInspect(stdout string) (*ContainerDetail, error) {
	stdout = strings.TrimSpace(stdout)
	if stdout == "" {
		return nil, errors.New("empty inspect output")
	}
	var arr []json.RawMessage
	if err := json.Unmarshal([]byte(stdout), &arr); err != nil || len(arr) == 0 {
		return nil, errors.New("could not parse docker inspect output")
	}
	type rawIns struct {
		ID      string `json:"Id"`
		Name    string `json:"Name"`
		Created string `json:"Created"`
		State   struct {
			Status    string `json:"Status"`
			StartedAt string `json:"StartedAt"`
		} `json:"State"`
		RestartCount int `json:"RestartCount"`
		Config       struct {
			Image string   `json:"Image"`
			Cmd   []string `json:"Cmd"`
			Env   []string `json:"Env"`
		} `json:"Config"`
		HostConfig struct {
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
		} `json:"HostConfig"`
		NetworkSettings struct {
			IPAddress string `json:"IPAddress"`
			Networks  map[string]struct {
				IPAddress string `json:"IPAddress"`
			} `json:"Networks"`
			Ports map[string][]struct {
				HostIP   string `json:"HostIp"`
				HostPort string `json:"HostPort"`
			} `json:"Ports"`
		} `json:"NetworkSettings"`
		Mounts []struct {
			Type        string `json:"Type"`
			Source      string `json:"Source"`
			Destination string `json:"Destination"`
		} `json:"Mounts"`
	}
	var r rawIns
	if err := json.Unmarshal(arr[0], &r); err != nil {
		return nil, errors.New("could not decode inspect fields")
	}
	d := &ContainerDetail{
		ID: r.ID, Name: strings.TrimPrefix(r.Name, "/"), Image: r.Config.Image,
		State: r.State.Status, Created: r.Created, StartedAt: r.State.StartedAt,
		RestartPolicy: r.HostConfig.RestartPolicy.Name, RestartCount: r.RestartCount,
		IPAddress: r.NetworkSettings.IPAddress, Cmd: strings.Join(r.Config.Cmd, " "),
		Env: r.Config.Env,
	}
	for name := range r.NetworkSettings.Networks {
		d.Networks = append(d.Networks, name)
	}
	for cport, binds := range r.NetworkSettings.Ports {
		if len(binds) == 0 {
			d.Ports = append(d.Ports, cport)
			continue
		}
		for _, b := range binds {
			d.Ports = append(d.Ports, b.HostIP+":"+b.HostPort+"→"+cport)
		}
	}
	for _, mnt := range r.Mounts {
		src := mnt.Source
		if mnt.Type == "volume" {
			src = "vol:" + src
		}
		d.Mounts = append(d.Mounts, src+"→"+mnt.Destination)
	}
	// Pretty raw for the power-user view.
	var pretty json.RawMessage = arr[0]
	if b, err := json.MarshalIndent(json.RawMessage(arr[0]), "", "  "); err == nil {
		pretty = b
	}
	d.Raw = string(pretty)
	return d, nil
}

// parseStats decodes `docker stats --no-stream --format '{{json .}}'` ndjson.
func parseStats(stdout string) []ContainerStats {
	type rawStat struct {
		ID       string `json:"ID"`
		Name     string `json:"Name"`
		CPUPerc  string `json:"CPUPerc"`
		MemUsage string `json:"MemUsage"`
		MemPerc  string `json:"MemPerc"`
		NetIO    string `json:"NetIO"`
		BlockIO  string `json:"BlockIO"`
		PIDs     string `json:"PIDs"`
	}
	out := []ContainerStats{}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var r rawStat
		if json.Unmarshal([]byte(line), &r) != nil {
			continue
		}
		pids, _ := strconv.Atoi(strings.TrimSpace(r.PIDs))
		out = append(out, ContainerStats{
			ID: r.ID, Name: r.Name,
			CPUPct: pctToFloat(r.CPUPerc), MemUsage: r.MemUsage, MemPct: pctToFloat(r.MemPerc),
			NetIO: r.NetIO, BlockIO: r.BlockIO, PIDs: pids,
		})
	}
	return out
}

func pctToFloat(s string) float64 {
	f, _ := strconv.ParseFloat(strings.TrimSuffix(strings.TrimSpace(s), "%"), 64)
	return f
}

// parseTop decodes `docker top <cid>` (whitespace columns; last column keeps
// the remainder so the command with spaces survives).
func parseTop(cid, stdout string) TopResult {
	res := TopResult{ContainerID: cid}
	lines := []string{}
	for _, l := range strings.Split(stdout, "\n") {
		if strings.TrimSpace(l) != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) == 0 {
		return res
	}
	res.Titles = strings.Fields(lines[0])
	n := len(res.Titles)
	for _, l := range lines[1:] {
		f := strings.Fields(l)
		if len(f) < n {
			res.Processes = append(res.Processes, f)
			continue
		}
		row := append([]string{}, f[:n-1]...)
		row = append(row, strings.Join(f[n-1:], " "))
		res.Processes = append(res.Processes, row)
	}
	return res
}

func parseNetworks(stdout string) []Network {
	type raw struct {
		ID, Name, Driver, Scope string
	}
	out := []Network{}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var r raw
		if json.Unmarshal([]byte(line), &r) != nil {
			continue
		}
		out = append(out, Network{ID: r.ID, Name: r.Name, Driver: r.Driver, Scope: r.Scope})
	}
	return out
}

func parseVolumes(stdout string) []Volume {
	type raw struct {
		Name, Driver, Mountpoint string
	}
	out := []Volume{}
	for _, line := range strings.Split(stdout, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var r raw
		if json.Unmarshal([]byte(line), &r) != nil {
			continue
		}
		out = append(out, Volume{Name: r.Name, Driver: r.Driver, Mountpoint: r.Mountpoint})
	}
	return out
}
