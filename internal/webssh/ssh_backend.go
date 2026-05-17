package webssh

import (
	"io"

	xssh "golang.org/x/crypto/ssh"
)

// SSHBackend wraps an interactive ssh.Session as a Backend for the WS pump.
// The ssh.Client itself is owned externally so multiple sessions can share it.
type SSHBackend struct {
	Session *xssh.Session
	stdin   io.WriteCloser
	stdout  io.Reader
}

func NewSSHBackend(s *xssh.Session, term string, cols, rows int) (*SSHBackend, error) {
	stdin, err := s.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := s.StdoutPipe()
	if err != nil {
		return nil, err
	}
	// Merge stderr into stdout so the WS pump sees one stream.
	stderr, err := s.StderrPipe()
	if err == nil {
		stdout = io.MultiReader(stdout, stderr)
	}
	if term == "" {
		term = "xterm-256color"
	}
	modes := xssh.TerminalModes{
		xssh.ECHO:          1,
		xssh.TTY_OP_ISPEED: 14400,
		xssh.TTY_OP_OSPEED: 14400,
	}
	if err := s.RequestPty(term, rows, cols, modes); err != nil {
		return nil, err
	}
	if err := s.Shell(); err != nil {
		return nil, err
	}
	return &SSHBackend{Session: s, stdin: stdin, stdout: stdout}, nil
}

func (b *SSHBackend) Read(p []byte) (int, error)  { return b.stdout.Read(p) }
func (b *SSHBackend) Write(p []byte) (int, error) { return b.stdin.Write(p) }
func (b *SSHBackend) Resize(cols, rows uint32) error {
	return b.Session.WindowChange(int(rows), int(cols))
}
func (b *SSHBackend) Close() error {
	_ = b.stdin.Close()
	return b.Session.Close()
}
