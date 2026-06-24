package dbstudio

import "testing"

func TestNewServiceWithNilDeps(t *testing.T) {
	// All deps nil → service still constructs; calls return ErrUnavailable.
	s := NewService(nil, nil, nil)
	if s == nil {
		t.Fatal("NewService returned nil")
	}
	if _, err := s.SavedQueries().List(nil, 1); err != ErrUnavailable {
		t.Fatalf("expected ErrUnavailable, got %v", err)
	}
}
