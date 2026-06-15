//go:build freerdp

// av1.go — realtime AV1 video encoder (libaom) for the WebRTC video path.
//
// AV1 is the most bandwidth-efficient codec at equal quality (typically 30-50%
// less than VP9 on screen content) and the browsers we target hardware-decode it
// over WebRTC. We use libaom in its REALTIME usage mode with screen-content
// tools — the same configuration Chromium's WebRTC stack uses for AV1 — rather
// than SVT-AV1, because libaom's API mirrors libvpx (see vp8.go) almost exactly,
// keeps the BGRA→I420 + CBR + live-bitrate retune machinery identical, and is
// genuinely low-latency (single frame in, single access unit out, no lookahead).
//
// libaom is BSD-licensed and packaged in MSYS2 (mingw-w64-*-aom). The encoder is
// the second videoEncoder implementation behind the interface declared in
// vp8.go; the gateway selects it via StartParams.VideoMode == "av1" only when the
// browser advertised WebRTC AV1 decode and the node opted in (PreferAV1).

package rdp

/*
#cgo pkg-config: aom freerdp3 winpr3

#include <stdlib.h>
#include <string.h>
#include <aom/aom_encoder.h>
#include <aom/aomcx.h>
#include <freerdp/freerdp.h>
#include <freerdp/gdi/gdi.h>
#include <freerdp/primitives.h>
#include <freerdp/codec/color.h>

typedef struct {
    aom_codec_ctx_t     codec;
    aom_codec_enc_cfg_t cfg;     // kept so the bitrate can be retuned at runtime
    aom_image_t         img;
    int                 w;
    int                 h;
    int                 ready;
    aom_codec_pts_t     pts;
    primitives_t*       prims;
} wAV1Enc;

// wAV1New creates a realtime AV1 encoder for a w x h surface at the given target
// bitrate (kbps) and frame rate, tuned for screen content (palette / IBC coding
// that keeps desktop text + UI crisp at a fraction of the bitrate). threads and
// tileColsLog2 are sized by the Go caller from the host core count and surface
// width. Returns NULL on failure.
static wAV1Enc* wAV1New(int w, int h, int bitrateKbps, int fps,
                        int threads, int tileColsLog2) {
    if (w <= 0 || h <= 0 || (w & 1) || (h & 1)) {
        // AV1 I420 needs even dimensions.
        return NULL;
    }
    wAV1Enc* e = (wAV1Enc*)calloc(1, sizeof(wAV1Enc));
    if (!e) return NULL;
    e->w = w;
    e->h = h;
    e->prims = primitives_get();

    aom_codec_iface_t* iface = aom_codec_av1_cx();
    if (!iface) { free(e); return NULL; }

    aom_codec_enc_cfg_t* cfg = &e->cfg;
    // AOM_USAGE_REALTIME seeds the low-latency defaults; we override the rate
    // control + buffer horizon the same way vp8.go does for libvpx.
    if (aom_codec_enc_config_default(iface, cfg, AOM_USAGE_REALTIME) != AOM_CODEC_OK) {
        free(e);
        return NULL;
    }
    cfg->g_w = (unsigned int)w;
    cfg->g_h = (unsigned int)h;
    cfg->g_timebase.num = 1;
    cfg->g_timebase.den = (fps > 0 ? fps : 30);
    cfg->g_usage = AOM_USAGE_REALTIME;
    cfg->rc_target_bitrate = (unsigned int)(bitrateKbps > 0 ? bitrateKbps : 8000);
    cfg->rc_end_usage = AOM_CBR;
    cfg->g_pass = AOM_RC_ONE_PASS;
    cfg->g_lag_in_frames = 0;              // realtime: no lookahead
    cfg->g_error_resilient = 0;
    cfg->kf_mode = AOM_KF_AUTO;
    cfg->kf_max_dist = 600;                // gateway forces keyframes on PLI/connect
    cfg->rc_min_quantizer = 4;
    cfg->rc_max_quantizer = 56;
    cfg->rc_dropframe_thresh = 0;          // never drop — desktop must stay coherent
    // Short rate-control buffer (ms) so a CBR bitrate cut takes effect within a
    // frame or two instead of banking bits into latency.
    cfg->rc_buf_sz = 1000;
    cfg->rc_buf_initial_sz = 500;
    cfg->rc_buf_optimal_sz = 600;
    cfg->g_threads = (unsigned int)(threads > 0 ? threads : 4);

    if (aom_codec_enc_init(&e->codec, iface, cfg, 0) != AOM_CODEC_OK) {
        free(e);
        return NULL;
    }

    // cpu-used (higher = faster): scale with surface area. Small surfaces get 8
    // (visibly better text for CPU we can spare), 1080p-class stays at 9, and
    // anything larger first sets 9 then attempts 10 — newer libaom allows
    // realtime 10..12, older builds reject the control, which leaves the safe 9
    // applied. Screen-content tune is the big quality win for desktops; row-mt
    // + tile-columns (sized by the caller from surface width) parallelise the
    // realtime encode.
    long area = (long)w * (long)h;
    int cpuUsed = (area <= 1366L * 768L) ? 8 : 9;
    aom_codec_control(&e->codec, AOME_SET_CPUUSED, cpuUsed);
    if (area > 1920L * 1200L) {
        aom_codec_control(&e->codec, AOME_SET_CPUUSED, 10);
    }
    aom_codec_control(&e->codec, AV1E_SET_TUNE_CONTENT, AOM_CONTENT_SCREEN);
    aom_codec_control(&e->codec, AV1E_SET_ROW_MT, 1);
    aom_codec_control(&e->codec, AV1E_SET_TILE_COLUMNS, tileColsLog2);
    aom_codec_control(&e->codec, AV1E_SET_ENABLE_PALETTE, 1);
    // Cyclic-refresh adaptive quantization — libaom's RTC rate-control mode.
    // Spreads intra refresh across frames so post-motion quality recovers
    // without keyframe-sized bitrate spikes.
    aom_codec_control(&e->codec, AV1E_SET_AQ_MODE, 3);
    // 1-pass realtime never uses the temporal dependency model; keep it off
    // explicitly (it is compiled out of CONFIG_REALTIME_ONLY builds anyway).
    aom_codec_control(&e->codec, AV1E_SET_ENABLE_TPL_MODEL, 0);
    // Cap keyframe size at 4.5x the average frame budget (percent units) so a
    // PLI-forced IDR can not blow the 1 s rate-control buffer and stall the
    // session on a starved link. Same control the libaom svc_encoder_rtc
    // example sets. NOTE: AOME_ prefix — AV1E_SET_MAX_INTRA_BITRATE_PCT does
    // not exist.
    aom_codec_control(&e->codec, AOME_SET_MAX_INTRA_BITRATE_PCT, 450);
    // Refresh entropy-coding cost tables per tile instead of per superblock —
    // a few percent of encode CPU back at speeds >= 9, matching the RTC
    // example encoder (0=SB, 1=SB row, 2=tile, 3=off).
    aom_codec_control(&e->codec, AV1E_SET_COEFF_COST_UPD_FREQ, 2);
    aom_codec_control(&e->codec, AV1E_SET_MODE_COST_UPD_FREQ, 2);
    aom_codec_control(&e->codec, AV1E_SET_MV_COST_UPD_FREQ, 2);

    if (!aom_img_alloc(&e->img, AOM_IMG_FMT_I420, (unsigned int)w, (unsigned int)h, 1)) {
        aom_codec_destroy(&e->codec);
        free(e);
        return NULL;
    }
    e->ready = 1;
    e->pts = 0;
    return e;
}

// wAV1Encode converts the BGRA framebuffer to I420 and encodes one frame. On
// success returns 0 and sets *out/*outLen to the encoded AV1 temporal unit
// (valid only until the next wAV1Encode/wAV1Free — copy it immediately) and
// *isKey to 1 for a keyframe. Returns non-zero on failure.
static int wAV1Encode(wAV1Enc* e, const unsigned char* bgra, int stride,
                      int forceKey, const unsigned char** out, int* outLen, int* isKey) {
    if (!e || !e->ready || !bgra || !out || !outLen || !isKey) return 1;
    *out = NULL; *outLen = 0; *isKey = 0;

    BYTE* dst[3] = { e->img.planes[AOM_PLANE_Y], e->img.planes[AOM_PLANE_U], e->img.planes[AOM_PLANE_V] };
    UINT32 dstStep[3] = { (UINT32)e->img.stride[AOM_PLANE_Y], (UINT32)e->img.stride[AOM_PLANE_U], (UINT32)e->img.stride[AOM_PLANE_V] };
    prim_size_t roi = { (UINT32)e->w, (UINT32)e->h };
    if (!e->prims || !e->prims->RGBToYUV420_8u_P3AC4R) return 2;
    if (e->prims->RGBToYUV420_8u_P3AC4R(bgra, PIXEL_FORMAT_BGRA32, (UINT32)stride,
                                        dst, dstStep, &roi) != PRIMITIVES_SUCCESS) {
        return 3;
    }

    aom_enc_frame_flags_t flags = forceKey ? AOM_EFLAG_FORCE_KF : 0;
    // libaom's aom_codec_encode has no deadline arg (realtime is set via usage +
    // cpu-used); the signature is (ctx, img, pts, duration, flags).
    if (aom_codec_encode(&e->codec, &e->img, e->pts, 1, flags) != AOM_CODEC_OK) {
        return 4;
    }
    e->pts++;

    aom_codec_iter_t iter = NULL;
    const aom_codec_cx_pkt_t* pkt = NULL;
    while ((pkt = aom_codec_get_cx_data(&e->codec, &iter)) != NULL) {
        if (pkt->kind == AOM_CODEC_CX_FRAME_PKT) {
            *out = (const unsigned char*)pkt->data.frame.buf;
            *outLen = (int)pkt->data.frame.sz;
            *isKey = (pkt->data.frame.flags & AOM_FRAME_IS_KEY) ? 1 : 0;
            return 0; // realtime one-pass emits a single frame packet
        }
    }
    return 5; // encoder buffered with no output (shouldn't happen in realtime)
}

// wAV1SetBitrate retunes the CBR target bitrate (kbps) live, without a re-init or
// a forced keyframe — aom_codec_enc_config_set applies the new rate from the next
// frame. Returns 0 on success.
static int wAV1SetBitrate(wAV1Enc* e, int kbps) {
    if (!e || !e->ready || kbps <= 0) return 1;
    if ((unsigned int)kbps == e->cfg.rc_target_bitrate) return 0; // no-op
    e->cfg.rc_target_bitrate = (unsigned int)kbps;
    if (aom_codec_enc_config_set(&e->codec, &e->cfg) != AOM_CODEC_OK) return 2;
    return 0;
}

static void wAV1Free(wAV1Enc* e) {
    if (!e) return;
    if (e->ready) {
        aom_img_free(&e->img);
        aom_codec_destroy(&e->codec);
    }
    free(e);
}
*/
import "C"

import (
	"errors"
	"sync"
	"unsafe"
)

// av1Encoder is the libaom-backed implementation of videoEncoder (AV1). Like
// vpxEncoder it is used only from the single FreeRDP run-loop thread.
type av1Encoder struct {
	mu      sync.Mutex
	enc     *C.wAV1Enc
	w       int
	h       int
	curKbps int // last applied CBR target, so setBitrate can skip no-ops
}

func newAV1Encoder(width, height, bitrateKbps, fps int) (*av1Encoder, error) {
	enc := C.wAV1New(C.int(width), C.int(height), C.int(bitrateKbps), C.int(fps),
		C.int(encoderThreads(width, height)), C.int(tileColumnsLog2(width)))
	if enc == nil {
		return nil, errors.New("av1: encoder init failed")
	}
	return &av1Encoder{enc: enc, w: width, h: height, curKbps: bitrateKbps}, nil
}

func (e *av1Encoder) name() string { return "av1" }

func (e *av1Encoder) encode(bgra []byte, stride int, forceKey bool) (frame []byte, keyframe bool, err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc == nil || len(bgra) == 0 {
		return nil, false, errors.New("av1: encoder closed or empty frame")
	}
	var out *C.uchar
	var outLen C.int
	var isKey C.int
	force := C.int(0)
	if forceKey {
		force = 1
	}
	rc := C.wAV1Encode(e.enc, (*C.uchar)(unsafe.Pointer(&bgra[0])), C.int(stride),
		force, &out, &outLen, &isKey)
	if rc != 0 {
		return nil, false, errorAV1(int(rc))
	}
	if out == nil || outLen <= 0 {
		return nil, false, errors.New("av1: empty encoder output")
	}
	return C.GoBytes(unsafe.Pointer(out), outLen), isKey != 0, nil
}

func (e *av1Encoder) setBitrate(kbps int) {
	if kbps <= 0 {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc == nil || kbps == e.curKbps {
		return
	}
	if C.wAV1SetBitrate(e.enc, C.int(kbps)) == 0 {
		e.curKbps = kbps
	}
}

func (e *av1Encoder) close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.enc != nil {
		C.wAV1Free(e.enc)
		e.enc = nil
	}
}

func errorAV1(code int) error {
	switch code {
	case 3:
		return errors.New("av1: BGRA→I420 conversion failed")
	case 4:
		return errors.New("av1: aom_codec_encode failed")
	default:
		return errors.New("av1: encode error")
	}
}
