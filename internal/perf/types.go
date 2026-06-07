// Package perf collects performance-diagnostic telemetry from a managed Linux
// node over SSH: PSI pressure stall, vmstat, iostat (if sysstat is present), the
// kernel ring buffer and OOM events. Read-only — gated by ActionConnect.
package perf

import (
	"errors"
	"time"
)

// PressureMetric is one PSI line's rolling averages (percent of wall time the
// resource was stalled over the last 10 / 60 / 300 seconds).
type PressureMetric struct {
	Avg10  float64 `json:"avg10"`
	Avg60  float64 `json:"avg60"`
	Avg300 float64 `json:"avg300"`
}

// Pressure is the /proc/pressure/* census (PSI; kernels ≥ 4.20).
type Pressure struct {
	Available bool           `json:"available"`
	CPUSome   PressureMetric `json:"cpu_some"`
	IOSome    PressureMetric `json:"io_some"`
	IOFull    PressureMetric `json:"io_full"`
	MemSome   PressureMetric `json:"mem_some"`
	MemFull   PressureMetric `json:"mem_full"`
}

// VMStat is the sampled (1s) vmstat row — already a rate, not a counter.
type VMStat struct {
	Available       bool  `json:"available"`
	ProcsR          int   `json:"procs_r"`
	ProcsB          int   `json:"procs_b"`
	SwapInKBs       int64 `json:"swap_in_kbs"`
	SwapOutKBs      int64 `json:"swap_out_kbs"`
	BlockInKBs      int64 `json:"block_in_kbs"`
	BlockOutKBs     int64 `json:"block_out_kbs"`
	Interrupts      int64 `json:"interrupts"`
	ContextSwitches int64 `json:"context_switches"`
	CPUUser         int   `json:"cpu_user"`
	CPUSystem       int   `json:"cpu_system"`
	CPUIdle         int   `json:"cpu_idle"`
	CPUIOWait       int   `json:"cpu_iowait"`
	CPUSteal        int   `json:"cpu_steal"`
}

// PerfDisk is one iostat -dx device row (steady-state second sample).
type PerfDisk struct {
	Device   string  `json:"device"`
	TPS      float64 `json:"tps"`
	ReadKBs  float64 `json:"read_kbs"`
	WriteKBs float64 `json:"write_kbs"`
	AwaitMs  float64 `json:"await_ms"`
	UtilPct  float64 `json:"util_pct"`
}

// Snapshot is the whole performance picture in one round-trip.
type Snapshot struct {
	GeneratedAt      time.Time  `json:"generated_at"`
	Load             [3]float64 `json:"load_avg"`
	Uptime           int64      `json:"uptime_sec"`
	Pressure         Pressure   `json:"pressure"`
	VMStat           VMStat     `json:"vmstat"`
	Disks            []PerfDisk `json:"disks"`
	SysstatAvailable bool       `json:"sysstat_available"`
	DmesgTail        []string   `json:"dmesg_tail,omitempty"`
	OOMEvents        []string   `json:"oom_events,omitempty"`
	Notes            string     `json:"notes,omitempty"`
}

// Dmesg is a stand-alone kernel ring buffer dump.
type Dmesg struct {
	Lines     []string  `json:"lines"`
	SampledAt time.Time `json:"sampled_at"`
}

var (
	ErrDisabled     = errors.New("perf: disabled by config")
	ErrUnauthorized = errors.New("perf: not authorised on node")
	ErrUnreachable  = errors.New("perf: node unreachable over ssh")
	ErrParse        = errors.New("perf: failed to parse output")
)
