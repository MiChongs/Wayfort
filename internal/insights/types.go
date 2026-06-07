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
	DiskIO        []DiskIO    `json:"disk_io,omitempty"`  // per-device throughput (delta).
	Interfaces    []NetIface  `json:"interfaces"`
	Temps         []TempSensor `json:"temps,omitempty"`   // thermal zones, best-effort.
	Procs         ProcSummary  `json:"procs"`             // task-state census.
	Sessions      []LoginUser  `json:"sessions,omitempty"` // who is logged in.
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
	// Aggregate busy-time breakdown over the last interval (0..100 each).
	// -1 until a second sample establishes a delta.
	UserPct   float64   `json:"user_pct"`
	SystemPct float64   `json:"system_pct"`
	IOWaitPct float64   `json:"iowait_pct"`
	StealPct  float64   `json:"steal_pct"`
	// PerCore is the per-logical-CPU busy percentage, ordered by core index.
	// Empty until a delta is available.
	PerCore []float64 `json:"per_core,omitempty"`
	MHz     float64   `json:"mhz,omitempty"`    // current frequency, best-effort.
	TempC   float64   `json:"temp_c,omitempty"` // package temp °C, 0 if unknown.
}

// DiskIO is per-block-device throughput computed from two /proc/diskstats
// samples. Only whole disks are surfaced (partitions and loop/ram devices are
// filtered out).
type DiskIO struct {
	Device    string  `json:"device"`
	ReadBps   int64   `json:"read_bps"`
	WriteBps  int64   `json:"write_bps"`
	ReadIOPS  int64   `json:"read_iops"`
	WriteIOPS int64   `json:"write_iops"`
	UtilPct   float64 `json:"util_pct"` // fraction of wall time the device was busy.
}

// TempSensor is one thermal zone reading in °C.
type TempSensor struct {
	Label string  `json:"label"`
	TempC float64 `json:"temp_c"`
}

// ProcSummary is the task-state census from `ps -eo stat`.
type ProcSummary struct {
	Total    int `json:"total"`
	Running  int `json:"running"`
	Sleeping int `json:"sleeping"`
	Stopped  int `json:"stopped"`
	Zombie   int `json:"zombie"`
	Threads  int `json:"threads,omitempty"`
}

// LoginUser is one row of `who` — an interactive login session.
type LoginUser struct {
	User  string `json:"user"`
	TTY   string `json:"tty"`
	From  string `json:"from,omitempty"`
	Login string `json:"login,omitempty"`
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

// cpuTimes is the full jiffy breakdown of one /proc/stat cpu line, cached
// between snapshots to compute the busy-time breakdown and per-core usage.
// Not exposed.
type cpuTimes struct {
	User    uint64
	Nice    uint64
	System  uint64
	Idle    uint64
	IOWait  uint64
	IRQ     uint64
	SoftIRQ uint64
	Steal   uint64
}

func (c cpuTimes) total() uint64 {
	return c.User + c.Nice + c.System + c.Idle + c.IOWait + c.IRQ + c.SoftIRQ + c.Steal
}

func (c cpuTimes) idleAll() uint64 { return c.Idle + c.IOWait }

// diskCounter is the cumulative /proc/diskstats row we cache between snapshots
// to compute per-device throughput. Sectors are 512 bytes. Not exposed.
type diskCounter struct {
	ReadSectors  int64
	WriteSectors int64
	ReadOps      int64
	WriteOps     int64
	IOMs         int64 // ms the device spent doing I/O (field 13).
	At           time.Time
}

// ifaceCounter is the cumulative byte counter we cache between snapshots to
// compute per-interface bandwidth. Not exposed.
type ifaceCounter struct {
	Rx int64
	Tx int64
	At time.Time
}
