package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/michongs/jumpserver-anonymous/internal/asset"
)

// RegisterSSHTools adds the three SSH-execution tools:
//   - ssh_exec        : arbitrary command (HIGH danger, requires approval in normal mode)
//   - ssh_exec_readonly: allow-list-gated commands (LOW)
//   - health_check    : canned diagnostic bundle (LOW)
//
// readonlyAllow REPLACES the curated default when non-empty.
// readonlyExtra is always appended on top of whatever the resolved base is,
// letting operators keep the curated default and just whitelist a few extras.
func RegisterSSHTools(reg *Registry, deps Deps, readonlyAllow []string, readonlyExtra ...[]string) {
	var extra []string
	if len(readonlyExtra) > 0 {
		extra = readonlyExtra[0]
	}
	allow := normaliseAllow(readonlyAllow, extra)

	reg.Register(&Tool{
		Name:                "ssh_exec",
		Description:         "在指定节点上执行任意 shell 命令。会产生实际变更，需用户确认。",
		Danger:              DangerHigh,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"command":{"type":"string","description":"要执行的命令（单条 shell 行）"},
			"timeout_sec":{"type":"integer","description":"最大执行秒数，默认 30","minimum":1,"maximum":600}},
			"required":["node_id","command"]}`),
		Run:    sshExecRunner(deps, false, nil),
		DryRun: sshExecDryRun,
	})

	reg.Register(&Tool{
		Name:                "ssh_exec_readonly",
		Description:         "在指定节点上执行预设白名单内的只读命令。支持管道（|）与 && 串接，每段都会被独立校验；禁止重定向 / 命令替换 / 后台执行。常见命令如 ls/cat/grep/awk/sed/find/ps/top -bn1/free/df/du/journalctl/systemctl status/docker ps/kubectl get/ss/ip/netstat 等均已允许。",
		Danger:              DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"},
			"command":{"type":"string","description":"shell 命令；允许 | 和 && 组合，每段必须命中白名单"},
			"timeout_sec":{"type":"integer","minimum":1,"maximum":120}},
			"required":["node_id","command"]}`),
		Run: sshExecRunner(deps, true, allow),
	})

	reg.Register(&Tool{
		Name:                "health_check",
		Description:         "一次性收集节点的系统健康指标：uptime / load / 内存 / 各分区磁盘 / 当前登录 / 网络监听端口 / 系统服务异常状态。",
		Danger:              DangerLow,
		RequiredAssetAction: asset.ActionConnect,
		Schema: json.RawMessage(`{"type":"object","properties":{
			"node_id":{"type":"integer"}},
			"required":["node_id"]}`),
		Run: func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
			var a struct {
				NodeID uint64 `json:"node_id"`
			}
			if err := json.Unmarshal(raw, &a); err != nil || a.NodeID == 0 {
				return "", fmt.Errorf("node_id required")
			}
			cmd := strings.Join([]string{
				"echo '== uptime =='", "uptime",
				"echo '== load =='", "cat /proc/loadavg 2>/dev/null",
				"echo '== free =='", "free -m 2>/dev/null",
				"echo '== df =='", "df -h 2>/dev/null",
				"echo '== top5_cpu =='", "ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu 2>/dev/null | head -6",
				"echo '== top5_mem =='", "ps -eo pid,user,%cpu,%mem,comm --sort=-%mem 2>/dev/null | head -6",
				"echo '== who =='", "who 2>/dev/null",
				"echo '== ss_listen =='", "ss -tunlp 2>/dev/null | head -20",
				"echo '== failed_units =='", "systemctl --failed --no-legend 2>/dev/null",
			}, " && ")
			out, errOut, exit, err := deps.NodeRunner.ExecStream(ctx, tctx.UserID, a.NodeID, cmd, 30, tctx.Stream)
			if err != nil {
				return "", err
			}
			body, _ := Truncate(out + "\n" + errOut)
			return body + fmt.Sprintf("\n[exit=%d]", exit), nil
		},
	})
}

func sshExecRunner(deps Deps, readonly bool, allow []string) RunFn {
	return func(ctx context.Context, tctx ToolCtx, raw json.RawMessage) (string, error) {
		var a struct {
			NodeID  uint64 `json:"node_id"`
			Command string `json:"command"`
			Timeout int    `json:"timeout_sec"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return "", err
		}
		if a.NodeID == 0 || strings.TrimSpace(a.Command) == "" {
			return "", fmt.Errorf("node_id and command required")
		}
		if readonly {
			if reason := commandAllowedReason(a.Command, allow); reason != "" {
				return "", fmt.Errorf("%s", reason)
			}
		}
		if a.Timeout <= 0 {
			a.Timeout = 30
		}
		out, errOut, exit, err := deps.NodeRunner.ExecStream(ctx, tctx.UserID, a.NodeID, a.Command, a.Timeout, tctx.Stream)
		if err != nil {
			return "", err
		}
		merged := out
		if errOut != "" {
			merged += "\n[stderr]\n" + errOut
		}
		body, _ := Truncate(merged)
		return body + fmt.Sprintf("\n[exit=%d]", exit), nil
	}
}

func sshExecDryRun(_ context.Context, _ ToolCtx, raw json.RawMessage) (string, error) {
	var a struct {
		NodeID  uint64 `json:"node_id"`
		Command string `json:"command"`
	}
	_ = json.Unmarshal(raw, &a)
	return fmt.Sprintf("[plan mode] would execute on node %d: %s", a.NodeID, a.Command), nil
}

// ===== readonly allow-list engine =====

// dangerousFragments are shell metacharacters that, if present anywhere in the
// command, would let the agent escape the readonly contract: command
// substitution ($(), backticks), redirection (>, <), statement separators (;),
// or bare backgrounding (& not part of &&). We reject the whole command on
// first sighting and tell the agent to use ssh_exec instead.
var dangerousFragments = []string{"$(", "`", ">", "<", ";"}

// normaliseAllow resolves the effective allow list. Behaviour:
//   - if `in` is non-empty: that REPLACES the curated default (use for lock-down)
//   - if `in` is empty: curated DefaultReadonlyAllow is used
//   - `extra` (if any) is ALWAYS appended on top of the resolved base
//     (use for "I want default + my custom entries" — no need to copy 140 lines)
func normaliseAllow(in, extra []string) []string {
	var base []string
	if len(in) > 0 {
		base = in
	} else {
		base = DefaultReadonlyAllow
	}
	if len(extra) == 0 {
		return base
	}
	out := make([]string, 0, len(base)+len(extra))
	out = append(out, base...)
	out = append(out, extra...)
	return out
}

// DefaultReadonlyAllow is the canonical safe-command allowlist for
// ssh_exec_readonly. Two flavours of entries:
//
//   - **binary-only** (no spaces): the very first token of a segment must
//     equal this. Use for binaries that are wholly readonly regardless of
//     arguments (e.g. ls, cat, ss, ip, netstat, journalctl).
//   - **prefix** (contains spaces): the segment must start with "<entry> "
//     or equal "<entry>". Use for binaries with mixed safety where only
//     specific subcommands are readonly (e.g. "systemctl status",
//     "docker ps", "kubectl get").
//
// Operators can override the whole list via configs/config.yaml's
// `ai.ssh_exec_readonly_allow`. Adding to (not replacing) the default is
// not currently supported — copy the list and edit.
var DefaultReadonlyAllow = []string{
	// --- text reading / filtering ---
	"ls", "dir", "cat", "tac", "nl", "grep", "egrep", "fgrep", "zgrep", "zcat",
	"tail", "head", "awk", "gawk", "sed", "wc", "sort", "uniq", "cut", "tr",
	"column", "tee", "tsort", "rev", "expand", "fold", "fmt", "paste",
	"xxd", "od", "hexdump", "base64",
	"strings", "find", "locate", "file", "stat", "tree", "less", "more",
	"readlink", "realpath", "dirname", "basename",
	"md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum",
	"diff", "comm", "cmp",

	// --- system info ---
	"uptime", "free", "df", "du", "echo", "printf",
	"date", "cal", "ncal",
	"id", "whoami", "who", "w", "users", "groups",
	"last", "lastlog", "loginctl",
	"uname", "hostname", "hostnamectl", "localectl", "timedatectl", "arch",
	"env", "printenv", "locale", "getent",
	"which", "type", "command", "hash",
	"pwd",

	// --- process / kernel ---
	"ps", "pgrep", "pidof", "pstree", "jobs",
	"dmesg", "lsmod", "lsof", "lscpu", "lsblk", "lspci", "lsusb",
	"mount", "findmnt", "blkid", "swapon",
	"hwclock", "fuser",

	// --- network ---
	"ss", "ip", "netstat", "route", "arp",
	"dig", "host", "nslookup", "whois", "traceroute", "tracepath",
	"mtr", "ping", "ping6",
	"ethtool", "ip6tables-save", "iptables-save",

	// --- system stat / monitoring (always batch / no-tui flavours) ---
	"iostat", "vmstat", "mpstat", "sar", "pidstat", "tcpstat", "uptime",
	"journalctl", // entirely read-only

	// --- top / htop / iotop need batch mode (no interactive TUI) ---
	"top -b", "top -bn", "top -bn1", "htop --batch", "iotop -b", "iotop -bn",

	// --- container & orchestration (readonly subcommands only) ---
	"docker ps", "docker images", "docker inspect", "docker logs",
	"docker stats", "docker top", "docker version", "docker info",
	"docker history", "docker port", "docker diff", "docker events",
	"docker network ls", "docker network inspect",
	"docker volume ls", "docker volume inspect",
	"docker container ls", "docker container inspect",
	"docker image ls", "docker image inspect",
	"docker system df", "docker system info", "docker system events",
	"docker compose ps", "docker compose top", "docker compose images",
	"docker compose logs", "docker compose config",

	"crictl ps", "crictl images", "crictl logs", "crictl inspect",
	"crictl version", "crictl info", "crictl stats",

	"kubectl get", "kubectl describe", "kubectl logs", "kubectl top",
	"kubectl version", "kubectl cluster-info", "kubectl explain",
	"kubectl api-resources", "kubectl api-versions",
	"kubectl config view", "kubectl config get-contexts", "kubectl config current-context",

	"helm list", "helm status", "helm history", "helm get", "helm version",

	// --- systemd (readonly subcommands only) ---
	"systemctl status", "systemctl is-active", "systemctl is-enabled",
	"systemctl is-failed", "systemctl list-units", "systemctl list-sockets",
	"systemctl list-timers", "systemctl list-jobs",
	"systemctl list-dependencies", "systemctl show",
	"systemctl cat", "systemctl get-default", "systemctl --failed",

	// --- package query (readonly only) ---
	"apt list", "apt-cache", "apt show",
	"dpkg -l", "dpkg --list", "dpkg -L", "dpkg -s",
	"dnf list", "dnf info", "dnf repolist", "dnf search",
	"yum list", "yum info", "yum repolist",
	"rpm -q", "rpm -qa", "rpm -qi", "rpm -ql", "rpm -V",
	"pacman -Q", "pacman -Qi", "pacman -Ql",

	// --- HTTP probes (GET / HEAD only — no -X to write methods) ---
	"curl -I", "curl --head", "curl -s", "curl --silent",
	"curl -sI", "curl -sf", "curl -fsSL",
	"wget --spider", "wget -q --spider",

	// --- git (readonly subcommands only) ---
	"git status", "git log", "git show", "git diff", "git blame",
	"git branch", "git remote", "git tag", "git reflog", "git ls-files",
	"git ls-tree", "git cat-file", "git rev-parse", "git config --get",
}

// commandAllowedReason returns "" if the command is allowed, otherwise a
// short reason string suitable for surfacing back to the model.
func commandAllowedReason(cmd string, allow []string) string {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return "command is empty"
	}
	if reason := containsDangerous(trimmed); reason != "" {
		return reason + " (use ssh_exec if you really need this)"
	}
	for _, seg := range splitConjunctions(trimmed) {
		seg = strings.TrimSpace(seg)
		if seg == "" {
			return "empty segment between | or &&"
		}
		if reason := containsDangerous(seg); reason != "" {
			return reason
		}
		if !segmentAllowed(seg, allow) {
			return fmt.Sprintf("command segment %q not in readonly allow-list", abbreviate(seg, 80))
		}
	}
	return ""
}

func containsDangerous(s string) string {
	for _, frag := range dangerousFragments {
		if strings.Contains(s, frag) {
			return fmt.Sprintf("dangerous shell metachar %q", frag)
		}
	}
	// Detect bare "&" (backgrounding / multiple commands) — but tolerate
	// "&&" as a conjunction. Strip "&&" first then look for any remaining "&".
	stripped := strings.ReplaceAll(s, "&&", "")
	if strings.Contains(stripped, "&") {
		return `dangerous shell metachar "&" (backgrounding)`
	}
	return ""
}

// splitConjunctions splits a command line on "&&" and "|" into independent
// segments. Each segment must independently match the allow list. Note that
// the splitter does NOT understand quoting — e.g. `echo "a | b"` would be
// split, which would conservatively reject. That's fine for the readonly
// surface; the model can fall back to ssh_exec for fancy quoting.
func splitConjunctions(s string) []string {
	out := []string{}
	for _, andSeg := range strings.Split(s, "&&") {
		for _, pipeSeg := range strings.Split(andSeg, "|") {
			t := strings.TrimSpace(pipeSeg)
			if t != "" {
				out = append(out, t)
			}
		}
	}
	return out
}

// segmentAllowed checks one pipe segment against the allow list. Two match
// modes per allow entry:
//
//   - no space → binary-only: first token of seg must equal entry.
//   - has space → prefix: seg must start with "entry " (or equal entry).
func segmentAllowed(seg string, allow []string) bool {
	first := firstToken(seg)
	for _, entry := range allow {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, " ") {
			if seg == entry || strings.HasPrefix(seg, entry+" ") {
				return true
			}
		} else {
			if first == entry {
				return true
			}
		}
	}
	return false
}

func firstToken(cmd string) string {
	for i, c := range cmd {
		if c == ' ' || c == '\t' {
			return cmd[:i]
		}
	}
	return cmd
}

func abbreviate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
