package model

import "time"

// Node is a target host the user wants to reach. ProxyChain is an ordered
// comma-separated list of Proxy IDs applied left-to-right (outermost first).
// Example: "3,1" means "go through proxy 3, then proxy 1, then target".
type Node struct {
	ID           uint64    `gorm:"primaryKey" json:"id"`
	Name         string    `gorm:"size:128;not null" json:"name"`
	Host         string    `gorm:"size:255;not null" json:"host"`
	Port         int       `gorm:"default:22" json:"port"`
	Username     string    `gorm:"size:128;not null" json:"username"`
	CredentialID uint64    `json:"credential_id"`
	ProxyChain   string    `gorm:"size:255" json:"proxy_chain"`
	Tags         string    `gorm:"size:255" json:"tags"`
	Region       string    `gorm:"size:64" json:"region"`
	Description  string    `gorm:"size:512" json:"description"`
	Disabled     bool      `gorm:"default:false" json:"disabled"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Node) TableName() string { return "nodes" }
