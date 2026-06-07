package oss

import (
	"context"
	"io"
	"net/http"
	"strings"

	alioss "github.com/aliyun/aliyun-oss-go-sdk/oss"
)

// aliyunStore is the Aliyun OSS adapter (native SDK). The SDK methods are not
// context-aware; cancellation is bounded by the underlying http client's
// per-phase timeouts. ctx is accepted for interface parity.
type aliyunStore struct {
	client *alioss.Client
	http   *http.Client
}

func newAliyunStore(opts Options, ak, sk string, httpClient *http.Client) (ObjectStore, error) {
	client, err := alioss.New(opts.Endpoint, ak, sk, alioss.HTTPClient(httpClient))
	if err != nil {
		return nil, err
	}
	return &aliyunStore{client: client, http: httpClient}, nil
}

func (a *aliyunStore) Provider() string { return ProviderAliyun }

func (a *aliyunStore) ListBuckets(ctx context.Context) ([]Bucket, error) {
	out, err := a.client.ListBuckets()
	if err != nil {
		return nil, err
	}
	res := make([]Bucket, 0, len(out.Buckets))
	for _, b := range out.Buckets {
		res = append(res, Bucket{Name: b.Name, Region: b.Region, CreationDate: b.CreationDate})
	}
	return res, nil
}

func (a *aliyunStore) ListObjects(ctx context.Context, bucket, prefix, delimiter, token string, maxKeys int) (*ListResult, error) {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return nil, err
	}
	opts := []alioss.Option{}
	if prefix != "" {
		opts = append(opts, alioss.Prefix(prefix))
	}
	if delimiter != "" {
		opts = append(opts, alioss.Delimiter(delimiter))
	}
	if token != "" {
		opts = append(opts, alioss.ContinuationToken(token))
	}
	if maxKeys > 0 {
		opts = append(opts, alioss.MaxKeys(maxKeys))
	}
	out, err := bkt.ListObjectsV2(opts...)
	if err != nil {
		return nil, err
	}
	res := &ListResult{Bucket: bucket, Prefix: prefix, Delimiter: delimiter}
	for _, p := range out.CommonPrefixes {
		res.Entries = append(res.Entries, ObjectEntry{Key: p, Name: baseName(p), IsDir: true})
	}
	for _, o := range out.Objects {
		if o.Key == prefix {
			continue
		}
		res.Entries = append(res.Entries, ObjectEntry{
			Key:          o.Key,
			Name:         baseName(o.Key),
			Size:         o.Size,
			LastModified: o.LastModified,
			ETag:         strings.Trim(o.ETag, `"`),
			StorageClass: o.StorageClass,
			IsDir:        strings.HasSuffix(o.Key, "/"),
		})
	}
	res.Truncated = out.IsTruncated
	res.NextToken = out.NextContinuationToken
	return res, nil
}

func (a *aliyunStore) HeadObject(ctx context.Context, bucket, key string) (*ObjectMeta, error) {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return nil, err
	}
	h, err := bkt.GetObjectDetailedMeta(key)
	if err != nil {
		return nil, err
	}
	return metaFromHeader(key, h), nil
}

func (a *aliyunStore) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, *ObjectMeta, error) {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return nil, nil, err
	}
	meta := &ObjectMeta{Key: key}
	if h, e := bkt.GetObjectDetailedMeta(key); e == nil {
		meta = metaFromHeader(key, h)
	}
	body, err := bkt.GetObject(key)
	if err != nil {
		return nil, nil, err
	}
	return body, meta, nil
}

func (a *aliyunStore) GetObjectRange(ctx context.Context, bucket, key string, start, end int64) (io.ReadCloser, error) {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return nil, err
	}
	return bkt.GetObject(key, alioss.Range(start, end))
}

func (a *aliyunStore) PutObject(ctx context.Context, bucket, key string, r io.Reader, size int64, contentType string) error {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return err
	}
	var opts []alioss.Option
	if contentType != "" {
		opts = append(opts, alioss.ContentType(contentType))
	}
	if size >= 0 {
		opts = append(opts, alioss.ContentLength(size))
	}
	return bkt.PutObject(key, r, opts...)
}

func (a *aliyunStore) DeleteObject(ctx context.Context, bucket, key string) error {
	bkt, err := a.client.Bucket(bucket)
	if err != nil {
		return err
	}
	return bkt.DeleteObject(key)
}

func (a *aliyunStore) CopyObject(ctx context.Context, srcBucket, srcKey, dstBucket, dstKey string) error {
	dst, err := a.client.Bucket(dstBucket)
	if err != nil {
		return err
	}
	if srcBucket == dstBucket {
		_, err = dst.CopyObject(srcKey, dstKey)
		return err
	}
	_, err = dst.CopyObjectFrom(srcBucket, srcKey, dstKey)
	return err
}

func (a *aliyunStore) Close() {
	if a.http != nil {
		a.http.CloseIdleConnections()
	}
}
