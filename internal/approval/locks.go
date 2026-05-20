package approval

import "sync"

// lockRequest serialises ledger appends per request_id. Releasing the lock
// is via the returned closure (defer it immediately). The package-level map
// is intentionally a single sharded mutex set keyed by request_id — the
// memory overhead per outstanding request is one *sync.Mutex.
//
// Different request_ids never block one another. Same request_id sees serial
// chain construction so two competing reads of LastEvent followed by Insert
// can't both link to the same parent and break monotonicity.
var (
	requestLocksMu sync.Mutex
	requestLocks   = map[string]*requestLock{}
)

type requestLock struct {
	mu  sync.Mutex
	ref int
}

func lockRequest(id string) func() {
	requestLocksMu.Lock()
	rl, ok := requestLocks[id]
	if !ok {
		rl = &requestLock{}
		requestLocks[id] = rl
	}
	rl.ref++
	requestLocksMu.Unlock()
	rl.mu.Lock()
	return func() {
		rl.mu.Unlock()
		requestLocksMu.Lock()
		rl.ref--
		if rl.ref == 0 {
			delete(requestLocks, id)
		}
		requestLocksMu.Unlock()
	}
}
