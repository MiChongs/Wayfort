package dbcli

import (
	"context"
	"errors"
	"strings"
	"testing"
)

type fakeAssetChecker struct {
	allowed bool
	err     error
	calls   int
}

func (f *fakeAssetChecker) Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error) {
	f.calls++
	return f.allowed, f.err
}

func TestRequireNodeAccessFailsClosedWithoutAssetResolver(t *testing.T) {
	t.Parallel()
	err := (&Handler{}).requireNodeAccess(context.Background(), 1, 2)
	if err == nil || !strings.Contains(err.Error(), "asset resolver not configured") {
		t.Fatalf("requireNodeAccess() error = %v, want asset resolver not configured", err)
	}
}

func TestRequireNodeAccessRejectsDeniedAsset(t *testing.T) {
	t.Parallel()
	checker := &fakeAssetChecker{allowed: false}
	err := (&Handler{Asset: checker}).requireNodeAccess(context.Background(), 1, 2)
	if err == nil || !strings.Contains(err.Error(), "node access denied") {
		t.Fatalf("requireNodeAccess() error = %v, want node access denied", err)
	}
	if checker.calls != 1 {
		t.Fatalf("access checker calls = %d, want 1", checker.calls)
	}
}

func TestRequireNodeAccessAllowsGrantedAsset(t *testing.T) {
	t.Parallel()
	checker := &fakeAssetChecker{allowed: true}
	err := (&Handler{Asset: checker}).requireNodeAccess(context.Background(), 1, 2)
	if err != nil {
		t.Fatalf("requireNodeAccess() error = %v", err)
	}
	if checker.calls != 1 {
		t.Fatalf("access checker calls = %d, want 1", checker.calls)
	}
}

func TestRequireNodeAccessPropagatesCheckerError(t *testing.T) {
	t.Parallel()
	checkerErr := errors.New("resolver failed")
	err := (&Handler{Asset: &fakeAssetChecker{err: checkerErr}}).requireNodeAccess(context.Background(), 1, 2)
	if !errors.Is(err, checkerErr) {
		t.Fatalf("requireNodeAccess() error = %v, want %v", err, checkerErr)
	}
}
