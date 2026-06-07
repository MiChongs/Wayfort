package oss

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
)

// s3Store is the generic S3 adapter: AWS S3, MinIO, Ceph RGW and any other
// S3-compatible endpoint. Uses aws-sdk-go-v2 (already a project dependency).
type s3Store struct {
	client *s3.Client
	http   *http.Client
}

func newS3Store(opts Options, ak, sk string, httpClient *http.Client) (ObjectStore, error) {
	region := opts.Region
	if region == "" {
		region = "us-east-1"
	}
	cfg := aws.Config{
		Region:      region,
		Credentials: credentials.NewStaticCredentialsProvider(ak, sk, ""),
		HTTPClient:  httpClient,
	}
	client := s3.NewFromConfig(cfg, func(o *s3.Options) {
		if ep := ensureScheme(opts.Endpoint); ep != "" {
			o.BaseEndpoint = aws.String(ep)
		}
		o.UsePathStyle = opts.PathStyle
	})
	return &s3Store{client: client, http: httpClient}, nil
}

func (s *s3Store) Provider() string { return ProviderS3 }

func (s *s3Store) ListBuckets(ctx context.Context) ([]Bucket, error) {
	out, err := s.client.ListBuckets(ctx, &s3.ListBucketsInput{})
	if err != nil {
		return nil, err
	}
	res := make([]Bucket, 0, len(out.Buckets))
	for _, b := range out.Buckets {
		bk := Bucket{Name: aws.ToString(b.Name)}
		if b.CreationDate != nil {
			bk.CreationDate = *b.CreationDate
		}
		res = append(res, bk)
	}
	return res, nil
}

func (s *s3Store) ListObjects(ctx context.Context, bucket, prefix, delimiter, token string, maxKeys int) (*ListResult, error) {
	in := &s3.ListObjectsV2Input{Bucket: aws.String(bucket)}
	if prefix != "" {
		in.Prefix = aws.String(prefix)
	}
	if delimiter != "" {
		in.Delimiter = aws.String(delimiter)
	}
	if token != "" {
		in.ContinuationToken = aws.String(token)
	}
	if maxKeys > 0 {
		in.MaxKeys = aws.Int32(int32(maxKeys))
	}
	out, err := s.client.ListObjectsV2(ctx, in)
	if err != nil {
		return nil, err
	}
	res := &ListResult{Bucket: bucket, Prefix: prefix, Delimiter: delimiter}
	for _, cp := range out.CommonPrefixes {
		p := aws.ToString(cp.Prefix)
		if p == "" {
			continue
		}
		res.Entries = append(res.Entries, ObjectEntry{Key: p, Name: baseName(p), IsDir: true})
	}
	for _, o := range out.Contents {
		key := aws.ToString(o.Key)
		if key == "" || key == prefix {
			continue
		}
		e := ObjectEntry{
			Key:          key,
			Name:         baseName(key),
			Size:         aws.ToInt64(o.Size),
			ETag:         strings.Trim(aws.ToString(o.ETag), `"`),
			StorageClass: string(o.StorageClass),
			IsDir:        strings.HasSuffix(key, "/"),
		}
		if o.LastModified != nil {
			e.LastModified = *o.LastModified
		}
		res.Entries = append(res.Entries, e)
	}
	res.Truncated = aws.ToBool(out.IsTruncated)
	res.NextToken = aws.ToString(out.NextContinuationToken)
	return res, nil
}

func (s *s3Store) HeadObject(ctx context.Context, bucket, key string) (*ObjectMeta, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return nil, err
	}
	m := &ObjectMeta{
		Key:          key,
		Size:         aws.ToInt64(out.ContentLength),
		ContentType:  aws.ToString(out.ContentType),
		ETag:         strings.Trim(aws.ToString(out.ETag), `"`),
		StorageClass: string(out.StorageClass),
	}
	if out.LastModified != nil {
		m.LastModified = *out.LastModified
	}
	return m, nil
}

func (s *s3Store) GetObject(ctx context.Context, bucket, key string) (io.ReadCloser, *ObjectMeta, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	if err != nil {
		return nil, nil, err
	}
	m := &ObjectMeta{
		Key:         key,
		Size:        aws.ToInt64(out.ContentLength),
		ContentType: aws.ToString(out.ContentType),
		ETag:        strings.Trim(aws.ToString(out.ETag), `"`),
	}
	if out.LastModified != nil {
		m.LastModified = *out.LastModified
	}
	return out.Body, m, nil
}

func (s *s3Store) GetObjectRange(ctx context.Context, bucket, key string, start, end int64) (io.ReadCloser, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(bucket),
		Key:    aws.String(key),
		Range:  aws.String(fmt.Sprintf("bytes=%d-%d", start, end)),
	})
	if err != nil {
		return nil, err
	}
	return out.Body, nil
}

func (s *s3Store) PutObject(ctx context.Context, bucket, key string, r io.Reader, size int64, contentType string) error {
	in := &s3.PutObjectInput{Bucket: aws.String(bucket), Key: aws.String(key), Body: r}
	if size >= 0 {
		in.ContentLength = aws.Int64(size)
	}
	if contentType != "" {
		in.ContentType = aws.String(contentType)
	}
	_, err := s.client.PutObject(ctx, in)
	return err
}

func (s *s3Store) DeleteObject(ctx context.Context, bucket, key string) error {
	_, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(bucket), Key: aws.String(key)})
	return err
}

func (s *s3Store) CopyObject(ctx context.Context, srcBucket, srcKey, dstBucket, dstKey string) error {
	_, err := s.client.CopyObject(ctx, &s3.CopyObjectInput{
		Bucket:     aws.String(dstBucket),
		Key:        aws.String(dstKey),
		CopySource: aws.String(encodeCopySource(srcBucket, srcKey)),
	})
	return err
}

func (s *s3Store) Close() {
	if s.http != nil {
		s.http.CloseIdleConnections()
	}
}

// encodeCopySource builds the URL-encoded "bucket/key" CopySource S3 expects,
// preserving slashes while escaping spaces and other special characters.
func encodeCopySource(bucket, key string) string {
	u := &url.URL{Path: "/" + bucket + "/" + key}
	return strings.TrimPrefix(u.EscapedPath(), "/")
}
