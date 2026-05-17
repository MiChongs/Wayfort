package audit

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/michongs/jumpserver-anonymous/internal/config"
	"go.uber.org/zap"
)

func TestRecorderWritesAsciinemaHeader(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRecorder("t-header", dir, config.RecorderConfig{}, 80, 24, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	defer r.Close()
	f, err := os.Open(r.Path())
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	if !sc.Scan() {
		t.Fatal("no header line")
	}
	var hdr map[string]any
	if err := json.Unmarshal(sc.Bytes(), &hdr); err != nil {
		t.Fatalf("bad header: %v", err)
	}
	if hdr["version"].(float64) != 2 {
		t.Fatalf("want version 2 got %v", hdr["version"])
	}
}

func TestRecorderRoundtripOutput(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRecorder("t-out", dir, config.RecorderConfig{ChanSize: 16, FlushInterval: 20 * time.Millisecond}, 80, 24, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		_ = r.Run(ctx)
		close(done)
	}()

	r.WriteOutput([]byte("hello"))
	r.WriteOutput([]byte(" world"))
	r.Resize(100, 30)
	time.Sleep(80 * time.Millisecond)
	r.Close()
	cancel()
	<-done

	body, _ := os.ReadFile(r.Path())
	if !strings.Contains(string(body), `"o","hello"`) {
		t.Fatalf("missing hello frame: %s", body)
	}
	if !strings.Contains(string(body), `"r","100x30"`) {
		t.Fatalf("missing resize frame: %s", body)
	}
}

func TestRecorderDropsOnBackpressure(t *testing.T) {
	dir := t.TempDir()
	r, err := NewRecorder("t-drop", dir, config.RecorderConfig{ChanSize: 4, FlushInterval: 50 * time.Millisecond}, 80, 24, zap.NewNop())
	if err != nil {
		t.Fatal(err)
	}
	// Don't start Run() yet: the chan will fill and writes after capacity drop.
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			r.WriteOutput([]byte("x"))
		}
	}()
	wg.Wait()
	if r.dropped.Load() == 0 {
		t.Fatal("expected dropped frames")
	}
	// Now run briefly so the marker is written.
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { _ = r.Run(ctx); close(done) }()
	time.Sleep(120 * time.Millisecond)
	r.Close()
	cancel()
	<-done
	body, _ := os.ReadFile(filepath.Join(r.Path()))
	if !strings.Contains(string(body), `"m","lossy:`) {
		t.Fatalf("missing lossy marker in cast file: %s", body)
	}
}
