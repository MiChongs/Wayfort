//go:build freerdp

package rdp

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/jpeg"
	"runtime"
	"time"

	"github.com/klauspost/compress/zlib"
	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	ants "github.com/panjf2000/ants/v2"
	"go.uber.org/zap"
)

const maxPendingOrderedFrames = 256

func (c *Client) initFrameEncoder() error {
	if c.framePool != nil {
		return nil
	}
	workers := runtime.GOMAXPROCS(0) - 1
	if workers < 1 {
		workers = 1
	}
	if workers > 4 {
		workers = 4
	}
	pool, err := ants.NewPool(workers,
		ants.WithNonblocking(true),
		ants.WithExpiryDuration(10*time.Second),
	)
	if err != nil {
		return err
	}
	c.framePool = pool
	c.frameReady = make(map[uint64]desktop.ServerMessage, workers*2)
	c.frameSkipped = make(map[uint64]struct{}, workers*2)
	c.frameEmitNext = 0
	c.frameSeq.Store(0)
	c.framePoolClosed.Store(false)
	c.logger.Info("desktop frame encoder pool initialized", zap.Int("workers", workers))
	return nil
}

func (c *Client) closeFrameEncoder() {
	c.framePoolClosed.Store(true)
	if c.framePool != nil {
		_ = c.framePool.ReleaseTimeout(2 * time.Second)
		c.framePool = nil
	}
	c.frameEmitMu.Lock()
	c.frameReady = nil
	c.frameSkipped = nil
	c.frameEmitMu.Unlock()
}

func (c *Client) submitFrame(x, y, width, height uint32, rawBGRA []byte) {
	seq := c.frameSeq.Add(1) - 1
	if c.framePool == nil || c.framePoolClosed.Load() || !c.shouldAsyncEncode(rawBGRA, width, height) {
		enc, payload := c.encodeFramePayload(rawBGRA, width, height)
		c.finishFrame(seq, x, y, width, height, enc, payload, len(rawBGRA))
		return
	}
	c.framesEncodeQueued.Add(1)
	err := c.framePool.Submit(func() {
		enc, payload := c.encodeFramePayload(rawBGRA, width, height)
		c.finishFrame(seq, x, y, width, height, enc, payload, len(rawBGRA))
	})
	if err != nil {
		c.framesEncodeFallback.Add(1)
		dropped := c.framesDropped.Add(1)
		c.requestFrameResync()
		c.logEmitDrop(dropped)
		c.skipFrame(seq)
	}
}

func (c *Client) encodeFramePayload(rawBGRA []byte, width, height uint32) (desktop.Encoding, []byte) {
	enc, payload := c.chooseFrameEncoding(rawBGRA, width, height)
	return c.capFramePayload(enc, payload, rawBGRA, width, height)
}

// capFramePayload guarantees the emitted payload (plus the 32-byte binary
// header added downstream) stays under the gateway's frame cap. A huge,
// incompressible raw rect — e.g. a photo-heavy region on a multi-monitor / 8K
// desktop — would otherwise exceed desktop.MaxFrameBytes, trip the gateway's
// readFrame, end the stdout pump, and freeze the session. Force JPEG in that
// case: lossy but renderable and tiny.
func (c *Client) capFramePayload(enc desktop.Encoding, payload, rawBGRA []byte, width, height uint32) (desktop.Encoding, []byte) {
	const slack = 1024 // binary header + framing slack
	if len(payload)+slack <= desktop.MaxFrameBytes {
		return enc, payload
	}
	if rgba, ok := bgraToRGBA(rawBGRA, width, height); ok {
		var out bytes.Buffer
		if err := jpeg.Encode(&out, rgba, &jpeg.Options{Quality: 70}); err == nil &&
			out.Len() > 0 && out.Len()+slack <= desktop.MaxFrameBytes {
			return desktop.EncodingJPEG, out.Bytes()
		}
	}
	// Could not shrink under the cap; return as-is. The worker's writeFrame
	// skips it (logged) rather than desync the protocol — a dropped frame
	// beats a frozen stream.
	c.logger.Warn("frame payload exceeds gateway cap and could not be compressed under it",
		zap.Int("payload_bytes", len(payload)),
		zap.Uint32("width", width), zap.Uint32("height", height))
	return enc, payload
}

func (c *Client) chooseFrameEncoding(rawBGRA []byte, width, height uint32) (desktop.Encoding, []byte) {
	if !c.shouldCompressedEncode(rawBGRA, width, height) {
		return desktop.EncodingRawBGRA, rawBGRA
	}
	zlibPayload, zlibOK := []byte(nil), false
	if c.shouldZlibEncode(rawBGRA, width, height) {
		zlibPayload, zlibOK = compressZlibBGRA(rawBGRA)
	}
	if zlibOK && c.acceptZlib(len(rawBGRA), len(zlibPayload)) {
		return desktop.EncodingZlibBGRA, zlibPayload
	}
	if !c.shouldJPEGEncode(rawBGRA, width, height) {
		if zlibOK && len(zlibPayload) < len(rawBGRA) {
			return desktop.EncodingZlibBGRA, zlibPayload
		}
		return desktop.EncodingRawBGRA, rawBGRA
	}
	rgba, ok := bgraToRGBA(rawBGRA, width, height)
	if !ok {
		if zlibOK && len(zlibPayload) < len(rawBGRA) {
			return desktop.EncodingZlibBGRA, zlibPayload
		}
		return desktop.EncodingRawBGRA, rawBGRA
	}
	var out bytes.Buffer
	if err := jpeg.Encode(&out, rgba, &jpeg.Options{Quality: c.jpegQuality()}); err != nil {
		if zlibOK && len(zlibPayload) < len(rawBGRA) {
			return desktop.EncodingZlibBGRA, zlibPayload
		}
		return desktop.EncodingRawBGRA, rawBGRA
	}
	if out.Len() == 0 || out.Len() >= len(rawBGRA) {
		if zlibOK && len(zlibPayload) < len(rawBGRA) {
			return desktop.EncodingZlibBGRA, zlibPayload
		}
		return desktop.EncodingRawBGRA, rawBGRA
	}
	if zlibOK && len(zlibPayload) < out.Len() && c.preferLosslessOverJPEG(len(rawBGRA), len(zlibPayload), out.Len()) {
		return desktop.EncodingZlibBGRA, zlibPayload
	}
	return desktop.EncodingJPEG, out.Bytes()
}

func (c *Client) finishFrame(seq uint64, x, y, width, height uint32, enc desktop.Encoding, payload []byte, rawBytes int) {
	c.recordFrameEncoding(enc, rawBytes, len(payload))
	if !c.firstFrameLogged.Swap(true) {
		c.logger.Info("phase: first decoded frame from server",
			zap.Uint32("x", x),
			zap.Uint32("y", y),
			zap.Uint32("width", width),
			zap.Uint32("height", height),
			zap.String("encoding", string(enc)),
			zap.Int("payload_bytes", len(payload)),
			zap.Int("raw_bytes", rawBytes))
	}
	c.completeFrame(seq, desktop.ServerMessage{Frame: &desktop.FrameRect{
		X:        x,
		Y:        y,
		Width:    width,
		Height:   height,
		Encoding: enc,
		Payload:  payload,
	}})
}

func (c *Client) completeFrame(seq uint64, msg desktop.ServerMessage) {
	if c.framePoolClosed.Load() {
		return
	}
	ready := make([]desktop.ServerMessage, 0, 1)
	var staleDropped uint64
	var backlogAfter int
	var nextAfter uint64
	c.frameEmitMu.Lock()
	if c.framePoolClosed.Load() || seq < c.frameEmitNext {
		c.frameEmitMu.Unlock()
		return
	}
	if c.frameReady == nil {
		c.frameReady = make(map[uint64]desktop.ServerMessage)
	}
	if c.frameSkipped == nil {
		c.frameSkipped = make(map[uint64]struct{})
	}
	c.frameReady[seq] = msg
	if len(c.frameReady) > maxPendingOrderedFrames {
		keepFrom := seq - maxPendingOrderedFrames + 1
		for c.frameEmitNext < keepFrom {
			delete(c.frameReady, c.frameEmitNext)
			delete(c.frameSkipped, c.frameEmitNext)
			c.frameEmitNext++
			staleDropped++
		}
		backlogAfter = len(c.frameReady)
	}
	for {
		if _, skipped := c.frameSkipped[c.frameEmitNext]; skipped {
			delete(c.frameSkipped, c.frameEmitNext)
			c.frameEmitNext++
			continue
		}
		m, ok := c.frameReady[c.frameEmitNext]
		if !ok {
			break
		}
		delete(c.frameReady, c.frameEmitNext)
		c.frameEmitNext++
		ready = append(ready, m)
	}
	nextAfter = c.frameEmitNext
	c.frameEmitMu.Unlock()
	if staleDropped > 0 {
		c.framesDropped.Add(staleDropped)
		c.requestFrameResync()
		c.logger.Warn("desktop frame encode backlog exceeded; dropped stale ordered frames",
			zap.Uint64("dropped", staleDropped),
			zap.Uint64("next_seq", nextAfter),
			zap.Uint64("completed_seq", seq),
			zap.Int("ready_backlog", backlogAfter))
	}
	if c.framePoolClosed.Load() {
		return
	}
	c.emitFrameMessages(ready)
}

func (c *Client) skipFrame(seq uint64) {
	ready := make([]desktop.ServerMessage, 0, 1)
	c.frameEmitMu.Lock()
	if c.framePoolClosed.Load() || seq < c.frameEmitNext {
		c.frameEmitMu.Unlock()
		return
	}
	if c.frameSkipped == nil {
		c.frameSkipped = make(map[uint64]struct{})
	}
	if c.frameReady == nil {
		c.frameReady = make(map[uint64]desktop.ServerMessage)
	}
	c.frameSkipped[seq] = struct{}{}
	for {
		if _, skipped := c.frameSkipped[c.frameEmitNext]; skipped {
			delete(c.frameSkipped, c.frameEmitNext)
			c.frameEmitNext++
			continue
		}
		m, ok := c.frameReady[c.frameEmitNext]
		if !ok {
			break
		}
		delete(c.frameReady, c.frameEmitNext)
		c.frameEmitNext++
		ready = append(ready, m)
	}
	c.frameEmitMu.Unlock()
	if c.framePoolClosed.Load() {
		return
	}
	c.emitFrameMessages(ready)
}

func (c *Client) emitFrameMessages(messages []desktop.ServerMessage) {
	if len(messages) == 0 {
		return
	}
	if len(messages) == 1 {
		c.emit(messages[0])
		return
	}
	frames := make([]desktop.FrameRect, 0, len(messages))
	for _, msg := range messages {
		if msg.Frame != nil {
			frames = append(frames, *msg.Frame)
		}
	}
	if len(frames) == 0 {
		return
	}
	if len(frames) == 1 {
		c.emit(desktop.ServerMessage{Frame: &frames[0]})
		return
	}
	c.emit(desktop.ServerMessage{FrameBatch: &desktop.FrameBatch{Frames: frames}})
}

func (c *Client) recordFrameEncoding(enc desktop.Encoding, rawBytes, encodedBytes int) {
	switch enc {
	case desktop.EncodingJPEG:
		c.framesEncodedJPEG.Add(1)
	case desktop.EncodingZlibBGRA:
		c.framesEncodedZlib.Add(1)
	default:
		c.framesEncodedRaw.Add(1)
	}
	c.frameEncodeInBytes.Add(uint64(maxInt(rawBytes, 0)))
	c.frameEncodeOutBytes.Add(uint64(maxInt(encodedBytes, 0)))
}

func (c *Client) shouldAsyncEncode(rawBGRA []byte, width, height uint32) bool {
	return c.shouldCompressedEncode(rawBGRA, width, height)
}

func (c *Client) shouldCompressedEncode(rawBGRA []byte, width, height uint32) bool {
	if width == 0 || height == 0 || len(rawBGRA) < int(width)*int(height)*4 {
		return false
	}
	threshold := 192 * 1024
	switch c.params.Quality {
	case desktop.QualityHigh:
		threshold = 512 * 1024
	case desktop.QualityMedium:
		threshold = 256 * 1024
	case desktop.QualityLow:
		threshold = 192 * 1024
	}
	return len(rawBGRA) >= threshold
}

func (c *Client) shouldZlibEncode(rawBGRA []byte, width, height uint32) bool {
	if !c.shouldCompressedEncode(rawBGRA, width, height) {
		return false
	}
	return looksCompressibleBGRA(rawBGRA)
}

func (c *Client) acceptZlib(rawN, zlibN int) bool {
	if zlibN <= 0 || zlibN >= rawN {
		return false
	}
	switch c.params.Quality {
	case desktop.QualityHigh:
		return zlibN*100 <= rawN*92
	case desktop.QualityMedium:
		return zlibN*100 <= rawN*70
	case desktop.QualityLow:
		return zlibN*100 <= rawN*45
	default:
		return zlibN*100 <= rawN*80
	}
}

func (c *Client) preferLosslessOverJPEG(rawN, zlibN, jpegN int) bool {
	if zlibN <= 0 || jpegN <= 0 || zlibN >= rawN {
		return false
	}
	switch c.params.Quality {
	case desktop.QualityHigh:
		return zlibN <= jpegN*2
	case desktop.QualityLow:
		return zlibN < jpegN
	default:
		return zlibN <= jpegN*3/2
	}
}

func (c *Client) shouldJPEGEncode(rawBGRA []byte, width, height uint32) bool {
	if width == 0 || height == 0 || len(rawBGRA) < int(width)*int(height)*4 {
		return false
	}
	if !c.isNearFullDesktopFrame(width, height) {
		return false
	}
	threshold := 384 * 1024
	switch c.params.Quality {
	case desktop.QualityHigh:
		threshold = 768 * 1024
	case desktop.QualityMedium:
		threshold = 256 * 1024
	case desktop.QualityLow:
		threshold = 96 * 1024
	}
	return len(rawBGRA) >= threshold
}

func (c *Client) isNearFullDesktopFrame(width, height uint32) bool {
	if c.width == 0 || c.height == 0 {
		return false
	}
	if width > c.width || height > c.height {
		return false
	}
	if uint64(width)*100 < uint64(c.width)*95 || uint64(height)*100 < uint64(c.height)*95 {
		return false
	}
	return uint64(width)*uint64(height)*100 >= uint64(c.width)*uint64(c.height)*95
}

func compressZlibBGRA(raw []byte) ([]byte, bool) {
	if len(raw) == 0 {
		return nil, false
	}
	var out bytes.Buffer
	out.Grow(len(raw) / 3)
	zw, err := zlib.NewWriterLevel(&out, zlib.BestSpeed)
	if err != nil {
		return nil, false
	}
	if _, err := zw.Write(raw); err != nil {
		_ = zw.Close()
		return nil, false
	}
	if err := zw.Close(); err != nil {
		return nil, false
	}
	return out.Bytes(), true
}

func looksCompressibleBGRA(raw []byte) bool {
	pixels := len(raw) / 4
	if pixels < 64 {
		return false
	}
	samples := 256
	if pixels < samples {
		samples = pixels
	}
	step := pixels / samples
	if step < 1 {
		step = 1
	}
	uniqueLimit := samples * 3 / 4
	unique := make(map[uint32]struct{}, uniqueLimit+1)
	for i := 0; i < samples; i++ {
		off := i * step * 4
		if off+4 > len(raw) {
			break
		}
		unique[binary.LittleEndian.Uint32(raw[off:off+4])] = struct{}{}
		if len(unique) > uniqueLimit {
			return false
		}
	}
	return true
}

func (c *Client) jpegQuality() int {
	switch c.params.Quality {
	case desktop.QualityHigh:
		return 95
	case desktop.QualityMedium:
		return 88
	case desktop.QualityLow:
		return 78
	default:
		return 92
	}
}

func bgraToRGBA(src []byte, width, height uint32) (*image.RGBA, bool) {
	if width == 0 || height == 0 {
		return nil, false
	}
	w := int(width)
	h := int(height)
	need := w * h * 4
	if need <= 0 || len(src) < need {
		return nil, false
	}
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	dst := img.Pix
	for i := 0; i < need; i += 4 {
		dst[i] = src[i+2]
		dst[i+1] = src[i+1]
		dst[i+2] = src[i]
		dst[i+3] = 0xff
	}
	return img, true
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}
