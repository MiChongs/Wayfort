package webssh

import "time"

// nowFunc is indirected so tests can pin time deterministically.
var nowFunc = time.Now
