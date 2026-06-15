//go:build freerdp

// jpeg_turbo.go — SIMD JPEG encoding for the bitmap rect path via libjpeg-turbo
// (TurboJPEG API).
//
// Why this replaces Go's image/jpeg for the hot path:
//   - It consumes the wire's BGRA pixels directly (TJPF_BGRA), killing the
//     per-pixel BGRA→RGBA swap + 8 MB image.RGBA allocation per 1080p frame
//     that the stdlib path needs.
//   - SIMD (AVX2/NEON) huffman + DCT make it typically 3-6x faster than the
//     pure-Go encoder at the same quality.
//   - The stdlib encoder is hardwired to 4:2:0 chroma subsampling, which
//     smears colored text and thin UI accents — exactly what a remote desktop
//     is made of. TurboJPEG lets High/Medium quality tiers keep full 4:4:4
//     chroma so colored glyph edges stay crisp.
//
// libjpeg-turbo is BSD/IJG-licensed and packaged everywhere the worker builds
// (MSYS2: mingw-w64-*-libjpeg-turbo; apt: libturbojpeg0-dev; brew: jpeg-turbo).
// We use the classic TurboJPEG 2.x API (tjCompress2), which libjpeg-turbo 3.x
// still exports, so any system version >= 2.0 works.
//
// Every entry point degrades gracefully: on init or compress failure the
// caller (frame_encode.go encodeJPEGBGRA) falls back to the stdlib encoder, so
// a broken/missing libturbojpeg can never take frames down with it.

package rdp

/*
#cgo pkg-config: libturbojpeg

#include <stdlib.h>
#include <turbojpeg.h>
*/
import "C"

import (
	"runtime"
	"sync"
	"sync/atomic"
	"unsafe"
)

// tjCompressor pairs one TurboJPEG compressor handle with a reusable output
// scratch buffer. TurboJPEG handles are not safe for concurrent use, so
// instances are pooled — the frame-encode pool runs up to 4 workers.
type tjCompressor struct {
	h       C.tjhandle
	scratch []byte
}

func newTJCompressor() *tjCompressor {
	h := C.tjInitCompress()
	if h == nil {
		return nil
	}
	c := &tjCompressor{h: h}
	// sync.Pool drops entries on GC pressure without notice; the finalizer
	// keeps those drops from leaking the C-side handle state.
	runtime.SetFinalizer(c, func(tc *tjCompressor) {
		if tc.h != nil {
			C.tjDestroy(tc.h)
			tc.h = nil
		}
	})
	return c
}

var tjPool = sync.Pool{New: func() any { return newTJCompressor() }}

// jpegTurboFailed flips to true after an init failure so a host without a
// usable libturbojpeg probes once instead of on every frame.
var jpegTurboFailed atomic.Bool

// jpegTurboAvailable reports whether a TurboJPEG compressor can be created on
// this host (used for the one-time encoder-path log line).
func jpegTurboAvailable() bool {
	if jpegTurboFailed.Load() {
		return false
	}
	comp, _ := tjPool.Get().(*tjCompressor)
	if comp == nil || comp.h == nil {
		jpegTurboFailed.Store(true)
		return false
	}
	tjPool.Put(comp)
	return true
}

// encodeJPEGTurboBGRA compresses a tightly-packed BGRA rect (stride ==
// width*4) straight to JPEG. chroma444 keeps full chroma resolution (crisp
// colored text); false selects 4:2:0 (smallest, matches the old stdlib
// behaviour). Returns (nil, false) on any failure so the caller can fall back
// to the stdlib encoder.
func encodeJPEGTurboBGRA(raw []byte, width, height uint32, quality int, chroma444 bool) ([]byte, bool) {
	if jpegTurboFailed.Load() || width == 0 || height == 0 {
		return nil, false
	}
	w, h := int(width), int(height)
	if w <= 0 || h <= 0 || len(raw) < w*h*4 {
		return nil, false
	}
	if quality < 1 {
		quality = 1
	} else if quality > 100 {
		quality = 100
	}
	comp, _ := tjPool.Get().(*tjCompressor)
	if comp == nil || comp.h == nil {
		jpegTurboFailed.Store(true)
		return nil, false
	}
	defer tjPool.Put(comp)

	subsamp := C.int(C.TJSAMP_420)
	if chroma444 {
		subsamp = C.int(C.TJSAMP_444)
	}
	bound := int(C.tjBufSize(C.int(w), C.int(h), subsamp))
	if bound <= 0 {
		return nil, false
	}
	if cap(comp.scratch) < bound {
		comp.scratch = make([]byte, bound)
	}
	buf := comp.scratch[:cap(comp.scratch)]

	// TJFLAG_NOREALLOC: compress into our Go-owned scratch (no C allocs to
	// free). The fast DCT's accuracy loss is only measurable at quality >= ~95,
	// so the High tier keeps the accurate path.
	flags := C.int(C.TJFLAG_NOREALLOC)
	if quality < 95 {
		flags |= C.int(C.TJFLAG_FASTDCT)
	}
	outPtr := (*C.uchar)(unsafe.Pointer(&buf[0]))
	outSize := C.ulong(len(buf))
	rc := C.tjCompress2(comp.h,
		(*C.uchar)(unsafe.Pointer(&raw[0])), C.int(w), C.int(w*4), C.int(h), C.int(C.TJPF_BGRA),
		&outPtr, &outSize, subsamp, C.int(quality), flags)
	if rc != 0 || outSize == 0 || int(outSize) > len(buf) {
		return nil, false
	}
	// Compact copy: the scratch keeps its full capacity in the pool; the
	// returned payload must not pin a multi-MB backing array while it waits in
	// the ordered-emit queue.
	out := make([]byte, int(outSize))
	copy(out, buf[:int(outSize)])
	return out, true
}
