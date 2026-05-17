package model

import "time"

type User struct {
	ID           uint64    `gorm:"primaryKey" json:"id"`
	Username     string    `gorm:"size:64;uniqueIndex;not null" json:"username"`
	PasswordHash string    `gorm:"size:128;not null" json:"-"`
	DisplayName  string    `gorm:"size:128" json:"display_name"`
	Email        string    `gorm:"size:128" json:"email"`
	IsAdmin      bool      `gorm:"default:false" json:"is_admin"`
	Disabled     bool      `gorm:"default:false" json:"disabled"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (User) TableName() string { return "users" }
