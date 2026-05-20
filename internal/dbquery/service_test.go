package dbquery

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeAccessChecker struct {
	allowed bool
	err     error
	calls   int
}

func (f *fakeAccessChecker) Check(ctx context.Context, userID, nodeID uint64, action string) (bool, error) {
	f.calls++
	return f.allowed, f.err
}

func TestGetOrOpenRequiresAccessBeforePoolReuse(t *testing.T) {
	t.Parallel()
	checker := &fakeAccessChecker{allowed: false}
	svc := &Service{
		access: checker,
		pools: map[string]*pool{
			poolKey(10, 20, ""): {lastUsedAt: time.Now()},
		},
	}

	pl, err := svc.getOrOpen(context.Background(), 10, 20, "")
	if err == nil || !strings.Contains(err.Error(), "node access denied") {
		t.Fatalf("getOrOpen() error = %v, want node access denied", err)
	}
	if pl != nil {
		t.Fatalf("getOrOpen() returned pool despite denied access")
	}
	if checker.calls != 1 {
		t.Fatalf("access checker calls = %d, want 1", checker.calls)
	}
}

func TestGetOrOpenFailsClosedWithoutAccessChecker(t *testing.T) {
	t.Parallel()
	svc := &Service{pools: map[string]*pool{poolKey(10, 20, ""): {lastUsedAt: time.Now()}}}

	_, err := svc.getOrOpen(context.Background(), 10, 20, "")
	if err == nil || !strings.Contains(err.Error(), "asset resolver not configured") {
		t.Fatalf("getOrOpen() error = %v, want asset resolver not configured", err)
	}
}

func TestGetOrOpenReturnsCachedPoolAfterAccessAllowed(t *testing.T) {
	t.Parallel()
	checker := &fakeAccessChecker{allowed: true}
	want := &pool{lastUsedAt: time.Now().Add(-time.Minute)}
	svc := &Service{
		access: checker,
		pools:  map[string]*pool{poolKey(10, 20, "app"): want},
	}

	got, err := svc.getOrOpen(context.Background(), 10, 20, "app")
	if err != nil {
		t.Fatalf("getOrOpen() error = %v", err)
	}
	if got != want {
		t.Fatalf("getOrOpen() returned unexpected pool")
	}
	if checker.calls != 1 {
		t.Fatalf("access checker calls = %d, want 1", checker.calls)
	}
}

func TestRequireNodeAccessPropagatesCheckerError(t *testing.T) {
	t.Parallel()
	checkerErr := errors.New("cache unavailable")
	svc := &Service{access: &fakeAccessChecker{err: checkerErr}}

	err := svc.requireNodeAccess(context.Background(), 20, 10)
	if !errors.Is(err, checkerErr) {
		t.Fatalf("requireNodeAccess() error = %v, want %v", err, checkerErr)
	}
}
