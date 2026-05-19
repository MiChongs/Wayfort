package desktop

import (
	"bytes"
	"testing"
)

func TestBinaryFrameHeaderRoundTrip(t *testing.T) {
	want := BinaryFrameHeader{
		Kind:     BinaryFrameRect,
		Encoding: BinaryEncodingRawBGRA,
		X:        11,
		Y:        22,
		Width:    1280,
		Height:   720,
		PayloadN: 1024,
	}
	buf := make([]byte, BinaryFrameHeaderSize)
	if err := EncodeBinaryFrameHeader(want, buf); err != nil {
		t.Fatalf("EncodeBinaryFrameHeader() error = %v", err)
	}
	got, err := DecodeBinaryFrameHeader(buf)
	if err != nil {
		t.Fatalf("DecodeBinaryFrameHeader() error = %v", err)
	}
	if got != want {
		t.Fatalf("DecodeBinaryFrameHeader() = %#v, want %#v", got, want)
	}
}

func TestBinaryFrameHeaderShortBuffer(t *testing.T) {
	if err := EncodeBinaryFrameHeader(BinaryFrameHeader{}, make([]byte, BinaryFrameHeaderSize-1)); err == nil {
		t.Fatal("EncodeBinaryFrameHeader() error = nil, want short buffer error")
	}
	if _, err := DecodeBinaryFrameHeader(make([]byte, BinaryFrameHeaderSize-1)); err == nil {
		t.Fatal("DecodeBinaryFrameHeader() error = nil, want short buffer error")
	}
}

func TestServerMessageBinaryFrameRoundTrip(t *testing.T) {
	payload := []byte{1, 2, 3, 4, 5}
	want := ServerMessage{Frame: &FrameRect{
		X:        7,
		Y:        8,
		Width:    9,
		Height:   10,
		Encoding: EncodingJPEG,
		Payload:  payload,
	}}
	body, err := EncodeServerMessageBinaryPayload(want)
	if err != nil {
		t.Fatalf("EncodeServerMessageBinaryPayload() error = %v", err)
	}
	got, ok, err := DecodeServerMessageBinaryPayload(body)
	if err != nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() error = %v", err)
	}
	if !ok {
		t.Fatal("DecodeServerMessageBinaryPayload() ok = false, want true")
	}
	if got.Frame == nil {
		t.Fatal("decoded frame is nil")
	}
	if got.Frame.X != want.Frame.X || got.Frame.Y != want.Frame.Y || got.Frame.Width != want.Frame.Width || got.Frame.Height != want.Frame.Height || got.Frame.Encoding != want.Frame.Encoding {
		t.Fatalf("decoded frame metadata = %#v, want %#v", got.Frame, want.Frame)
	}
	if !bytes.Equal(got.Frame.Payload, payload) {
		t.Fatalf("decoded payload = %v, want %v", got.Frame.Payload, payload)
	}
}

func TestServerMessageBinaryZlibBGRARoundTrip(t *testing.T) {
	payload := []byte{0x78, 0x01, 1, 2, 3, 4}
	want := ServerMessage{Frame: &FrameRect{
		X:        1,
		Y:        2,
		Width:    3,
		Height:   4,
		Encoding: EncodingZlibBGRA,
		Payload:  payload,
	}}
	body, err := EncodeServerMessageBinaryPayload(want)
	if err != nil {
		t.Fatalf("EncodeServerMessageBinaryPayload() error = %v", err)
	}
	header, err := DecodeBinaryFrameHeader(body[:BinaryFrameHeaderSize])
	if err != nil {
		t.Fatalf("DecodeBinaryFrameHeader() error = %v", err)
	}
	if header.Encoding != BinaryEncodingZlibBGRA {
		t.Fatalf("binary encoding = %d, want %d", header.Encoding, BinaryEncodingZlibBGRA)
	}
	got, ok, err := DecodeServerMessageBinaryPayload(body)
	if err != nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() error = %v", err)
	}
	if !ok || got.Frame == nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() ok=%v frame=%#v", ok, got.Frame)
	}
	if got.Frame.Encoding != EncodingZlibBGRA {
		t.Fatalf("decoded encoding = %q, want %q", got.Frame.Encoding, EncodingZlibBGRA)
	}
	if !bytes.Equal(got.Frame.Payload, payload) {
		t.Fatalf("decoded payload = %v, want %v", got.Frame.Payload, payload)
	}
}

func TestServerMessageBinaryFrameBatchRoundTrip(t *testing.T) {
	want := ServerMessage{FrameBatch: &FrameBatch{Frames: []FrameRect{
		{X: 1, Y: 2, Width: 3, Height: 4, Encoding: EncodingRawBGRA, Payload: []byte{1, 2, 3, 4}},
		{X: 5, Y: 6, Width: 7, Height: 8, Encoding: EncodingZlibBGRA, Payload: []byte{0x78, 0x01, 9, 10}},
	}}}
	body, err := EncodeServerMessageBinaryPayload(want)
	if err != nil {
		t.Fatalf("EncodeServerMessageBinaryPayload() error = %v", err)
	}
	header, err := DecodeBinaryFrameHeader(body[:BinaryFrameHeaderSize])
	if err != nil {
		t.Fatalf("DecodeBinaryFrameHeader() error = %v", err)
	}
	if header.Kind != BinaryFrameBatch {
		t.Fatalf("binary kind = %d, want %d", header.Kind, BinaryFrameBatch)
	}
	got, ok, err := DecodeServerMessageBinaryPayload(body)
	if err != nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() error = %v", err)
	}
	if !ok || got.FrameBatch == nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() ok=%v batch=%#v", ok, got.FrameBatch)
	}
	if len(got.FrameBatch.Frames) != len(want.FrameBatch.Frames) {
		t.Fatalf("decoded frame count = %d, want %d", len(got.FrameBatch.Frames), len(want.FrameBatch.Frames))
	}
	for i := range got.FrameBatch.Frames {
		gotFrame := got.FrameBatch.Frames[i]
		wantFrame := want.FrameBatch.Frames[i]
		if gotFrame.X != wantFrame.X || gotFrame.Y != wantFrame.Y || gotFrame.Width != wantFrame.Width || gotFrame.Height != wantFrame.Height || gotFrame.Encoding != wantFrame.Encoding {
			t.Fatalf("decoded frame %d metadata = %#v, want %#v", i, gotFrame, wantFrame)
		}
		if !bytes.Equal(gotFrame.Payload, wantFrame.Payload) {
			t.Fatalf("decoded frame %d payload = %v, want %v", i, gotFrame.Payload, wantFrame.Payload)
		}
	}
}

func TestServerMessageBinaryJSONRoundTrip(t *testing.T) {
	want := ServerMessage{Status: &SessionStatus{Phase: PhaseConnected, Message: "ready"}}
	body, err := EncodeServerMessageBinaryPayload(want)
	if err != nil {
		t.Fatalf("EncodeServerMessageBinaryPayload() error = %v", err)
	}
	got, ok, err := DecodeServerMessageBinaryPayload(body)
	if err != nil {
		t.Fatalf("DecodeServerMessageBinaryPayload() error = %v", err)
	}
	if !ok {
		t.Fatal("DecodeServerMessageBinaryPayload() ok = false, want true")
	}
	if got.Status == nil || got.Status.Phase != PhaseConnected || got.Status.Message != "ready" {
		t.Fatalf("decoded status = %#v", got.Status)
	}
}

func TestServerMessageBinaryPayloadIgnoresJSON(t *testing.T) {
	if _, ok, err := DecodeServerMessageBinaryPayload([]byte(`{"status":{"phase":"CONNECTED"}}`)); err != nil || ok {
		t.Fatalf("DecodeServerMessageBinaryPayload(JSON) = ok %v err %v, want ok false err nil", ok, err)
	}
}
