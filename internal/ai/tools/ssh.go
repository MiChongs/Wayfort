package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/michongs/wayfort/internal/asset"
	"mvdan.cc/sh/v3/syntax"
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
//
// Validation is AST-driven (mvdan.cc/sh): the command is parsed into a shell
// syntax tree and we reject only *real* contract-breaking nodes (redirects,
// command/process/arith substitution, backgrounding, multiple statements, and
// operators other than | && ||). Quoted literals such as `grep 'a | b'` are
// plain text in the tree, so they are never mistaken for operators — fixing the
// old substring matcher's false positives on `<`, `>`, `;`, etc.

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
	// NOTE: "tee" intentionally excluded — it writes files, violating the
	// readonly contract (`... | tee /etc/x`). Use ssh_exec for that.
	"column", "tsort", "rev", "expand", "fold", "fmt", "paste",
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

// commandAllowedReason returns "" if the command is allowed for the readonly
// surface, otherwise a short reason string suitable for surfacing back to the
// model. It parses the command into a shell AST (mvdan.cc/sh) so that quoted
// literals are never mistaken for real operators — `grep 'a | b' f` is fine,
// while `ls > /tmp/x` is a real redirect and is rejected.
func commandAllowedReason(cmd string, allow []string) string {
	trimmed := strings.TrimSpace(cmd)
	if trimmed == "" {
		return "command is empty"
	}
	file, err := syntax.NewParser().Parse(strings.NewReader(trimmed), "")
	if err != nil {
		return fmt.Sprintf("无法解析命令(shell 语法错误): %s —— 如确需复杂语法请改用 ssh_exec", cleanParseErr(err))
	}
	// Multiple top-level statements means ";" / newline separation — not a
	// pipeline or && / || conjunction. Reject (the readonly surface is one
	// logical command line).
	if len(file.Stmts) != 1 {
		return readonlyEscape("多条语句(; 或换行)")
	}
	// Reject any node that lets the command escape the readonly contract.
	if reason := scanDanger(file); reason != "" {
		return reason
	}
	// Validate the leading command of every pipeline / && / || segment.
	var firstReject string
	syntax.Walk(file, func(node syntax.Node) bool {
		if firstReject != "" {
			return false
		}
		ce, ok := node.(*syntax.CallExpr)
		if !ok || len(ce.Args) == 0 {
			return true
		}
		seg, ok := segmentLiteral(ce.Args)
		if !ok {
			firstReject = "命令名包含动态展开($VAR/$()/未解析通配)，无法核验白名单；请改用 ssh_exec"
			return false
		}
		if !segmentAllowed(seg, allow) {
			firstReject = fmt.Sprintf(
				"command segment %q not in readonly allow-list（命令段不在只读白名单内）；"+
					"若确需写操作/重定向/管道到写命令，请改用 ssh_exec(高危工具，会触发用户审批)",
				abbreviate(seg, 80))
			return false
		}
		return true
	})
	return firstReject
}

// readonlyEscape wraps a danger reason with the standard remediation pointer.
func readonlyEscape(what string) string {
	return what + " (use ssh_exec if you really need this)"
}

// scanDanger walks the AST and returns a non-empty reason on the first node
// that would break the readonly contract. Quoted text is not an operator in the
// tree, so it is naturally allowed.
func scanDanger(file *syntax.File) string {
	var reason string
	syntax.Walk(file, func(node syntax.Node) bool {
		if reason != "" {
			return false
		}
		switch n := node.(type) {
		case *syntax.Redirect:
			reason = readonlyEscape(fmt.Sprintf("重定向 %q", n.Op.String()))
		case *syntax.CmdSubst:
			if n.Backquotes {
				reason = readonlyEscape("命令替换(反引号)")
			} else {
				reason = readonlyEscape("命令替换 $(...)")
			}
		case *syntax.ProcSubst:
			reason = readonlyEscape("进程替换 <(...)/>(...)")
		case *syntax.ArithmExp:
			reason = readonlyEscape("算术替换 $((...))")
		case *syntax.Stmt:
			if n.Background {
				reason = readonlyEscape(`后台执行 "&"`)
			}
		case *syntax.BinaryCmd:
			switch n.Op {
			case syntax.Pipe, syntax.PipeAll, syntax.AndStmt, syntax.OrStmt:
				// allowed: pipeline (| |&) and conjunctions (&& ||)
			default:
				reason = readonlyEscape(fmt.Sprintf("操作符 %q", n.Op.String()))
			}
		}
		return true
	})
	return reason
}

// segmentLiteral reconstructs the leading run of literal words of a simple
// command into a space-joined string ("docker" "ps" "-a" -> "docker ps -a").
// It stops at the first word with a non-literal part (param/cmd/arith
// expansion); that is fine because allow-list entries are always literal
// command + subcommand tokens. ok=false only when the command name itself is
// dynamic (first word non-literal).
func segmentLiteral(args []*syntax.Word) (string, bool) {
	parts := make([]string, 0, len(args))
	for _, w := range args {
		lit, ok := wordLiteral(w)
		if !ok {
			break
		}
		parts = append(parts, lit)
	}
	if len(parts) == 0 {
		return "", false
	}
	return strings.Join(parts, " "), true
}

// wordLiteral returns the literal text of a word if it is composed solely of
// literal / quoted-literal parts (no expansions), else ok=false.
func wordLiteral(w *syntax.Word) (string, bool) {
	var b strings.Builder
	for _, part := range w.Parts {
		switch p := part.(type) {
		case *syntax.Lit:
			b.WriteString(p.Value)
		case *syntax.SglQuoted:
			b.WriteString(p.Value)
		case *syntax.DblQuoted:
			for _, dp := range p.Parts {
				lit, ok := dp.(*syntax.Lit)
				if !ok {
					return "", false
				}
				b.WriteString(lit.Value)
			}
		default:
			return "", false
		}
	}
	return b.String(), true
}

// cleanParseErr trims the noisy positional prefix from a mvdan/sh parse error.
func cleanParseErr(err error) string {
	msg := err.Error()
	if i := strings.LastIndex(msg, ": "); i >= 0 && i+2 < len(msg) {
		return msg[i+2:]
	}
	return msg
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
