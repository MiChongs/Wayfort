// Package oss is the object-storage bastion adapter layer. It exposes a single
// provider-neutral ObjectStore interface implemented per cloud (Aliyun OSS,
// Tencent COS, generic S3/MinIO) using each vendor's native SDK. All outbound
// traffic is routed through the Wayfort credential pool + proxy chain (see
// connector.go) so object storage is reached the same audited, brokered way as
// every other protocol.
package oss

import (
	"context"
	"io"
	"time"
)

// Bucket is a provider-neutral bucket descriptor.
type Bucket struct {
	Name         string    `json:"name"`
	Region       string    `json:"region,omitempty"`
	CreationDate time.Time `json:"creation_date,omitempty"`
}

// ObjectEntry is one row of a listing: either an object (file) or a
// common-prefix (a "folder", IsDir=true). Keys are full object keys; Name is
// the last path segment for display.
type ObjectEntry struct {
	Key          string    `json:"key"`
	Name         string    `json:"name"`
	IsDir        bool      `json:"is_dir"`
	Size         int64     `json:"size"`
	LastModified time.Time `json:"last_modified,omitempty"`
	ETag         string    `json:"etag,omitempty"`
	StorageClass string    `json:"storage_class,omitempty"`
}

// ListResult is one page of a delimited listing.
type ListResult struct {
	Bucket    string        `json:"bucket"`
	Prefix    string        `json:"prefix"`
	Delimiter string        `json:"delimiter"`
	Entries   []ObjectEntry `json:"entries"`
	NextToken string        `json:"next_token,omitempty"`
	Truncated bool          `json:"truncated"`
}

// ObjectMeta is the metadata returned by a HEAD.
type ObjectMeta struct {
	Key          string    `json:"key"`
	Size         int64     `json:"size"`
	ContentType  string    `json:"content_type,omitempty"`
	ETag         string    `json:"etag,omitempty"`
	LastModified time.Time `json:"last_modified,omitempty"`
	StorageClass string    `json:"storage_class,omitempty"`
}

// ObjectStore is the provider-neutral surface the handler drives. Folder
// semantics (mkdir, recursive delete, move) are composed by the handler from
// these primitives; a "folder" is a zero-byte key ending in "/".
type ObjectStore interface {
	// Provider returns the provider id ("aliyun" | "tencent" | "s3").
	Provider() string
	// ListBuckets returns every bucket the credential can see.
	ListBuckets(ctx context.Context) ([]Bucket, error)
	// ListObjects returns one page under prefix. delimiter "/" groups folders
	// into common-prefix entries (IsDir). token is the opaque page cursor
	// (continuation token / marker); pass the previous NextToken to continue.
	ListObjects(ctx context.Context, bucket, prefix, delimiter, token string, maxKeys int) (*ListResult, error)
	// HeadObject returns object metadata without the body.
	HeadObject(ctx context.Context, bucket, key string) (*ObjectMeta, error)
	// GetObject streams the whole object. Caller must Close the reader.
	GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, *ObjectMeta, error)
	// GetObjectRange streams bytes [start,end] inclusive (for text preview).
	GetObjectRange(ctx context.Context, bucket, key string, start, end int64) (io.ReadCloser, error)
	// PutObject writes an object. size<0 means unknown length (provider must
	// support streaming or buffer). contentType may be "".
	PutObject(ctx context.Context, bucket, key string, r io.Reader, size int64, contentType string) error
	// DeleteObject removes a single object (or folder marker) by exact key.
	DeleteObject(ctx context.Context, bucket, key string) error
	// CopyObject server-side copies src→dst (used for copy / move / rename).
	CopyObject(ctx context.Context, srcBucket, srcKey, dstBucket, dstKey string) error
	// Close releases provider clients (proxy-chain release is handled by the
	// connector's returned closer, not here).
	Close()
}
