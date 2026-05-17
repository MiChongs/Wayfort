// Package insights collects live system telemetry (CPU, memory, disks,
// processes, network) from a target Linux node by running a small batch of
// commands over SSH and parsing the output into typed JSON.
//
// Plan 14: the SSH page surfaces these alongside the xterm terminal so users
// don't have to manually run `top` / `df` / `ss` to understand what's
// happening on the box.
package insights

import "time"

// SystemSnapshot is everything the "Overview" tab needs in one round-trip.
type SystemSnapshot struct {
	GeneratedAt   time.Time   `json:"generated_at"`
	Host          HostInfo    `json:"host"`
	CPU           CPUInfo     `json:"cpu"`
	Memory        MemoryInfo  `json:"memory"`
	LoadAvg       [3]float64  `json:"load_avg"` // 1 / 5 / 15 minute averages.
	Uptime        int64       `json:"uptime_sec"`
	Disks         []DiskUsage `json:"disks"`
	Interfaces    []NetIface  `json:"interfaces"`
	LoggedInUsers int         `json:"logged_in_users"`
	// Partial is true when at least one section could not be parsed. The UI
	// keeps rendering the rest but flags a small warning.
	Partial bool   `json:"partial,omitempty"`
	Notes   string `json:"notes,omitempty"`
}

type HostInfo struct {
	Hostname string `json:"hostname"`
	OS       string `json:"os"`     // uname -s (Linux, Darwin)
	Kernel   string `json:"kernel"` // uname -r
	Arch     string `json:"arch"`   // uname -m
	Distro   string `json:"distro"` // PRETTY_NAME from /etc/os-release
}

type CPUInfo struct {
	Model    string  `json:"model"`
	Cores    int     `json:"cores"`
	UsagePct float64 `json:"usage_pct"` // 0..100; -1 if not enough samples yet.
}

type MemoryInfo struct {
	TotalKb     int64 `json:"total_kb"`
	UsedKb      int64 `json:"used_kb"`
	FreeKb      int64 `json:"free_kb"`
	BuffCacheKb int64 `json:"buff_cache_kb"`
	AvailableKb int64 `json:"available_kb"`
	SwapTotalKb int64 `json:"swap_total_kb"`
	SwapUsedKb  int64 `json:"swap_used_kb"`
}

type DiskUsage struct {
	Mount     string `json:"mount"`
	FS        string `json:"fs"`
	TotalKb   int64  `json:"total_kb"`
	UsedKb    int64  `json:"used_kb"`
	AvailKb   int64  `json:"avail_kb"`
	UsedPct   int    `json:"used_pct"`
	Source    string `json:"source,omitempty"` // device path
}

type NetIface struct {
	Name      string `json:"name"`
	MAC       string `json:"mac,omitempty"`
	IPv4      string `json:"ipv4,omitempty"`
	IPv6      string `json:"ipv6,omitempty"`
	OperState string `json:"oper_state"` // UP / DOWN / UNKNOWN
	RxBytes   int64  `json:"rx_bytes"`
	TxBytes   int64  `json:"tx_bytes"`
	RxBps     int64  `json:"rx_bps"` // 0 on first sample.
	TxBps     int64  `json:"tx_bps"`
}

// ProcessList is returned by the /processes endpoint. The slice is already
// sorted by the requested key on the server so the UI can render directly.
type ProcessList struct {
	GeneratedAt time.Time `json:"generated_at"`
	Total       int       `json:"total"`
	Processes   []Process `json:"processes"`
	SortedBy    string    `json:"sorted_by"`
}

type Process struct {
	PID    int     `json:"pid"`
	PPID   int     `json:"ppid"`
	User   string  `json:"user"`
	CPUPct float64 `json:"cpu_pct"`
	MemPct float64 `json:"mem_pct"`
	RSSKb  int64   `json:"rss_kb"`
	State  string  `json:"state"`
	Comm   string  `json:"comm"`
	Args   string  `json:"args"`
}

// NetworkSnapshot exposes the listening sockets and basic counts. Active
// established connections are summarised as a count to keep the payload small.
type NetworkSnapshot struct {
	GeneratedAt time.Time   `json:"generated_at"`
	Listeners   []NetListen `json:"listeners"`
	Established int         `json:"established"`
}

type NetListen struct {
	Proto     string `json:"proto"` // tcp / tcp6 / udp / udp6
	LocalAddr string `json:"local_addr"`
	LocalPort int    `json:"local_port"`
	PID       int    `json:"pid,omitempty"`
	Process   string `json:"process,omitempty"`
}

// procStat is the cpu-time row we cache between snapshots to compute
// CPU usage_pct. Not exposed.
type procStat struct {
	Idle  uint64
	Total uint64
}

// ifaceCounter is the cumulative byte counter we cache between snapshots to
// compute per-interface bandwidth. Not exposed.
type ifaceCounter struct {
	Rx int64
	Tx int64
	At time.Time
}
