package oss

import (
	"encoding/json"
	"strings"
)

// Provider ids. Aliyun OSS and Tencent COS use their native SDKs; everything
// else (AWS S3, MinIO, Ceph RGW, generic S3-compatible) uses the S3 adapter.
const (
	ProviderAliyun  = "aliyun"
	ProviderTencent = "tencent"
	ProviderS3      = "s3"
)

// KnownProviders is the catalogue the admin UI offers.
func KnownProviders() []string { return []string{ProviderAliyun, ProviderTencent, ProviderS3} }

// Options is the OSS-specific config stored in Node.ProtoOptions as JSON under
// an {"oss": {...}} envelope (mirrors RDP/DB options).
type Options struct {
	Provider      string `json:"provider"`
	Endpoint      string `json:"endpoint"`
	Region        string `json:"region"`
	DefaultBucket string `json:"bucket,omitempty"`
	// PathStyle forces path-style addressing (MinIO / Ceph / some on-prem S3).
	PathStyle bool `json:"path_style,omitempty"`
	// InsecureTLS skips TLS verification (self-signed on-prem endpoints).
	InsecureTLS bool `json:"insecure_tls,omitempty"`
}

// ParseOptions reads Node.ProtoOptions. Accepts the {"oss":{...}} envelope or a
// flat object for forward/back compat.
func ParseOptions(raw string) Options {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return Options{}
	}
	var env struct {
		OSS *Options `json:"oss"`
	}
	if err := json.Unmarshal([]byte(raw), &env); err == nil && env.OSS != nil {
		return normalize(*env.OSS)
	}
	var flat Options
	if err := json.Unmarshal([]byte(raw), &flat); err == nil {
		return normalize(flat)
	}
	return Options{}
}

// Marshal serialises into the {"oss":{...}} envelope for Node.ProtoOptions.
func (o Options) Marshal() string {
	b, _ := json.Marshal(struct {
		OSS Options `json:"oss"`
	}{normalize(o)})
	return string(b)
}

func normalize(o Options) Options {
	o.Provider = strings.ToLower(strings.TrimSpace(o.Provider))
	o.Endpoint = strings.TrimSpace(o.Endpoint)
	o.Region = strings.TrimSpace(o.Region)
	o.DefaultBucket = strings.TrimSpace(o.DefaultBucket)
	switch o.Provider {
	case ProviderAliyun, ProviderTencent, ProviderS3:
	case "", "aws", "minio", "ceph", "s3-compatible":
		o.Provider = ProviderS3
	}
	return o
}
