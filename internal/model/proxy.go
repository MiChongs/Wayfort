package model

import "time"

type ProxyKind string

const (
	ProxyDirect   ProxyKind = "direct"
	ProxySOCKS5   ProxyKind = "socks5"
	ProxyBastion  ProxyKind = "bastion"
	ProxyHTTPConn ProxyKind = "http_connect"
)

// Proxy is one hop in a connection chain. A bastion proxy references a
// Credential so we know how to SSH into it.
type Proxy struct {
	ID           uint64    `gorm:"primaryKey" json:"id"`
	Name         string    `gorm:"size:128;not null" json:"name"`
	Kind         ProxyKind `gorm:"size:32;not null" json:"kind"`
	Host         string    `gorm:"size:255" json:"host"`
	Port         int       `json:"port"`
	CredentialID *uint64   `json:"credential_id,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Proxy) TableName() string { return "proxies" }
