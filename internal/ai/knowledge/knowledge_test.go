package knowledge

import (
	"strings"
	"testing"
)

// heuristicCount mirrors the chunker's default token estimate so tests don't
// depend on the network-fetched tiktoken vocab.
func heuristicCount(s string) int { return len(s)/4 + 1 }

func TestChunkRespectsBudget(t *testing.T) {
	// Build text well over one chunk.
	para := strings.Repeat("the quick brown fox jumps over the lazy dog. ", 40)
	text := para + "\n\n" + para + "\n\n" + para
	chunks := Chunk(text, 64, 8, heuristicCount)
	if len(chunks) < 2 {
		t.Fatalf("expected multiple chunks, got %d", len(chunks))
	}
	for i, c := range chunks {
		// Allow a small overshoot from the trailing word/segment append.
		if got := heuristicCount(c); got > 64*2 {
			t.Errorf("chunk %d far over budget: %d tokens", i, got)
		}
		if strings.TrimSpace(c) == "" {
			t.Errorf("chunk %d empty", i)
		}
	}
}

func TestChunkEmpty(t *testing.T) {
	if got := Chunk("   \n\n  ", 64, 8, heuristicCount); got != nil {
		t.Errorf("expected nil for blank text, got %v", got)
	}
}

func TestChunkOverlapCarriesContext(t *testing.T) {
	// Distinct sentences so we can detect overlap carry-over.
	text := strings.Repeat("alpha beta gamma delta epsilon zeta eta theta. ", 30)
	chunks := Chunk(text, 48, 16, heuristicCount)
	if len(chunks) < 2 {
		t.Skip("not enough chunks to assert overlap")
	}
	// The tail of chunk[0] should reappear at the head of chunk[1].
	tail := lastWords(chunks[0], 3)
	if tail != "" && !strings.Contains(chunks[1], tail) {
		t.Errorf("expected overlap %q to carry into next chunk", tail)
	}
}

func lastWords(s string, n int) string {
	w := strings.Fields(s)
	if len(w) < n {
		return ""
	}
	return strings.Join(w[len(w)-n:], " ")
}

func TestCosine(t *testing.T) {
	a := []float32{1, 0, 0}
	if got := cosine(a, a); got < 0.999 {
		t.Errorf("identical vectors should be ~1, got %v", got)
	}
	if got := cosine(a, []float32{0, 1, 0}); got > 0.001 || got < -0.001 {
		t.Errorf("orthogonal vectors should be ~0, got %v", got)
	}
	if got := cosine(a, []float32{-1, 0, 0}); got > -0.999 {
		t.Errorf("opposite vectors should be ~-1, got %v", got)
	}
	if got := cosine(a, []float32{1, 0}); got != 0 {
		t.Errorf("mismatched lengths should be 0, got %v", got)
	}
	if got := cosine(nil, nil); got != 0 {
		t.Errorf("empty should be 0, got %v", got)
	}
}

func TestExtractRejectsBinary(t *testing.T) {
	if _, err := Extract("a.pdf", "application/pdf", []byte("%PDF-1.4")); err == nil {
		t.Errorf("expected pdf rejection")
	}
	if _, err := Extract("a.bin", "", []byte{0x00, 0x01, 0x02}); err == nil {
		t.Errorf("expected NUL-byte binary rejection")
	}
	if got, err := Extract("a.md", "text/markdown", []byte("# hi\nworld")); err != nil || got == "" {
		t.Errorf("markdown should extract, got %q err %v", got, err)
	}
}
