package bridge

import (
	"context"
	"fmt"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/protocols/tcpfwd"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
)

// PortForwardManager adapts the existing tcpfwd.Manager to tools.PortForwardManager.
type PortForwardManager struct {
	Mgr   *tcpfwd.Manager
	Nodes *repo.NodeRepo
}

func (p *PortForwardManager) Create(ctx context.Context, userID uint64, username string, nodeID uint64, ttlSeconds int) (string, string, int, error) {
	if p == nil || p.Mgr == nil {
		return "", "", 0, fmt.Errorf("tcp forwarder not enabled")
	}
	node, err := p.Nodes.FindByID(ctx, nodeID)
	if err != nil || node == nil {
		return "", "", 0, fmt.Errorf("node %d not found", nodeID)
	}
	var ttl time.Duration
	if ttlSeconds > 0 {
		ttl = time.Duration(ttlSeconds) * time.Second
	}
	row, err := p.Mgr.Create(ctx, userID, username, node, ttl)
	if err != nil {
		return "", "", 0, err
	}
	return row.ID, row.LocalHost, row.LocalPort, nil
}

func (p *PortForwardManager) Close(ctx context.Context, id string) error {
	if p == nil || p.Mgr == nil {
		return fmt.Errorf("tcp forwarder not enabled")
	}
	return p.Mgr.Close(ctx, id)
}
