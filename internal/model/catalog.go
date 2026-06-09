package model

import "time"

// Catalog is an admin-authored "授权目录" — a bespoke folder tree of assets that
// is INDEPENDENT of the global asset-group tree (asset_groups). The admin builds
// folders freely, drops nodes into them at any level, then assigns the catalog
// (or one of its folders) to grantees. A catalog is purely a presentation +
// authoring layer: when assigned it is resolved into the same node-id access set
// as AssetGrant by asset.Resolver, so the enforcement path is unchanged.
//
// IsTemplate is a UI flag only — it does not change resolution. A template is a
// catalog meant to be assigned to many grantees ("运维标准目录"); an unassigned
// catalog (template or not) reaches nobody.
type Catalog struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	Description string    `gorm:"size:512" json:"description"`
	Icon        string    `gorm:"size:48" json:"icon"` // unified icon token (emoji / lucide:* / simple:*)
	IsTemplate  bool      `gorm:"default:false" json:"is_template"`
	CreatedBy   uint64    `json:"created_by"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (Catalog) TableName() string { return "catalogs" }

// CatalogFolder is a folder inside a catalog. Path uses the materialised form
// ("12/45/77", folder IDs) so subtree lookups are a single LIKE scan — same
// pattern as AssetGroup. Subtree queries MUST also scope by catalog_id so paths
// can't bleed across catalogs.
type CatalogFolder struct {
	ID          uint64    `gorm:"primaryKey" json:"id"`
	CatalogID   uint64    `gorm:"index;not null" json:"catalog_id"`
	Name        string    `gorm:"size:128;not null" json:"name"`
	ParentID    *uint64   `gorm:"index" json:"parent_id,omitempty"`
	Path        string    `gorm:"size:255;index" json:"path"`
	Icon        string    `gorm:"size:48" json:"icon"`
	SortOrder   int       `gorm:"default:0" json:"sort_order"`
	Description string    `gorm:"size:255" json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
}

func (CatalogFolder) TableName() string { return "catalog_folders" }

// CatalogPlacement places a node inside a catalog folder. Deliberately NOT
// unique: the same node may appear in multiple folders. SortOrder lets the admin
// hand-order assets within a folder.
type CatalogPlacement struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	CatalogID uint64    `gorm:"index;not null" json:"catalog_id"`
	FolderID  uint64    `gorm:"index;not null" json:"folder_id"`
	NodeID    uint64    `gorm:"index;not null" json:"node_id"`
	SortOrder int       `gorm:"default:0" json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
}

func (CatalogPlacement) TableName() string { return "catalog_placements" }

// CatalogAssignment binds a catalog (FolderID == nil) or a single folder subtree
// (FolderID set) to a grantee, carrying the actions + validity window. Actions
// and validity live ONLY here (mirrors AssetGrant; the admin UI has a single
// "权限·有效期" panel). Resolution unions these into the same access set as
// AssetGrant, so a node reachable via both gets the union of actions.
type CatalogAssignment struct {
	ID          uint64      `gorm:"primaryKey" json:"id"`
	CatalogID   uint64      `gorm:"index:idx_cat_assign;not null" json:"catalog_id"`
	FolderID    *uint64     `json:"folder_id,omitempty"` // nil = whole catalog; set = that folder subtree
	GranteeType GranteeType `gorm:"size:16;index:idx_cat_grantee" json:"grantee_type"`
	GranteeID   uint64      `gorm:"index:idx_cat_grantee" json:"grantee_id"`
	Actions     string      `gorm:"size:255" json:"actions"`
	ValidFrom   *time.Time  `json:"valid_from,omitempty"`
	ValidTo     *time.Time  `json:"valid_to,omitempty"`
	CreatedBy   uint64      `json:"created_by"`
	CreatedAt   time.Time   `json:"created_at"`
}

func (CatalogAssignment) TableName() string { return "catalog_assignments" }
