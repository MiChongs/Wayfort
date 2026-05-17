package model

import "time"

// Department is a tree node. Path is materialised ("1/4/9") so subtree queries
// can be implemented with a single LIKE prefix scan.
type Department struct {
	ID        uint64    `gorm:"primaryKey" json:"id"`
	Name      string    `gorm:"size:128;not null" json:"name"`
	ParentID  *uint64   `gorm:"index" json:"parent_id,omitempty"`
	Path      string    `gorm:"size:255;index" json:"path"`
	OrderIdx  int       `gorm:"default:0" json:"order_idx"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (Department) TableName() string { return "departments" }
