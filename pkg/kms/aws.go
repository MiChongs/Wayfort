package kms

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/kms"
)

// AWS is a KMS provider backed by AWS KMS.
//
// Notes
// -----
//   - AWS KMS is not a "rewrap"-friendly model — keys rotate by AWS
//     promoting a new backing key automatically when the CMK has
//     rotation enabled. To rewrap an envelope under the latest backing
//     key, we issue a ReEncrypt call (Decrypt + Encrypt round-trip
//     entirely server-side, plaintext never crosses the wire).
//   - KeyVersion on the envelope is always 1; AWS doesn't expose the
//     backing-key version to clients. The audit table still gets a
//     useful "CMK rotation observed" signal via a healthcheck job.
//   - Encryption context maps directly to AWS's EncryptionContext —
//     same key=value semantics, native AAD support. We use it to bind
//     ciphertexts to their (owner_type, owner_id) tuple.
//   - For the "auth_method=default" path the AWS SDK's own credential
//     chain runs (IMDS, EC2 instance profile, IRSA, ~/.aws/credentials,
//     AWS_ACCESS_KEY_ID env vars). We document but discourage env-var
//     auth — the Phase 14 brief calls it out as a no-go for the master
//     key, but AWS SDK's chain reading env vars to find the IAM
//     identity itself is a different concern (no secret material in our
//     env). For strict installations operators set auth_method=static
//     and stash credentials in AuthCiphertext.
type AWS struct {
	name   string
	keyID  string
	client *kms.Client
	region string
}

// AWSConfig is what the factory hands NewAWS.
type AWSConfig struct {
	Name string
	// Region is the AWS region, e.g. "us-east-1".
	Region string
	// KeyID is either the alias ("alias/jumpserver-creds") or the
	// full CMK ARN. AWS resolves both forms.
	KeyID string
	// AuthMethod selects the credential chain:
	//   - "default" → SDK default chain (IMDS, IRSA, ~/.aws/credentials)
	//   - "static"  → use the unsealed access_key + secret_key from AuthSecret
	AuthMethod string
	// AuthSecret carries the static credentials when AuthMethod=static.
	// Format: JSON {"access_key_id":"...","secret_access_key":"...","session_token":"..."}
	AuthSecret []byte
	// EndpointURL overrides the default KMS endpoint (useful for
	// LocalStack / VPC endpoints). Empty = default.
	EndpointURL string
}

// NewAWS constructs an AWS KMS provider.
func NewAWS(ctx context.Context, cfg AWSConfig) (*AWS, error) {
	if cfg.KeyID == "" {
		return nil, errors.New("kms aws: key_id required")
	}
	if cfg.Region == "" {
		return nil, errors.New("kms aws: region required")
	}

	var loadOpts []func(*awsconfig.LoadOptions) error
	loadOpts = append(loadOpts, awsconfig.WithRegion(cfg.Region))
	switch cfg.AuthMethod {
	case "static":
		if len(cfg.AuthSecret) == 0 {
			return nil, ErrAuthMissing
		}
		var static struct {
			AccessKeyID     string `json:"access_key_id"`
			SecretAccessKey string `json:"secret_access_key"`
			SessionToken    string `json:"session_token"`
		}
		if err := json.Unmarshal(cfg.AuthSecret, &static); err != nil {
			return nil, fmt.Errorf("kms aws: parse static auth: %w", err)
		}
		loadOpts = append(loadOpts, awsconfig.WithCredentialsProvider(
			credentials.NewStaticCredentialsProvider(static.AccessKeyID, static.SecretAccessKey, static.SessionToken),
		))
	case "default", "":
		// Rely on SDK default chain.
	default:
		return nil, fmt.Errorf("kms aws: unsupported auth_method %q", cfg.AuthMethod)
	}

	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, loadOpts...)
	if err != nil {
		return nil, fmt.Errorf("kms aws: load config: %w", err)
	}

	var clientOpts []func(*kms.Options)
	if cfg.EndpointURL != "" {
		ep := cfg.EndpointURL
		clientOpts = append(clientOpts, func(o *kms.Options) {
			o.BaseEndpoint = aws.String(ep)
		})
	}
	cli := kms.NewFromConfig(awsCfg, clientOpts...)

	return &AWS{
		name:   cfg.Name,
		keyID:  cfg.KeyID,
		client: cli,
		region: cfg.Region,
	}, nil
}

// Kind reports KindAWS.
func (a *AWS) Kind() Kind { return KindAWS }

// Name returns the kms_providers.Name value.
func (a *AWS) Name() string { return a.name }

// EncryptDEK calls KMS Encrypt with the supplied DEK + encryption
// context. The CiphertextBlob from AWS is preserved verbatim.
func (a *AWS) EncryptDEK(ctx context.Context, plaintextDEK []byte, encryptionContext map[string]string) (*WrappedDEK, error) {
	out, err := a.client.Encrypt(ctx, &kms.EncryptInput{
		KeyId:             aws.String(a.keyID),
		Plaintext:         plaintextDEK,
		EncryptionContext: encryptionContext,
	})
	if err != nil {
		return nil, WrapError(KindAWS, "encrypt", err)
	}
	if out == nil || len(out.CiphertextBlob) == 0 {
		return nil, errors.New("kms aws: empty ciphertext")
	}
	return &WrappedDEK{
		Ciphertext: append([]byte(nil), out.CiphertextBlob...),
		KeyID:      a.keyID,
		KeyVersion: 1,
	}, nil
}

// DecryptDEK calls KMS Decrypt. KeyId on the request is informational
// for KMS — it'll fail if the ciphertext was wrapped by a different
// key — but we still pin it so the audit trail records the correct
// CMK.
func (a *AWS) DecryptDEK(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) ([]byte, error) {
	out, err := a.client.Decrypt(ctx, &kms.DecryptInput{
		CiphertextBlob:    ciphertext,
		KeyId:             aws.String(keyID),
		EncryptionContext: encryptionContext,
	})
	if err != nil {
		return nil, WrapError(KindAWS, "decrypt", err)
	}
	if out == nil || len(out.Plaintext) == 0 {
		return nil, errors.New("kms aws: empty plaintext")
	}
	return append([]byte(nil), out.Plaintext...), nil
}

// Rewrap maps to KMS ReEncrypt — server-side decrypt + encrypt under
// the (possibly newer) version of the same CMK. Plaintext never leaves
// AWS.
func (a *AWS) Rewrap(ctx context.Context, ciphertext []byte, keyID string, keyVersion int, encryptionContext map[string]string) (*WrappedDEK, error) {
	out, err := a.client.ReEncrypt(ctx, &kms.ReEncryptInput{
		CiphertextBlob:               ciphertext,
		SourceKeyId:                  aws.String(keyID),
		DestinationKeyId:             aws.String(a.keyID),
		SourceEncryptionContext:      encryptionContext,
		DestinationEncryptionContext: encryptionContext,
	})
	if err != nil {
		return nil, WrapError(KindAWS, "rewrap", err)
	}
	if out == nil || len(out.CiphertextBlob) == 0 {
		return nil, errors.New("kms aws: empty rewrap ciphertext")
	}
	return &WrappedDEK{
		Ciphertext: append([]byte(nil), out.CiphertextBlob...),
		KeyID:      a.keyID,
		KeyVersion: 1,
	}, nil
}

// Healthcheck round-trips a 32-byte probe.
func (a *AWS) Healthcheck(ctx context.Context) error {
	probe := make([]byte, 32)
	for i := range probe {
		probe[i] = byte(i)
	}
	wrapped, err := a.EncryptDEK(ctx, probe, nil)
	if err != nil {
		return err
	}
	got, err := a.DecryptDEK(ctx, wrapped.Ciphertext, wrapped.KeyID, wrapped.KeyVersion, nil)
	if err != nil {
		return err
	}
	if !bytes.Equal(got, probe) {
		return errors.New("kms aws: healthcheck round-trip mismatch")
	}
	return nil
}
