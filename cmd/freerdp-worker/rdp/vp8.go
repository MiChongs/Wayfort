//go:build freerdp

// vp8.go — realtime VP8 / VP9 video encoder (libvpx) for the WebRTC video path.
//
// The WebRTC pipeline streams the desktop as a single video track instead of
// WebSocket dirty-bitmap frames + JS decode: FreeRDP composites every codec
// (rdpgfx H264, clearcodec, planar, bitmap) into its GDI primary_buffer, we
// convert that BGRA framebuffer to I420 with FreeRDP's SIMD primitive, encode it
// in realtime, and hand the access unit to the gateway, which feeds it to a Pion
// WebRTC track. The browser then decodes with the hardware <video> pipeline —
// no JS decode, no per-region blits.
//
// Two codecs, chosen per-session by the gateway (StartParams.VideoMode):
//   - VP9 (default) runs in screen-content mode (VP9E_CONTENT_SCREEN) — palette
//     and intra-block-copy coding purpose-built for desktop UI/text, markedly
//     sharper than VP8 at the same bitrate. Used when the browser advertises VP9
//     decode.
//   - VP8 is the universal fallback (WebRTC mandatory-to-implement; every
//     browser decodes it).
// libvpx is BSD-licensed and packaged in MSYS2 (avoids x264's GPL). The encoder
// is isolated behind videoEncoder so an H264 (Media Foundation / NVENC) backend
// can drop in later.

package rdp

/*
#cgo pkg-config: vpx freerdp3 winpr3

#include <stdlib.h>
#include <string.h>
#include <vpx/vpx_encoder.h>
#include <vpx/vp8cx.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/primitives.h>
#include <freerdp/codec/color.h>

typedef struct {
    vpx_codec_ctx_t     codec;
    vpx_codec_enc_cfg_t cfg;     // kept so the bitrate can be retuned at runtime
    vpx_image_t         img;
    int                 w;
    int                 h;
    int                 ready;
    int                 isVP9;
    vpx_codec_pts_t     pts;
    primitives_t*       prims;
} wVPXEnc;

// wVPXNew creates a realtime VP8 (codecId 0) or VP9 (codecId 1) encoder for a
// w x h surface at the given target bitrate (kbps) and frame rate. VP9 is tuned
// for screen content — palette / intra-block-copy coding that keeps desktop
// text and UI crisp at a fraction of VP8's bitrate, which is exactly what a
// remote desktop needs. threads and tileColsLog2 are sized by the Go caller
// from the host core count and surface width. Returns NULL on failure.
static wVPXEnc* wVPXNew(int codecId, int w, int h, int bitrateKbps, int fps,
                        int threads, int tileColsLog2) {
    if (w <= 0 || h <= 0 || (w & 1) || (h & 1)) {
        // VP8/VP9 I420 needs even dimensions.
        return NULL;
    }
    wVPXEnc* e = (wVPXEnc*)calloc(1, sizeof(wVPXEnc));
    if (!e) return NULL;
    e->w = w;
    e->h = h;
    e->isVP9 = (codecId == 1) ? 1 : 0;
    e->prims = primitives_get();

    vpx_codec_iface_t* iface = e->isVP9 ? vpx_codec_vp9_cx() : vpx_codec_vp8_cx();

    vpx_codec_enc_cfg_t* cfg = &e->cfg;
    if (vpx_codec_enc_config_default(iface, cfg, 0) != VPX_CODEC_OK) {
        free(e);
        return NULL;
    }
    cfg->g_w = (unsigned int)w;
    cfg->g_h = (unsigned int)h;
    cfg->g_timebase.num = 1;
    cfg->g_timebase.den = (fps > 0 ? fps : 30);
    cfg->rc_target_bitrate = (unsigned int)(bitrateKbps > 0 ? bitrateKbps : 8000);
    cfg->rc_end_usage = VPX_CBR;
    cfg->g_pass = VPX_RC_ONE_PASS;
    cfg->g_lag_in_frames = 0;              // realtime: no lookahead
    cfg->g_error_resilient = VPX_ERROR_RESILIENT_DEFAULT;
    cfg->kf_mode = VPX_KF_AUTO;
    // Keyframes are expensive; the gateway forces one on connect + every PLI
    // (lost stream), so a delta run can be long. A distant safety net only
    // matters if RTCP feedback is wedged. Keeps the steady-state stream lean.
    cfg->kf_max_dist = 600;
    cfg->rc_min_quantizer = 4;
    cfg->rc_max_quantizer = e->isVP9 ? 52 : 56;
    cfg->rc_dropframe_thresh = 0;         // never drop — desktop must stay coherent
    // Tight rate-control buffer (ms) so the CBR controller reacts fast and the
    // encoder doesn't bank bits into a deep buffer that shows up as latency.
    // libvpx defaults are 6000/4000/5000 ms (tuned for VOD); a desktop wants a
    // short horizon so a bitrate cut takes effect within a frame or two.
    cfg->rc_buf_sz = 1000;
    cfg->rc_buf_initial_sz = 500;
    cfg->rc_buf_optimal_sz = 600;
    cfg->g_threads = (unsigned int)(threads > 0 ? threads : 4);

    if (vpx_codec_enc_init(&e->codec, iface, cfg, 0) != VPX_CODEC_OK) {
        free(e);
        return NULL;
    }

    // Speed: cpu-used 0..16 (VP8) / 0..9 (VP9), higher = faster. 8 keeps the
    // software encode realtime on a server CPU for both; small surfaces
    // (<= 720p-ish) can afford 7 on VP9 for visibly better text at the same
    // realtime budget. VP8E_SET_CPUUSED is the shared control id for VP8/VP9.
    int cpuUsed = 8;
    if (codecId == 1 && (long)w * (long)h <= 1280L * 720L) cpuUsed = 7;
    vpx_codec_control(&e->codec, VP8E_SET_CPUUSED, cpuUsed);
    vpx_codec_control(&e->codec, VP8E_SET_STATIC_THRESHOLD, 1);
    // Cap keyframe size relative to the average frame budget (percent units;
    // 450 = 4.5 frames' worth). Keyframes here are PLI/connect-driven; without
    // a cap a full-desktop IDR on a starved link blows the 1 s rate-control
    // buffer and freezes the stream for seconds. Mirrors the libvpx/libaom RTC
    // example encoders.
    vpx_codec_control(&e->codec, VP8E_SET_MAX_INTRA_BITRATE_PCT, 450);
    if (e->isVP9) {
        // VP9 screen-content coding + threading. tune-content=screen is the big
        // quality win for desktops; tile-columns (sized by the caller from the
        // surface width) + row-mt parallelise the realtime encode; aq-mode 3
        // (cyclic refresh) is the libvpx RTC rate-control mode — it spreads
        // intra refresh across frames so quality recovers quickly after motion
        // without keyframe-sized spikes; frame-parallel decoding eases the
        // browser's GPU decoder.
        vpx_codec_control(&e->codec, VP9E_SET_TUNE_CONTENT, VP9E_CONTENT_SCREEN);
        vpx_codec_control(&e->codec, VP9E_SET_TILE_COLUMNS, tileColsLog2);
        vpx_codec_control(&e->codec, VP9E_SET_ROW_MT, 1);
        vpx_codec_control(&e->codec, VP9E_SET_AQ_MODE, 3);
        vpx_codec_control(&e->codec, VP9E_SET_FRAME_PARALLEL_DECODING, 1);
        // 1-pass realtime never benefits from the temporal dependency model;
        // disable explicitly so no per-frame stats work sneaks in.
        vpx_codec_control(&e->codec, VP9E_SET_TPL, 0);
    } else {
        // VP8 screen-content mode: dedicated desktop/UI coding tools for the
        // universal-fallback codec (1 = on; 2 adds aggressive rate control).
        vpx_codec_control(&e->codec, VP8E_SET_SCREEN_CONTENT_MODE, 1);
    }

    if (!vpx_img_alloc(&e->img, VPX_IMG_FMT_I420, (unsigned int)w, (unsigned int)h, 1)) {
        vpx_codec_destroy(&e->codec);
        free(e);
        return NULL;
    }
    e->ready = 1;
    e->pts = 0;
    return e;
}

// wVPXEncode converts the BGRA framebuffer to I420 and encodes one frame with
// the configured codec. On success returns 0 and sets *out/*outLen to the
// encoded access unit (valid only until the next wVPXEncode/wVPXFree — copy it
// immediately) and *isKey to 1 for a keyframe. Returns non-zero on failure.
static int wVPXEncode(wVPXEnc* e, const unsigned char* bgra, int stride,
                      int forceKey, const unsigned char** out, int* outLen, int* isKey) {
    if (!e || !e->ready || !bgra || !out || !outLen || !isKey) return 1;
    *out = NULL; *outLen = 0; *isKey = 0;

    BYTE* dst[3] = { e->img.planes[VPX_PLANE_Y], e->img.planes[VPX_PLANE_U], e->img.planes[VPX_PLANE_V] };
    UINT32 dstStep[3] = { (UINT32)e->img.stride[VPX_PLANE_Y], (UINT32)e->img.stride[VPX_PLANE_U], (UINT32)e->img.stride[VPX_PLANE_V] };
    prim_size_t roi = { (UINT32)e->w, (UINT32)e->h };
    if (!e->prims || !e->prims->RGBToYUV420_8u_P3AC4R) return 2;
    if (e->prims->RGBToYUV420_8u_P3AC4R(bgra, PIXEL_FORMAT_BGRA32, (UINT32)stride,
                                        dst, dstStep, &roi) != PRIMITIVES_SUCCESS) {
        return 3;
    }

    vpx_enc_frame_flags_t flags = forceKey ? VPX_EFLAG_FORCE_KF : 0;
    if (vpx_codec_encode(&e->codec, &e->img, e->pts, 1, flags, VPX_DL_REALTIME) != VPX_CODEC_OK) {
        return 4;
    }
    e->pts++;

    vpx_codec_iter_t iter = NULL;
    const vpx_codec_cx_pkt_t* pkt = NULL;
    while ((pkt = vpx_codec_get_cx_data(&e->codec, &iter)) != NULL) {
        if (pkt->kind == VPX_CODEC_CX_FRAME_PKT) {
            *out = (const unsigned char*)pkt->data.frame.buf;
            *outLen = (int)pkt->data.frame.sz;
            *isKey = (pkt->data.frame.flags & VPX_FRAME_IS_KEY) ? 1 : 0;
            return 0; // realtime one-pass emits a single frame packet
        }
    }
    return 5; // encoder buffered with no output (shouldn't happen in realtime)
}

// wVPXSetBitrate retunes the encoder's CBR target bitrate (kbps) live, without
// a re-init or a forced keyframe — libvpx's vpx_codec_enc_config_set applies the
// new rate from the next frame. This is the gateway's congestion-control lever:
// raise toward the quality ceiling on a fat link, cut hard under loss. Returns 0
// on success.
static int wVPXSetBitrate(wVPXEnc* e, int kbps) {
    if (!e || !e->ready || kbps <= 0) return 1;
    if ((unsigned int)kbps == e->cfg.rc_target_bitrate) return 0; // no-op
    e->cfg.rc_target_bitrate = (unsigned int)kbps;
    if (vpx_codec_enc_config_set(&e->codec, &e->cfg) != VPX_CODEC_OK) return 2;
    return 0;
}

static void wVPXFree(wVPXEnc* e) {
    if (!e) return;
    if (e->ready) {
        vpx_img_free(&e->img);
        vpx_codec_destroy(&e->codec);
    }
    free(e);
}
*/
import "C"

import (
	"errors"
	"runtime"
	"sync"
	"time"
	"unsafe"

	"github.com/michongs/jumpserver-anonymous/internal/desktop"
	"go.uber.org/zap"
)

// encoderThreads picks the worker-thread count for a realtime video encoder:
// scale with the host (the old hardcoded 4 starved 16-core servers and
// oversubscribed 2-core ones) while leaving headroom for the FreeRDP run loop
// and the rect-encode pool.
func encoderThreads(width, height int) int {
	n := runtime.NumCPU() - 2
	if n < 2 {
		n = 2
	}
	if n > 8 {
		n = 8
	}
	// Small surfaces can not use many threads (row-mt/tiles run out of rows).
	if width*height <= 1280*720 && n > 4 {
		n = 4
	}
	return n
}

// tileColumnsLog2 sizes encoder tile columns (log2 units) by surface width so
// multi-threading scales on wide desktops: 1 tile below 1280 px, 2 tiles to
// 2560 px, 4 beyond (ultrawide/multi-monitor).
func tileColumnsLog2(width int) int {
	switch {
	case width >= 2560:
		return 2
	case width >= 1280:
		return 1
	default:
		return 0
	}
}

// markVideoDirty flags the framebuffer as changed so the next run-loop tick
// re-encodes it for the WebRTC track. Called from the paint / rdpgfx callbacks.
func (c *Client) markVideoDirty() {
	if c.webrtcMode.Load() {
		c.videoDirty.Store(true)
	}
}

// isWebRTCVideoMode reports whether a VideoMode value selects the WebRTC video
// track ("vp8", "vp9", or "av1") rather than the legacy bitmap path.
func isWebRTCVideoMode(mode string) bool {
	return mode == "vp8" || mode == "vp9" || mode == "av1"
}

// videoCodec returns the codec the worker should encode with on the WebRTC path
// ("vp8", "vp9", or "av1"), defaulting to vp8. AV1 (libaom realtime + screen
// content) is the most bandwidth-efficient at equal quality but the heaviest
// CPU; the gateway only selects it when the browser advertised WebRTC AV1
// decode and the node opted in (PreferAV1).
func (c *Client) videoCodec() string {
	switch c.params.VideoMode {
	case "av1":
		return "av1"
	case "vp9":
		return "vp9"
	default:
		return "vp8"
	}
}

// setVideoMode switches between the WebRTC video track and the legacy bitmap
// path. Gateway-driven (the browser sends "bitmap" on fallback). Safe to call
// from any goroutine.
func (c *Client) setVideoMode(mode string) {
	on := isWebRTCVideoMode(mode)
	if c.webrtcMode.Swap(on) == on {
		return
	}
	if on {
		c.forceKeyframe.Store(true)
		c.videoDirty.Store(true)
		c.logger.Info("video mode → webrtc", zap.String("codec", mode))
	} else {
		c.logger.Info("video mode → bitmap")
		c.requestFrameResync() // repaint the canvas path on the way back
	}
}

func (c *Client) videoFPS() int {
	if c.params.VideoFPS > 0 && c.params.VideoFPS <= 120 {
		return c.params.VideoFPS
	}
	return 30
}

// maybeEncodeVideo is called every run-loop iteration. In WebRTC mode it
// re-encodes the GDI framebuffer (VP8 or VP9, per VideoMode) when it has changed
// and the frame interval has elapsed, then emits a Video ServerMessage. Runs on
// the FreeRDP run-loop thread, which owns primary_buffer, so the zero-copy read
// is safe.
func (c *Client) maybeEncodeVideo(rctx *C.rdpContext) {
	if !c.webrtcMode.Load() || rctx == nil || rctx.gdi == nil || rctx.gdi.primary_buffer == nil {
		return
	}
	if rctx.gdi.suppressOutput != C.FALSE {
		return
	}
	force := c.forceKeyframe.Swap(false)
	now := time.Now()
	interval := time.Second / time.Duration(c.videoFPS())
	if !force {
		if !c.videoDirty.Load() {
			return
		}
		if now.Sub(c.lastVideoAt) < interval {
			return
		}
	}

	w := int(rctx.gdi.width)
	h := int(rctx.gdi.height)
	stride := int(rctx.gdi.stride)
	if stride == 0 {
		stride = int(rctx.gdi.bitmap_stride)
	}
	if w <= 1 || h <= 1 || stride < w*4 {
		return
	}
	// VP8/I420 needs even dimensions; trim the odd last row/column.
	ew, eh := w&^1, h&^1
	if ew <= 0 || eh <= 0 {
		return
	}

	codec := c.videoCodec()
	if c.videoEnc == nil || c.videoW != ew || c.videoH != eh || c.videoEnc.name() != codec {
		if c.videoEnc != nil {
			c.videoEnc.close()
			c.videoEnc = nil
		}
		enc, err := newVideoEncoder(codec, ew, eh, c.videoBitrateKbps(), c.videoFPS())
		if err != nil {
			c.logger.Warn("video encoder init failed", zap.String("codec", codec), zap.Int("w", ew), zap.Int("h", eh), zap.Error(err))
			return
		}
		c.videoEnc = enc
		c.videoW, c.videoH = ew, eh
		force = true // first frame of a new encoder must be a keyframe
	}

	// Track the gateway's live congestion-control target before encoding so this
	// frame is already coded at the budget the link can actually carry.
	c.videoEnc.setBitrate(c.videoBitrateKbps())

	base := unsafe.Pointer(rctx.gdi.primary_buffer)
	bgra := unsafe.Slice((*byte)(base), stride*h) // zero-copy view of the C buffer
	frame, keyframe, err := c.videoEnc.encode(bgra, stride, force)
	if err != nil {
		c.logger.Warn("video encode failed", zap.String("codec", codec), zap.Error(err))
		return
	}
	c.videoDirty.Store(false)
	c.lastVideoAt = now
	// frame is a fresh caller-owned copy; hand it off as raw bytes. main.go's
	// stdout pump emits it as a BinaryFrameVideo frame, so the encoded stream
	// crosses the worker→gateway pipe without JSON/base64 overhead.
	c.emit(desktop.ServerMessage{Video: &desktop.VideoData{
		Codec:    codec,
		Keyframe: keyframe,
		Width:    uint32(ew),
		Height:   uint32(eh),
		Data:     frame,
	}})
}

func (c *Client) videoBitrateKbps() int {
	if t := c.videoTargetKbps.Load(); t > 0 {
		return int(t)
	}
	if c.params.VideoBitrateKbps > 0 {
		return c.params.VideoBitrateKbps
	}
	return 8000
}

// setVideoBitrate records the gateway's congestion-control target (kbps); the
// encode loop applies it to the live encoder on the next frame. Clamped to a
// floor (keep text legible even on a starved link) and to the quality-tier
// ceiling (the estimator must never exceed what the operator provisioned).
func (c *Client) setVideoBitrate(kbps int) {
	if kbps <= 0 {
		return
	}
	const floor = 300
	ceil := c.params.VideoBitrateKbps
	if ceil <= 0 {
		ceil = 8000
	}
	if kbps < floor {
		kbps = floor
	}
	if kbps > ceil {
		kbps = ceil
	}
	c.videoTargetKbps.Store(int64(kbps))
}

func (c *Client) teardownVideo() {
	if c.videoEnc != nil {
		c.videoEnc.close()
		c.videoEnc = nil
	}
}

// videoEncoder abstracts a realtime desktop video encoder so the WebRTC path can
// run VP8/VP9 (libvpx, vpxEncoder) or AV1 (libaom, av1Encoder) interchangeably.
// All methods are called only from the single FreeRDP run-loop thread that owns
// the framebuffer; implementations are not safe for concurrent use across
// encoders.
type videoEncoder interface {
	// encode converts the BGRA framebuffer (with the given stride) to the codec
	// and returns a fresh caller-owned access unit; keyframe marks a decode entry.
	encode(bgra []byte, stride int, forceKey bool) (frame []byte, keyframe bool, err error)
	// setBitrate live-retunes the CBR target (kbps), keyframe-free.
	setBitrate(kbps int)
	// name reports the codec ("vp8" / "vp9" / "av1").
	name() string
	close()
}

// newVideoEncoder builds the encoder backing the requested codec. "av1" uses the
// libaom realtime encoder (av1.go); everything else uses libvpx (VP8/VP9).
func newVideoEncoder(codec string, width, height, bitrateKbps, fps int) (videoEncoder, error) {
	if codec == "av1" {
		return newAV1Encoder(width, height, bitrateKbps, fps)
	}
	return newVPXEncoder(codec, width, height, bitrateKbps, fps)
}

// vpxEncoder is the libvpx-backed implementation of videoEncoder (VP8 or VP9).
type vpxEncoder struct {
	mu      sync.Mutex
	enc     *C.wVPXEnc
	codec   string
	w       int
	h       int
	curKbps int // last applied CBR target, so setBitrate can skip no-ops
}

func newVPXEncoder(codec string, width, height, bitrateKbps, fps int) (*vpxEncoder, error) {
	codecID := C.int(0)
	if codec == "vp9" {
		codecID = 1
	}
	enc := C.wVPXNew(codecID, C.int(width), C.int(height), C.int(bitrateKbps), C.int(fps),
		C.int(encoderThreads(width, height)), C.int(tileColumnsLog2(width)))
	if enc == nil {
		return nil, errors.New(codec + ": encoder init failed")
	}
	return &vpxEncoder{enc: enc, codec: codec, w: width, h: height, curKbps: bitrateKbps}, nil
}

func (e *vpxEncoder) name() string { return e.codec }

// encode converts the BGRA framebuffer (with the given stride) to the configured
// codec. The returned slice is a fresh copy owned by the caller. keyframe
// reports whether this frame is a decode entry point.
func (e *vpxEncoder) encode(bgra []byte, stride int, forceKey bool) (frame []byte, keyframe bool, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc == nil || len(bgra) == 0 {
		return nil, false, errors.New("video: encoder closed or empty frame")
	}
	var out *C.uchar
	var outLen C.int
	var isKey C.int
	force := C.int(0)
	if forceKey {
		force = 1
	}
	rc := C.wVPXEncode(e.enc, (*C.uchar)(unsafe.Pointer(&bgra[0])), C.int(stride),
		force, &out, &outLen, &isKey)
	if rc != 0 {
		return nil, false, errorVPX(int(rc))
	}
	if out == nil || outLen <= 0 {
		return nil, false, errors.New("video: empty encoder output")
	}
	return C.GoBytes(unsafe.Pointer(out), outLen), isKey != 0, nil
}

// setBitrate live-retunes the CBR target (kbps). Cheap and keyframe-free; safe
// to call before each encode. Returns the applied value (clamped ≥ 1).
func (e *vpxEncoder) setBitrate(kbps int) {
	if kbps <= 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc == nil || kbps == e.curKbps {
		return
	}
	if C.wVPXSetBitrate(e.enc, C.int(kbps)) == 0 {
		e.curKbps = kbps
	}
}

func (e *vpxEncoder) close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc != nil {
		C.wVPXFree(e.enc)
		e.enc = nil
	}
}

func errorVPX(code int) error {
	switch code {
	case 3:
		return errors.New("video: BGRA→I420 conversion failed")
	case 4:
		return errors.New("video: vpx_codec_encode failed")
	default:
		return errors.New("video: encode error")
	}
}
