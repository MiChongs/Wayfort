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

	// Phase 22+ — Chinese DB stack registered via internal/dbquery's
	// plugin registry. PG-wire-compatible engines reuse the postgres
	// adapter; MySQL-wire-compatible engines reuse the mysql adapter;
	// Dameng (DM8) gets its own Oracle-flavoured adapter.
	NodeProtoDameng    NodeProtocol = "dameng"    // 达梦 DM8
	NodeProtoKingbase  NodeProtocol = "kingbase"  // 人大金仓 KingbaseES (PG-兼容)
	NodeProtoVastbase  NodeProtocol = "vastbase"  // 海量 Vastbase (PG-兼容)
	NodeProtoHighgo    NodeProtocol = "highgo"    // 瀚高 HighgoDB (PG-兼容)
	NodeProtoOpenGauss NodeProtocol = "opengauss" // 华为 openGauss (PG-兼容)
	NodeProtoGaussDB   NodeProtocol = "gaussdb"   // 华为 GaussDB (PG-兼容)
	NodeProtoTiDB      NodeProtocol = "tidb"      // PingCAP TiDB (MySQL-兼容)
	NodeProtoOceanBase NodeProtocol = "oceanbase" // 蚂蚁 OceanBase MySQL mode
	NodeProtoStarRocks NodeProtocol = "starrocks" // 飞轮 StarRocks (MySQL-兼容)
	NodeProtoDoris     NodeProtocol = "doris"     // Apache Doris (MySQL-兼容)
	NodeProtoGBase8a   NodeProtocol = "gbase8a"   // 南大通用 GBase 8a (MySQL-兼容)
	NodeProtoGBase8s   NodeProtocol = "gbase8s"   // 南大通用 GBase 8s (PG-兼容)

	// Object storage bastion. One node = one account/endpoint (credentials +
	// endpoint + region); the workspace browses every bucket the credential can
	// see. Provider-specific config (provider/endpoint/region/default bucket)
	// lives in Node.ProtoOptions as JSON. See internal/protocols/oss.
	NodeProtoOSS NodeProtocol = "oss" // 对象存储（阿里云 OSS / 腾讯 COS / S3 等）
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
	// DomainID binds the node to a network domain, the single source of truth
	// for connectivity (see internal/domain). Nullable for backward-compat;
	// migration backfills every existing node into the built-in "default" direct
	// domain so behaviour is unchanged. When ProxyChain below is non-empty it
	// acts as a deprecated per-node override of the domain's chain.
	DomainID *uint64 `gorm:"index" json:"domain_id,omitempty"`
	// ProxyChain is the legacy, ordered comma-separated list of Proxy IDs applied
	// left-to-right (outermost first), e.g. "3,1". DEPRECATED in favour of
	// DomainID; kept as a per-node override during the compatibility window.
	ProxyChain string `gorm:"size:255" json:"proxy_chain"`
	// ProtoOptions is a JSON blob with protocol-specific knobs (database name,
	// VNC color depth, RDP security mode, etc.). Empty == use protocol defaults.
	ProtoOptions string `gorm:"type:text" json:"proto_options,omitempty"`
	Tags         string `gorm:"size:255" json:"tags"`
	// Icon is an optional unified icon token ("simple:postgresql", "lucide:server",
	// "emoji:🐳", "text:DB"). Empty == derive from protocol on the client.
	Icon        string `gorm:"size:48" json:"icon,omitempty"`
	Region      string `gorm:"size:64" json:"region"`
	Description string `gorm:"size:512" json:"description"`
	Disabled    bool   `gorm:"default:false" json:"disabled"`

	// Phase 16 — approval enforcement flags. When set, the action-bearing
	// modules (webssh / dbcli / sftp / desktop / portforward) refuse the
	// action unless approval.Service.VerifyGrant returns an active grant.
	// Default false → no behavior change on existing deployments.
	RequiresApprovalForConnect  bool `gorm:"default:false" json:"requires_approval_for_connect"`
	RequiresApprovalForFileXfer bool `gorm:"default:false" json:"requires_approval_for_file_xfer"`

	// Phase 1.5 — Db Studio connection metadata. DBVirtualGroups holds a JSON
	// array of virtual group ids the node belongs to for Db Studio grouping.
	DBColor         string    `gorm:"size:16" json:"db_color,omitempty"`
	DBGroupPath     string    `gorm:"size:512" json:"db_group_path,omitempty"`
	DBVirtualGroups string    `gorm:"type:longtext" json:"db_virtual_groups,omitempty"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

func (Node) TableName() string { return "nodes" }

func (n *Node) EffectiveProtocol() NodeProtocol {
	if n.Protocol == "" {
		return NodeProtoSSH
	}
	return n.Protocol
}
