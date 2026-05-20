package model

import "time"

// NodeProtocol enumerates the kinds of remote endpoints the gateway can broker.
// New protocols only require: (a) a Backend impl or a protocol gateway, and
// (b) a row of this kind on the node.
type NodeProtocol string

const (
	NodeProtoSSH      NodeProtocol = "ssh"
	NodeProtoTelnet   NodeProtocol = "telnet"
	NodeProtoRDP      NodeProtocol = "rdp"
	NodeProtoVNC      NodeProtocol = "vnc"
	NodeProtoMySQL    NodeProtocol = "mysql"
	NodeProtoPostgres NodeProtocol = "postgres"
	NodeProtoRedis    NodeProtocol = "redis"
	NodeProtoMongo    NodeProtocol = "mongo"
	NodeProtoTCP      NodeProtocol = "tcp"
)

// Node is a target host the user wants to reach. ProxyChain is an ordered
// comma-separated list of Proxy IDs applied left-to-right (outermost first).
// Example: "3,1" means "go through proxy 3, then proxy 1, then target".
type Node struct {
	ID           uint64       `gorm:"primaryKey" json:"id"`
	Name         string       `gorm:"size:128;not null" json:"name"`
	Protocol     NodeProtocol `gorm:"size:16;default:ssh;not null" json:"protocol"`
	Host         string       `gorm:"size:255;not null" json:"host"`
	Port         int          `gorm:"default:22" json:"port"`
	Username     string       `gorm:"size:128" json:"username"`
	CredentialID uint64       `json:"credential_id"`
	ProxyChain   string       `gorm:"size:255" json:"proxy_chain"`
	// ProtoOptions is a JSON blob with protocol-specific knobs (database name,
	// VNC color depth, RDP security mode, etc.). Empty == use protocol defaults.
	ProtoOptions string    `gorm:"type:text" json:"proto_options,omitempty"`
	Tags         string    `gorm:"size:255" json:"tags"`
	Region       string    `gorm:"size:64" json:"region"`
	Description  string    `gorm:"size:512" json:"description"`
	Disabled     bool      `gorm:"default:false" json:"disabled"`

	// Phase 16 — approval enforcement flags. When set, the action-bearing
	// modules (webssh / dbcli / sftp / desktop / portforward) refuse the
	// action unless approval.Service.VerifyGrant returns an active grant.
	// Default false → no behavior change on existing deployments.
	RequiresApprovalForConnect  bool `gorm:"default:false" json:"requires_approval_for_connect"`
	RequiresApprovalForFileXfer bool `gorm:"default:false" json:"requires_approval_for_file_xfer"`

	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Node) TableName() string { return "nodes" }

func (n *Node) EffectiveProtocol() NodeProtocol {
	if n.Protocol == "" {
		return NodeProtoSSH
	}
	return n.Protocol
}
