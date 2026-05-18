// Package docker manages remote Docker daemons over SSH. The host runs
// `docker ps` / `docker images` / `docker logs` and similar commands; the
// gateway parses the output and returns structured JSON to the workspace.
//
// Read operations require ActionConnect on the node; mutating actions
// (start / stop / restart / rm) require the docker:manage permission.
package docker

import "time"

// Container holds the fields surfaced by `docker ps -a --format '{{json .}}'`.
// The Docker daemon's JSON output already uses these field names verbatim,
// so we keep them — easier to debug from a raw API response.
type Container struct {
	ID         string    `json:"id"`
	Names      string    `json:"names"`
	Image      string    `json:"image"`
	State      string    `json:"state"`   // "running" | "exited" | "paused" | …
	Status     string    `json:"status"`  // "Up 5 minutes" | "Exited (0) 2 days ago"
	Command    string    `json:"command"`
	Ports      string    `json:"ports"`
	CreatedAt  string    `json:"created_at"` // ISO-8601 string as Docker emits it
	SizeRootFs string    `json:"size_rootfs,omitempty"`
	SampledAt  time.Time `json:"sampled_at"`
}

// Image mirrors `docker images --format '{{json .}}'`.
type Image struct {
	ID         string    `json:"id"`
	Repository string    `json:"repository"`
	Tag        string    `json:"tag"`
	Digest     string    `json:"digest,omitempty"`
	Size       string    `json:"size"`
	CreatedAt  string    `json:"created_at"`
	SampledAt  time.Time `json:"sampled_at"`
}

// Status is the daemon-level snapshot returned by /docker/status. When the
// node has no Docker installed, Available=false and Reason explains it.
type Status struct {
	Available  bool      `json:"available"`
	Version    string    `json:"version,omitempty"`
	APIVersion string    `json:"api_version,omitempty"`
	OS         string    `json:"os,omitempty"`
	Reason     string    `json:"reason,omitempty"`
	Containers int       `json:"containers"`
	Images     int       `json:"images"`
	SampledAt  time.Time `json:"sampled_at"`
}

// LogsResponse wraps the captured container logs.
type LogsResponse struct {
	ContainerID string `json:"container_id"`
	Tail        int    `json:"tail"`
	Logs        string `json:"logs"`
}

// Action is the mutating verbs we expose.
type Action string

const (
	ActionStart   Action = "start"
	ActionStop    Action = "stop"
	ActionRestart Action = "restart"
	ActionRemove  Action = "remove"
)
