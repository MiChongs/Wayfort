package webssh

// Frame is the JSON envelope exchanged over the WebSocket. Bytes carried in
// Data are base64-encoded so the channel remains valid UTF-8 JSON.
type Frame struct {
	T    string `json:"t"`
	Data string `json:"d,omitempty"`
	Cols int    `json:"cols,omitempty"`
	Rows int    `json:"rows,omitempty"`
	Msg  string `json:"msg,omitempty"`
}

const (
	TInput  = "input"
	TOutput = "output"
	TResize = "resize"
	TPing   = "ping"
	TPong   = "pong"
	TError  = "error"
	TClose  = "close"
	TReady  = "ready"
)
