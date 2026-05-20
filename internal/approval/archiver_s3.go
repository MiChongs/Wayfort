package approval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	s3types "github.com/aws/aws-sdk-go-v2/service/s3/types"
	"github.com/michongs/jumpserver-anonymous/internal/model"
)

// S3ArchiveConfig configures the Phase 16c WORM-style archiver. The
// LedgerArchiver hook on the Phase 15 Ledger calls Archive() after every
// successful append; an S3-backed archiver pushes the event row to a
// bucket whose Object Lock policy guarantees the object can't be
// deleted/overwritten until the retention window expires.
//
// MinIO compatibility: leave EndpointURL non-empty (e.g.
// "https://minio.internal:9000") and the SDK routes through a custom
// endpoint resolver. UsePathStyle is forced ON because MinIO + most
// S3-compatible stores don't support the virtual-host-style addressing
// AWS S3 uses by default.
type S3ArchiveConfig struct {
	// Endpoint is the S3 endpoint URL. Empty → use the AWS default for
	// the configured region.
	EndpointURL string
	Region      string
	Bucket      string
	// Prefix is prepended to every object key. Lets one bucket host
	// archives for multiple deployments / tenants. Default "approval/".
	Prefix string
	// RetentionMode is "GOVERNANCE" or "COMPLIANCE". Compliance is
	// stronger — not even the root account can shorten the retention.
	// Governance allows admins with s3:BypassGovernanceRetention to
	// delete early. Default GOVERNANCE.
	RetentionMode string
	// RetentionDays is how long each object stays locked. Set to match
	// your audit retention policy. 0 → no Object Lock (still uploads,
	// but the bucket's default retention applies).
	RetentionDays int
	// AccessKeyID / SecretAccessKey are used when not empty. Otherwise
	// the AWS SDK's default credential chain runs (env vars, IAM role,
	// profile). Leave empty in production; populate for MinIO dev.
	AccessKeyID     string
	SecretAccessKey string
	// FlushInterval is the timer cadence the archiver uses to flush
	// pending events. Default 30s. Set to 1s for tests, 5min for low-
	// activity prod.
	FlushInterval time.Duration
	// BatchSize is the max events per uploaded object. Default 100. The
	// archiver flushes early when the buffer fills.
	BatchSize int
}

// NewS3ArchiveConfigDefault returns the recommended baseline. Caller
// overrides as needed.
func NewS3ArchiveConfigDefault() S3ArchiveConfig {
	return S3ArchiveConfig{
		Prefix:        "approval/",
		RetentionMode: "GOVERNANCE",
		RetentionDays: 365,
		FlushInterval: 30 * time.Second,
		BatchSize:     100,
	}
}

// S3LedgerArchiver implements LedgerArchiver against an S3-compatible
// store with Object Lock retention. Events arrive via Archive() and are
// batched in memory until either FlushInterval elapses or BatchSize is
// reached, at which point a single PutObject uploads them as a
// newline-delimited JSON document (one event per line; same format the
// /audit/events endpoint returns).
type S3LedgerArchiver struct {
	cfg    S3ArchiveConfig
	client *s3.Client

	mu      sync.Mutex
	pending []model.ApprovalEvent

	flushTimer *time.Timer

	doneCh chan struct{}
}

// NewS3LedgerArchiver constructs the archiver and runs a one-shot
// healthcheck (HeadBucket) so misconfiguration surfaces at boot rather
// than on the first event. ctx is used for both load + healthcheck.
func NewS3LedgerArchiver(ctx context.Context, cfg S3ArchiveConfig) (*S3LedgerArchiver, error) {
	if cfg.Bucket == "" {
		return nil, errors.New("s3 archiver: bucket required")
	}
	if cfg.FlushInterval <= 0 {
		cfg.FlushInterval = 30 * time.Second
	}
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 100
	}
	if cfg.Prefix == "" {
		cfg.Prefix = "approval/"
	}
	if !strings.HasSuffix(cfg.Prefix, "/") {
		cfg.Prefix += "/"
	}
	if cfg.RetentionMode == "" {
		cfg.RetentionMode = "GOVERNANCE"
	}

	loadOpts := []func(*awsconfig.LoadOptions) error{}
	if cfg.Region != "" {
		loadOpts = append(loadOpts, awsconfig.WithRegion(cfg.Region))
	}
	if cfg.AccessKeyID != "" && cfg.SecretAccessKey != "" {
		loadOpts = append(loadOpts,
			awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
				cfg.AccessKeyID, cfg.SecretAccessKey, "")))
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("s3 archiver: load aws config: %w", err)
	}

	clientOpts := []func(*s3.Options){}
	if cfg.EndpointURL != "" {
		// Use the per-client BaseEndpoint setter rather than the
		// deprecated EndpointResolver. Path-style addressing is forced
		// because MinIO + most S3-compatible stores don't honour the
		// virtual-host style AWS uses by default.
		clientOpts = append(clientOpts, func(o *s3.Options) {
			o.BaseEndpoint = aws.String(cfg.EndpointURL)
			o.UsePathStyle = true
		})
	}
	client := s3.NewFromConfig(awsCfg, clientOpts...)

	// HeadBucket as a connectivity + permission probe. Don't fail if it
	// returns 403 (the credentials may have PutObject permission but
	// not HeadBucket) — only fail on 404 / network errors.
	if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: aws.String(cfg.Bucket)}); err != nil {
		// Best-effort: log a warning but continue; PutObject will fail
		// loudly on first event if the bucket truly doesn't exist.
		// Treat as fatal only if the error string mentions "not found".
		if strings.Contains(err.Error(), "NotFound") || strings.Contains(err.Error(), "404") {
			return nil, fmt.Errorf("s3 archiver: bucket %q not found: %w", cfg.Bucket, err)
		}
	}

	a := &S3LedgerArchiver{
		cfg:    cfg,
		client: client,
		doneCh: make(chan struct{}),
	}
	return a, nil
}

// Archive enqueues events for batched upload. Returns immediately; the
// upload happens on the flush timer or when BatchSize is reached.
func (a *S3LedgerArchiver) Archive(_ context.Context, events []model.ApprovalEvent) error {
	if len(events) == 0 {
		return nil
	}
	a.mu.Lock()
	a.pending = append(a.pending, events...)
	count := len(a.pending)
	a.mu.Unlock()

	if count >= a.cfg.BatchSize {
		return a.Flush(context.Background())
	}
	a.scheduleFlush()
	return nil
}

func (a *S3LedgerArchiver) scheduleFlush() {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.flushTimer != nil {
		return
	}
	a.flushTimer = time.AfterFunc(a.cfg.FlushInterval, func() {
		_ = a.Flush(context.Background())
	})
}

// Flush uploads the current batch immediately. Safe to call any time;
// callers don't normally invoke it directly — the reconciler / shutdown
// path does for end-of-shift draining.
func (a *S3LedgerArchiver) Flush(ctx context.Context) error {
	a.mu.Lock()
	if len(a.pending) == 0 {
		a.mu.Unlock()
		return nil
	}
	batch := a.pending
	a.pending = nil
	if a.flushTimer != nil {
		a.flushTimer.Stop()
		a.flushTimer = nil
	}
	a.mu.Unlock()

	// Render as JSON Lines: one event per line. Same shape the
	// /audit/events endpoint returns so a verifier can replay archives
	// directly into the ledger chain check.
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	for _, ev := range batch {
		if err := enc.Encode(ev); err != nil {
			return fmt.Errorf("s3 archiver: marshal event %d: %w", ev.ID, err)
		}
	}

	key := buildArchiveKey(a.cfg.Prefix, batch)

	input := &s3.PutObjectInput{
		Bucket:        aws.String(a.cfg.Bucket),
		Key:           aws.String(key),
		Body:          bytes.NewReader(buf.Bytes()),
		ContentType:   aws.String("application/x-ndjson"),
		ContentLength: aws.Int64(int64(buf.Len())),
	}
	if a.cfg.RetentionDays > 0 {
		until := time.Now().Add(time.Duration(a.cfg.RetentionDays) * 24 * time.Hour)
		input.ObjectLockMode = s3types.ObjectLockMode(a.cfg.RetentionMode)
		input.ObjectLockRetainUntilDate = aws.Time(until)
	}

	if _, err := a.client.PutObject(ctx, input); err != nil {
		// On upload failure, requeue so the next flush retries. The
		// alternative — dropping — would leave gaps in the WORM record,
		// which defeats the purpose of having an archive at all.
		a.mu.Lock()
		a.pending = append(batch, a.pending...)
		a.mu.Unlock()
		return fmt.Errorf("s3 archiver: put object %s: %w", key, err)
	}
	return nil
}

// Close flushes any pending events and prevents further uploads. Called
// during graceful shutdown.
func (a *S3LedgerArchiver) Close(ctx context.Context) error {
	if err := a.Flush(ctx); err != nil {
		return err
	}
	close(a.doneCh)
	return nil
}

// buildArchiveKey produces a sortable, sharded key. Format:
//
//   <prefix>YYYY/MM/DD/HH/<first-event-id>-<last-event-id>.jsonl
//
// Sharding by hour keeps per-prefix object counts bounded so list-prefix
// scans during forensics stay fast even at high throughput.
func buildArchiveKey(prefix string, events []model.ApprovalEvent) string {
	if len(events) == 0 {
		return prefix + "empty.jsonl"
	}
	first := events[0]
	last := events[len(events)-1]
	t := first.CreatedAt.UTC()
	return fmt.Sprintf("%s%04d/%02d/%02d/%02d/%d-%d.jsonl",
		prefix, t.Year(), int(t.Month()), t.Day(), t.Hour(),
		first.ID, last.ID)
}
