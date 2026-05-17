package model

import "time"

// OIDCClient is a registered upstream IdP this gateway can delegate
// authentication to (Keycloak, Auth0, Google, Feishu, etc.).
type OIDCClient struct {
	ID                    uint64    `gorm:"primaryKey" json:"id"`
	Name                  string    `gorm:"size:64;uniqueIndex;not null" json:"name"`
	DisplayName           string    `gorm:"size:128" json:"display_name"`
	Issuer                string    `gorm:"size:512;not null" json:"issuer"`
	ClientID              string    `gorm:"size:255;not null" json:"client_id"`
	ClientSecretEncrypted []byte    `gorm:"type:varbinary(1024)" json:"-"`
	RedirectURI           string    `gorm:"size:512" json:"redirect_uri"`
	Scopes                string    `gorm:"size:255" json:"scopes"`
	UsernameClaim         string    `gorm:"size:64" json:"username_claim"`
	EmailClaim            string    `gorm:"size:64" json:"email_claim"`
	AutoCreateUser        bool      `gorm:"default:false" json:"auto_create_user"`
	DefaultRole           string    `gorm:"size:64" json:"default_role"`
	Enabled               bool      `gorm:"default:true" json:"enabled"`
	CreatedAt             time.Time `json:"created_at"`
	UpdatedAt             time.Time `json:"updated_at"`
}

func (OIDCClient) TableName() string { return "oidc_clients" }
