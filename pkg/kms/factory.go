package kms

import (
	"context"
	"encoding/json"
	"fmt"
)

// ProviderRow is the minimal shape the factory needs from a
// kms_providers DB row. We intentionally do not import
// internal/model here to keep pkg/kms importable from anywhere in
// the tree without introducing a circular dep — the wiring code in
// main.go does the projection.
type ProviderRow struct {
	ID             uint64
	Name           string
	Kind           Kind
	Endpoint       string
	KeyID          string
	Namespace      string
	AuthMethod     string
	AuthRoleID     string
	AuthPlaintext  []byte // already unsealed by the caller
	ExtraJSON      string // free-form per-provider knobs
}

// vaultExtras / awsExtras / azureExtras / gcpExtras are the
// per-provider knob shapes the factory deserialises out of
// ProviderRow.ExtraJSON. Empty defaults give a reasonable starting
// configuration for each cloud.
type vaultExtras struct {
	MountPath      string `json:"mount_path,omitempty"`
	TLSSkipVerify  bool   `json:"tls_skip_verify,omitempty"`
	TLSCACertPath  string `json:"tls_ca_cert_path,omitempty"`
	K8sJWTPath     string `json:"k8s_jwt_path,omitempty"`
}

type awsExtras struct {
	EndpointURL string `json:"endpoint_url,omitempty"`
}

type azureExtras struct {
	KeyVersion     string `json:"key_version,omitempty"`
	Algorithm      string `json:"wrap_algorithm,omitempty"`
	TenantID       string `json:"tenant_id,omitempty"`
	ClientID       string `json:"client_id,omitempty"`
}

// New constructs a KMS implementation from a DB row. The caller has
// already unsealed AuthPlaintext via the bootstrap Unsealer; we never
// see the ciphertext form here.
//
// The Endpoint, KeyID, and ExtraJSON fields are interpreted per Kind:
//
//   - vault:  Endpoint = Vault URL, KeyID = transit key name,
//             ExtraJSON = vaultExtras
//   - aws:    Endpoint = AWS region, KeyID = alias/ARN,
//             ExtraJSON = awsExtras
//   - azure:  Endpoint = Key Vault URL, KeyID = key name,
//             ExtraJSON = azureExtras
//   - gcp:    Endpoint = unused, KeyID = full resource path,
//             ExtraJSON = (none)
//   - local:  Endpoint = unused, KeyID = alias (e.g. "primary"),
//             AuthPlaintext = the 32-byte KEK
func New(ctx context.Context, row ProviderRow) (KMS, error) {
	switch row.Kind {
	case KindLocal:
		return NewLocal(row.Name, row.KeyID, row.AuthPlaintext)
	case KindVault:
		var ex vaultExtras
		if row.ExtraJSON != "" {
			_ = json.Unmarshal([]byte(row.ExtraJSON), &ex)
		}
		return NewVault(ctx, VaultConfig{
			Name:          row.Name,
			Endpoint:      row.Endpoint,
			Namespace:     row.Namespace,
			MountPath:     ex.MountPath,
			KeyName:       row.KeyID,
			AuthMethod:    row.AuthMethod,
			AuthRoleID:    row.AuthRoleID,
			AuthSecret:    row.AuthPlaintext,
			TLSSkipVerify: ex.TLSSkipVerify,
			TLSCACertPath: ex.TLSCACertPath,
			K8sJWTPath:    ex.K8sJWTPath,
		})
	case KindAWS:
		var ex awsExtras
		if row.ExtraJSON != "" {
			_ = json.Unmarshal([]byte(row.ExtraJSON), &ex)
		}
		return NewAWS(ctx, AWSConfig{
			Name:        row.Name,
			Region:      row.Endpoint,
			KeyID:       row.KeyID,
			AuthMethod:  row.AuthMethod,
			AuthSecret:  row.AuthPlaintext,
			EndpointURL: ex.EndpointURL,
		})
	case KindAzure:
		var ex azureExtras
		if row.ExtraJSON != "" {
			_ = json.Unmarshal([]byte(row.ExtraJSON), &ex)
		}
		return NewAzure(ctx, AzureConfig{
			Name:       row.Name,
			VaultURL:   row.Endpoint,
			KeyName:    row.KeyID,
			KeyVersion: ex.KeyVersion,
			Algorithm:  ex.Algorithm,
			AuthMethod: row.AuthMethod,
			TenantID:   ex.TenantID,
			ClientID:   ex.ClientID,
			AuthSecret: row.AuthPlaintext,
		})
	case KindGCP:
		return NewGCP(ctx, GCPConfig{
			Name:       row.Name,
			KeyPath:    row.KeyID,
			AuthMethod: row.AuthMethod,
			AuthSecret: row.AuthPlaintext,
		})
	default:
		return nil, fmt.Errorf("%w: %q", ErrUnknownKind, row.Kind)
	}
}
