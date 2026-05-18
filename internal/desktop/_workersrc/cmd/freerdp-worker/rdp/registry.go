//go:build freerdp

package rdp

import (
	"sync"
	"unsafe"
)

// clientRegistry maps rdpContext* → *Client so the //export'd C
// callbacks can find the Go object that owns the call. cgo strictly
// forbids storing a Go pointer inside the C struct (would break the GC
// invariant), so we keep this lookup table on the Go side instead.
type clientRegistry struct {
	mu sync.RWMutex
	m  map[uintptr]*Client
}

var registry = &clientRegistry{m: make(map[uintptr]*Client)}

func (r *clientRegistry) put(ctx unsafe.Pointer, c *Client) {
	r.mu.Lock()
	r.m[uintptr(ctx)] = c
	r.mu.Unlock()
}

func (r *clientRegistry) get(ctx unsafe.Pointer) *Client {
	r.mu.RLock()
	c := r.m[uintptr(ctx)]
	r.mu.RUnlock()
	return c
}

func (r *clientRegistry) remove(ctx unsafe.Pointer) {
	r.mu.Lock()
	delete(r.m, uintptr(ctx))
	r.mu.Unlock()
}
