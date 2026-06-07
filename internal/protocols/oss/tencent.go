package oss

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	cos "github.com/tencentyun/cos-go-sdk-v5"
)

// tencentStore is the Tencent COS adapter (native SDK). COS addresses buckets
// per-region, so listing uses a service client while object ops use a
// per-bucket client; bucket→region is cached from ListBuckets and falls back to
// the node's configured region. Auth is injected via cos.AuthorizationTransport
// wrapping the proxy-chain transport.
type tencentStore struct {
	region    string
	secure    bool
	ak, sk    string
	transport http.RoundTripper
	http      *http.Client
	regions   map[string]string // bucket name (with appid) -> region
}

func newTencentStore(opts Options, ak, sk string, httpClient *http.Client) (ObjectStore, error) {
	tr := httpClient.Transport
	if tr == nil {
		tr = http.DefaultTransport
	}
	return &tencentStore{
		region:    opts.Region,
		secure:    true,
		ak:        ak,
		sk:        sk,
		transport: tr,
		http:      httpClient,
		regions:   map[string]string{},
	}, nil
}

func (t *tencentStore) Provider() string { return ProviderTencent }

func (t *tencentStore) authClient() *http.Client {
	return &http.Client{Transport: &cos.AuthorizationTransport{
		SecretID:  t.ak,
		SecretKey: t.sk,
		Transport: t.transport,
	}}
}

func (t *tencentStore) serviceClient() (*cos.Client, error) {
	host := "https://service.cos.myqcloud.com"
	if t.region != "" {
		host = fmt.Sprintf("https://cos.%s.myqcloud.com", t.region)
	}
	u, err := url.Parse(host)
	if err != nil {
		return nil, err
	}
	return cos.NewClient(&cos.BaseURL{ServiceURL: u}, t.authClient()), nil
}

func (t *tencentStore) bucketClient(bucket string) (*cos.Client, error) {
	region := t.regions[bucket]
	if region == "" {
		region = t.region
	}
	if region == "" {
		return nil, fmt.Errorf("unknown region for bucket %q (list buckets first)", bucket)
	}
	u, err := cos.NewBucketURL(bucket, region, t.secure)
	if err != nil {
		return nil, err
	}
	return cos.NewClient(&cos.BaseURL{BucketURL: u}, t.authClient()), nil
}

func (t *tencentStore) ListBuckets(ctx context.Context) ([]Bucket, error) {
	cl, err := t.serviceClient()
	if err != nil {
		return nil, err
	}
	res, _, err := cl.Service.Get(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Bucket, 0, len(res.Buckets))
	for _, b := range res.Buckets {
		t.regions[b.Name] = b.Region
		var ct time.Time
		if b.CreationDate != "" {
			ct, _ = time.Parse(time.RFC3339, b.CreationDate)
		}
		out = append(out, Bucket{Name: b.Name, Region: b.Region, CreationDate: ct})
	}
	return out, nil
}

func (t *tencentStore) ListObjects(ctx context.Context, bucket, prefix, delimiter, token string, maxKeys int) (*ListResult, error) {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return nil, err
	}
	opt := &cos.BucketGetOptions{Prefix: prefix, Delimiter: delimiter, Marker: token}
	if maxKeys > 0 {
		opt.MaxKeys = maxKeys
	}
	res, _, err := cl.Bucket.Get(ctx, opt)
	if err != nil {
		return nil, err
	}
	out := &ListResult{Bucket: bucket, Prefix: prefix, Delimiter: delimiter}
	for _, p := range res.CommonPrefixes {
		out.Entries = append(out.Entries, ObjectEntry{Key: p, Name: baseName(p), IsDir: true})
	}
	for _, o := range res.Contents {
		if o.Key == prefix {
			continue
		}
		var lm time.Time
		if o.LastModified != "" {
			lm, _ = time.Parse(time.RFC3339, o.LastModified)
		}
		out.Entries = append(out.Entries, ObjectEntry{
			Key:          o.Key,
			Name:         baseName(o.Key),
			Size:         o.Size,
			LastModified: lm,
			ETag:         strings.Trim(o.ETag, `"`),
			StorageClass: o.StorageClass,
			IsDir:        strings.HasSuffix(o.Key, "/"),
		})
	}
	out.Truncated = res.IsTruncated
	out.NextToken = res.NextMarker
	return out, nil
}

func (t *tencentStore) HeadObject(ctx context.Context, bucket, key string) (*ObjectMeta, error) {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return nil, err
	}
	resp, err := cl.Object.Head(ctx, key, nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return metaFromHeader(key, resp.Header), nil
}

func (t *tencentStore) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, *ObjectMeta, error) {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return nil, nil, err
	}
	resp, err := cl.Object.Get(ctx, key, nil)
	if err != nil {
		return nil, nil, err
	}
	return resp.Body, metaFromHeader(key, resp.Header), nil
}

func (t *tencentStore) GetObjectRange(ctx context.Context, bucket, key string, start, end int64) (io.ReadCloser, error) {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return nil, err
	}
	resp, err := cl.Object.Get(ctx, key, &cos.ObjectGetOptions{Range: fmt.Sprintf("bytes=%d-%d", start, end)})
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

func (t *tencentStore) PutObject(ctx context.Context, bucket, key string, r io.Reader, size int64, contentType string) error {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return err
	}
	hdr := &cos.ObjectPutHeaderOptions{}
	if contentType != "" {
		hdr.ContentType = contentType
	}
	if size >= 0 {
		hdr.ContentLength = size
	}
	_, err = cl.Object.Put(ctx, key, r, &cos.ObjectPutOptions{ObjectPutHeaderOptions: hdr})
	return err
}

func (t *tencentStore) DeleteObject(ctx context.Context, bucket, key string) error {
	cl, err := t.bucketClient(bucket)
	if err != nil {
		return err
	}
	_, err = cl.Object.Delete(ctx, key)
	return err
}

func (t *tencentStore) CopyObject(ctx context.Context, srcBucket, srcKey, dstBucket, dstKey string) error {
	dstCl, err := t.bucketClient(dstBucket)
	if err != nil {
		return err
	}
	srcRegion := t.regions[srcBucket]
	if srcRegion == "" {
		srcRegion = t.region
	}
	sourceURL := fmt.Sprintf("%s.cos.%s.myqcloud.com/%s", srcBucket, srcRegion, strings.TrimPrefix(srcKey, "/"))
	_, _, err = dstCl.Object.Copy(ctx, dstKey, sourceURL, nil)
	return err
}

func (t *tencentStore) Close() {
	if t.http != nil {
		t.http.CloseIdleConnections()
	}
}
