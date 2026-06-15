package audit

import (
	"context"
	"testing"

	"github.com/michongs/jumpserver-anonymous/internal/model"
)

type fakeCkptStore struct {
	tail  string
	count int64
	saved map[string]*model.AuditCheckpoint // key: chain|day
}

func newFakeCkptStore(tail string, count int64) *fakeCkptStore {
	return &fakeCkptStore{tail: tail, count: count, saved: map[string]*model.AuditCheckpoint{}}
}

func (f *fakeCkptStore) ChainTailAndCount(context.Context, string) (string, int64, error) {
	return f.tail, f.count, nil
}
func (f *fakeCkptStore) UpsertCheckpoint(_ context.Context, cp *model.AuditCheckpoint) error {
	f.saved[cp.ChainID+"|"+cp.Day] = cp
	return nil
}

func TestCheckpointer_GenesisAndDaily(t *testing.T) {
	store := newFakeCkptStore("tailhash", 42)
	signed := []byte("sig")
	signer := func(context.Context, []byte) ([]byte, uint64, error) { return signed, 7, nil }
	cp := NewCheckpointer("inst-1", store, signer, func() uint64 { return 3 })

	if err := cp.WriteGenesis(context.Background()); err != nil {
		t.Fatalf("genesis: %v", err)
	}
	g := store.saved["inst-1|"+GenesisDay]
	if g == nil || !g.IsGenesis || g.Day != GenesisDay {
		t.Fatalf("genesis checkpoint not written correctly: %+v", g)
	}
	if g.TailHash != "tailhash" || g.EntryCount != 42 || g.DroppedCount != 3 {
		t.Fatalf("genesis did not seal chain state: %+v", g)
	}
	if len(g.Signature) == 0 || g.SignerProviderID != 7 {
		t.Fatalf("genesis must be signed: %+v", g)
	}

	if err := cp.WriteDaily(context.Background()); err != nil {
		t.Fatalf("daily: %v", err)
	}
	// A daily checkpoint exists for some non-genesis day.
	var daily *model.AuditCheckpoint
	for k, v := range store.saved {
		if k != "inst-1|"+GenesisDay {
			daily = v
		}
	}
	if daily == nil || daily.IsGenesis {
		t.Fatalf("daily checkpoint missing or wrongly marked genesis: %+v", daily)
	}
}

func TestCheckpointer_UnsignedWhenNoSigner(t *testing.T) {
	store := newFakeCkptStore("h", 1)
	cp := NewCheckpointer("inst", store, nil, nil)
	if err := cp.WriteGenesis(context.Background()); err != nil {
		t.Fatalf("genesis: %v", err)
	}
	g := store.saved["inst|"+GenesisDay]
	if g == nil || len(g.Signature) != 0 {
		t.Fatalf("checkpoint must be unsigned with no signer: %+v", g)
	}
}

func TestCheckpointDigest_Stable(t *testing.T) {
	cp := &model.AuditCheckpoint{ChainID: "c", Day: "2026-01-01", TailHash: "t", EntryCount: 5, DroppedCount: 2}
	a := CheckpointDigest(cp)
	b := CheckpointDigest(cp)
	if string(a) != string(b) {
		t.Fatal("digest must be deterministic")
	}
	cp2 := *cp
	cp2.TailHash = "other"
	if string(CheckpointDigest(&cp2)) == string(a) {
		t.Fatal("a different tail must change the digest")
	}
}

func TestCheckpointer_SignerFailureFallsBackUnsigned(t *testing.T) {
	store := newFakeCkptStore("h", 1)
	// A signer that errors (e.g. ErrSignNotSupported) must not block the write.
	failing := func(context.Context, []byte) ([]byte, uint64, error) {
		return nil, 0, context.DeadlineExceeded
	}
	cp := NewCheckpointer("inst", store, failing, nil)
	if err := cp.WriteDaily(context.Background()); err != nil {
		t.Fatalf("daily write must succeed even when signing fails: %v", err)
	}
}
