package dbquery

import (
	"context"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// EngineInfo is the catalog row the UI consumes for the node-creation
// protocol picker and the per-node /db/capabilities response. One row
// per registered Adapter; populated lazily from the Registry so plugin
// hot-swap shows up without a restart.
type EngineInfo struct {
	Protocol     model.NodeProtocol `json:"protocol"`
	Family       Family             `json:"family"`
	VendorLabel  string             `json:"vendor_label"`
	Capabilities Capabilities       `json:"capabilities"`
}

// EngineCatalog returns every adapter known to the registry, sorted by
// protocol id. Powers the /api/v1/db/engines catalogue used by the
// "新增节点" sheet's protocol dropdown and by the DB Studio's
// connect-time engine selector. Lookup is free of side effects so
// callers can poll cheaply.
func (s *Service) EngineCatalog() []EngineInfo {
	r := s.registry
	if r == nil {
		r = DefaultRegistry()
	}
	protos := r.List()
	out := make([]EngineInfo, 0, len(protos))
	for _, p := range protos {
		a, ok := r.Get(p)
		if !ok {
			continue
		}
		caps := a.Capabilities()
		label := caps.VendorLabel
		if label == "" {
			label = string(p)
		}
		out = append(out, EngineInfo{
			Protocol:     p,
			Family:       a.Family(),
			VendorLabel:  label,
			Capabilities: caps,
		})
	}
	return out
}

// CapabilitiesFor returns the Capabilities for one specific protocol
// without opening a connection. Returns the zero Capabilities with an
// empty VendorLabel when the adapter isn't registered — handlers
// should treat that as "engine not supported in this build".
func (s *Service) CapabilitiesFor(protocol model.NodeProtocol) Capabilities {
	r := s.registry
	if r == nil {
		r = DefaultRegistry()
	}
	a, ok := r.Get(protocol)
	if !ok {
		return Capabilities{}
	}
	return a.Capabilities()
}

// CapabilitiesForNode loads the node and returns the Capabilities of
// its protocol. Convenience method for the REST handler so it doesn't
// have to touch NodeRepo directly.
func (s *Service) CapabilitiesForNode(ctx context.Context, nodeID uint64) (Capabilities, error) {
	if s.gw == nil {
		return Capabilities{}, nil
	}
	node, err := s.gw.NodeRepo().FindByID(ctx, nodeID)
	if err != nil {
		return Capabilities{}, err
	}
	if node == nil {
		return Capabilities{}, nil
	}
	return s.CapabilitiesFor(node.EffectiveProtocol()), nil
}
