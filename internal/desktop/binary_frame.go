package desktop

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
)

const BinaryFrameHeaderSize = 32

type BinaryFrameKind uint8

const (
	BinaryFrameJSON   BinaryFrameKind = 1
	BinaryFrameRect   BinaryFrameKind = 2
	BinaryFrameCursor BinaryFrameKind = 3
	BinaryFrameBatch  BinaryFrameKind = 4
)

type BinaryFrameEncoding uint8

const (
	BinaryEncodingNone     BinaryFrameEncoding = 0
	BinaryEncodingRawBGRA  BinaryFrameEncoding = 1
	BinaryEncodingJPEG     BinaryFrameEncoding = 2
	BinaryEncodingPNG      BinaryFrameEncoding = 3
	BinaryEncodingZlibBGRA BinaryFrameEncoding = 4
	// AVC420 H.264 payload forwarded from libfreerdp's RDPGFX channel
	// (channels.go goRdpgfxSurfaceCommand). Browser side decodes via
	// WebCodecs.VideoDecoder. AVC444 is forced off by client.go so any
	// frame arriving here under EncodingH264 is single-stream YUV4:2:0.
	BinaryEncodingH264 BinaryFrameEncoding = 5
	// RemoteFX progressive codec payload. Wire tag is honest but no
	// browser-side decoder is wired up yet — kept here so the byte
	// allocation stays stable when that work lands.
	BinaryEncodingRFX BinaryFrameEncoding = 6
)

type BinaryFrameHeader struct {
	Kind     BinaryFrameKind
	Encoding BinaryFrameEncoding
	X        uint32
	Y        uint32
	Width    uint32
	Height   uint32
	PayloadN uint32
}

func EncodeBinaryFrameHeader(h BinaryFrameHeader, dst []byte) error {
	if len(dst) < BinaryFrameHeaderSize {
		return errors.New("binary frame header buffer too small")
	}
	dst[0] = byte(h.Kind)
	dst[1] = byte(h.Encoding)
	binary.BigEndian.PutUint32(dst[8:12], h.X)
	binary.BigEndian.PutUint32(dst[12:16], h.Y)
	binary.BigEndian.PutUint32(dst[16:20], h.Width)
	binary.BigEndian.PutUint32(dst[20:24], h.Height)
	binary.BigEndian.PutUint32(dst[24:28], h.PayloadN)
	return nil
}

func DecodeBinaryFrameHeader(src []byte) (BinaryFrameHeader, error) {
	if len(src) < BinaryFrameHeaderSize {
		return BinaryFrameHeader{}, errors.New("binary frame header buffer too small")
	}
	return BinaryFrameHeader{
		Kind:     BinaryFrameKind(src[0]),
		Encoding: BinaryFrameEncoding(src[1]),
		X:        binary.BigEndian.Uint32(src[8:12]),
		Y:        binary.BigEndian.Uint32(src[12:16]),
		Width:    binary.BigEndian.Uint32(src[16:20]),
		Height:   binary.BigEndian.Uint32(src[20:24]),
		PayloadN: binary.BigEndian.Uint32(src[24:28]),
	}, nil
}

func EncodeServerMessageBinaryPayload(msg ServerMessage) ([]byte, error) {
	if msg.FrameBatch != nil && len(msg.FrameBatch.Frames) > 0 {
		if len(msg.FrameBatch.Frames) == 1 {
			frame := msg.FrameBatch.Frames[0]
			return EncodeServerMessageBinaryPayload(ServerMessage{Frame: &frame})
		}
		payload, err := encodeFrameBatchPayload(msg.FrameBatch.Frames)
		if err != nil {
			return nil, err
		}
		return encodeBinaryPayload(BinaryFrameHeader{
			Kind:     BinaryFrameBatch,
			Encoding: BinaryEncodingNone,
			PayloadN: uint32(len(payload)),
		}, payload)
	}
	if msg.Frame != nil {
		enc, ok := binaryEncodingFromFrame(msg.Frame.Encoding)
		if !ok {
			return nil, fmt.Errorf("unsupported frame encoding %q", msg.Frame.Encoding)
		}
		return encodeBinaryPayload(BinaryFrameHeader{
			Kind:     BinaryFrameRect,
			Encoding: enc,
			X:        msg.Frame.X,
			Y:        msg.Frame.Y,
			Width:    msg.Frame.Width,
			Height:   msg.Frame.Height,
			PayloadN: uint32(len(msg.Frame.Payload)),
		}, msg.Frame.Payload)
	}
	if msg.Cursor != nil && len(msg.Cursor.Payload) > 0 {
		enc, ok := binaryEncodingFromCursor(msg.Cursor.Encoding)
		if !ok {
			return nil, fmt.Errorf("unsupported cursor encoding %q", msg.Cursor.Encoding)
		}
		return encodeBinaryPayload(BinaryFrameHeader{
			Kind:     BinaryFrameCursor,
			Encoding: enc,
			X:        msg.Cursor.HotspotX,
			Y:        msg.Cursor.HotspotY,
			Width:    msg.Cursor.Width,
			Height:   msg.Cursor.Height,
			PayloadN: uint32(len(msg.Cursor.Payload)),
		}, msg.Cursor.Payload)
	}
	body, err := json.Marshal(msg)
	if err != nil {
		return nil, err
	}
	return encodeBinaryPayload(BinaryFrameHeader{
		Kind:     BinaryFrameJSON,
		Encoding: BinaryEncodingNone,
		PayloadN: uint32(len(body)),
	}, body)
}

func DecodeServerMessageBinaryPayload(body []byte) (ServerMessage, bool, error) {
	if len(body) < BinaryFrameHeaderSize || !looksLikeBinaryServerPayload(body[0]) {
		return ServerMessage{}, false, nil
	}
	header, err := DecodeBinaryFrameHeader(body[:BinaryFrameHeaderSize])
	if err != nil {
		return ServerMessage{}, true, err
	}
	end := BinaryFrameHeaderSize + int(header.PayloadN)
	if end < BinaryFrameHeaderSize || end > len(body) {
		return ServerMessage{}, true, fmt.Errorf("binary payload length mismatch: header=%d body=%d", header.PayloadN, len(body)-BinaryFrameHeaderSize)
	}
	payload := body[BinaryFrameHeaderSize:end]
	switch header.Kind {
	case BinaryFrameJSON:
		var msg ServerMessage
		if err := json.Unmarshal(payload, &msg); err != nil {
			return ServerMessage{}, true, err
		}
		return msg, true, nil
	case BinaryFrameRect:
		enc, ok := frameEncodingFromBinary(header.Encoding)
		if !ok {
			return ServerMessage{}, true, fmt.Errorf("unsupported binary frame encoding %d", header.Encoding)
		}
		return ServerMessage{Frame: &FrameRect{
			X:        header.X,
			Y:        header.Y,
			Width:    header.Width,
			Height:   header.Height,
			Encoding: enc,
			Payload:  payload,
		}}, true, nil
	case BinaryFrameCursor:
		enc, ok := cursorEncodingFromBinary(header.Encoding)
		if !ok {
			return ServerMessage{}, true, fmt.Errorf("unsupported binary cursor encoding %d", header.Encoding)
		}
		return ServerMessage{Cursor: &CursorUpdate{
			HotspotX: header.X,
			HotspotY: header.Y,
			Width:    header.Width,
			Height:   header.Height,
			Encoding: enc,
			Payload:  payload,
		}}, true, nil
	case BinaryFrameBatch:
		frames, err := decodeFrameBatchPayload(payload)
		if err != nil {
			return ServerMessage{}, true, err
		}
		return ServerMessage{FrameBatch: &FrameBatch{Frames: frames}}, true, nil
	default:
		return ServerMessage{}, true, fmt.Errorf("unsupported binary frame kind %d", header.Kind)
	}
}

func encodeFrameBatchPayload(frames []FrameRect) ([]byte, error) {
	if len(frames) > int(^uint32(0)) {
		return nil, errors.New("too many frames in batch")
	}
	payloadN := 4
	for _, frame := range frames {
		payloadN += BinaryFrameHeaderSize + len(frame.Payload)
	}
	out := make([]byte, payloadN)
	binary.BigEndian.PutUint32(out[:4], uint32(len(frames)))
	off := 4
	for _, frame := range frames {
		enc, ok := binaryEncodingFromFrame(frame.Encoding)
		if !ok {
			return nil, fmt.Errorf("unsupported frame encoding %q", frame.Encoding)
		}
		if err := EncodeBinaryFrameHeader(BinaryFrameHeader{
			Kind:     BinaryFrameRect,
			Encoding: enc,
			X:        frame.X,
			Y:        frame.Y,
			Width:    frame.Width,
			Height:   frame.Height,
			PayloadN: uint32(len(frame.Payload)),
		}, out[off:off+BinaryFrameHeaderSize]); err != nil {
			return nil, err
		}
		off += BinaryFrameHeaderSize
		copy(out[off:off+len(frame.Payload)], frame.Payload)
		off += len(frame.Payload)
	}
	return out, nil
}

func decodeFrameBatchPayload(payload []byte) ([]FrameRect, error) {
	if len(payload) < 4 {
		return nil, errors.New("binary frame batch payload too small")
	}
	count := int(binary.BigEndian.Uint32(payload[:4]))
	frames := make([]FrameRect, 0, count)
	off := 4
	for i := 0; i < count; i++ {
		if len(payload)-off < BinaryFrameHeaderSize {
			return nil, fmt.Errorf("binary frame batch header %d too small", i)
		}
		header, err := DecodeBinaryFrameHeader(payload[off : off+BinaryFrameHeaderSize])
		if err != nil {
			return nil, err
		}
		off += BinaryFrameHeaderSize
		if header.Kind != BinaryFrameRect {
			return nil, fmt.Errorf("binary frame batch item %d has kind %d", i, header.Kind)
		}
		enc, ok := frameEncodingFromBinary(header.Encoding)
		if !ok {
			return nil, fmt.Errorf("unsupported binary frame encoding %d", header.Encoding)
		}
		end := off + int(header.PayloadN)
		if end < off || end > len(payload) {
			return nil, fmt.Errorf("binary frame batch item %d length mismatch", i)
		}
		frames = append(frames, FrameRect{
			X:        header.X,
			Y:        header.Y,
			Width:    header.Width,
			Height:   header.Height,
			Encoding: enc,
			Payload:  payload[off:end],
		})
		off = end
	}
	if off != len(payload) {
		return nil, fmt.Errorf("binary frame batch has %d trailing bytes", len(payload)-off)
	}
	return frames, nil
}

func encodeBinaryPayload(h BinaryFrameHeader, payload []byte) ([]byte, error) {
	out := make([]byte, BinaryFrameHeaderSize+len(payload))
	if err := EncodeBinaryFrameHeader(h, out[:BinaryFrameHeaderSize]); err != nil {
		return nil, err
	}
	copy(out[BinaryFrameHeaderSize:], payload)
	return out, nil
}

func looksLikeBinaryServerPayload(kind byte) bool {
	switch BinaryFrameKind(kind) {
	case BinaryFrameJSON, BinaryFrameRect, BinaryFrameCursor, BinaryFrameBatch:
		return true
	default:
		return false
	}
}

func binaryEncodingFromFrame(enc Encoding) (BinaryFrameEncoding, bool) {
	switch enc {
	case EncodingRawBGRA:
		return BinaryEncodingRawBGRA, true
	case EncodingJPEG:
		return BinaryEncodingJPEG, true
	case EncodingPNG:
		return BinaryEncodingPNG, true
	case EncodingZlibBGRA:
		return BinaryEncodingZlibBGRA, true
	case EncodingH264:
		return BinaryEncodingH264, true
	case EncodingRFX:
		return BinaryEncodingRFX, true
	default:
		return BinaryEncodingNone, false
	}
}

func frameEncodingFromBinary(enc BinaryFrameEncoding) (Encoding, bool) {
	switch enc {
	case BinaryEncodingRawBGRA:
		return EncodingRawBGRA, true
	case BinaryEncodingJPEG:
		return EncodingJPEG, true
	case BinaryEncodingPNG:
		return EncodingPNG, true
	case BinaryEncodingZlibBGRA:
		return EncodingZlibBGRA, true
	case BinaryEncodingH264:
		return EncodingH264, true
	case BinaryEncodingRFX:
		return EncodingRFX, true
	default:
		return "", false
	}
}

func binaryEncodingFromCursor(enc CursorEncoding) (BinaryFrameEncoding, bool) {
	switch enc {
	case CursorEncodingRawBGRA:
		return BinaryEncodingRawBGRA, true
	case CursorEncodingPNG:
		return BinaryEncodingPNG, true
	default:
		return BinaryEncodingNone, false
	}
}

func cursorEncodingFromBinary(enc BinaryFrameEncoding) (CursorEncoding, bool) {
	switch enc {
	case BinaryEncodingRawBGRA:
		return CursorEncodingRawBGRA, true
	case BinaryEncodingPNG:
		return CursorEncodingPNG, true
	default:
		return "", false
	}
}
