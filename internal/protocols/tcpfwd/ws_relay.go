package tcpfwd

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/coder/websocket"
	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/auth"
	"github.com/michongs/jumpserver-anonymous/internal/model"
	"github.com/michongs/jumpserver-anonymous/internal/repo"
	"github.com/michongs/jumpserver-anonymous/internal/webssh"
)

// WSRelay tunnels a browser WebSocket directly to a remote TCP target through
// the gateway's proxy chain. Frames are JSON-wrapped base64 to keep the
// transport text-safe; binary subprotocols are an option for future revisions.
type WSRelay struct {
	GW    *webssh.Gateway
	Nodes *repo.NodeRepo
}

type relayFrame struct {
	T string `json:"t"`
	D string `json:"d,omitempty"`
}

func (r *WSRelay) Handle(c *gin.Context) {
	claims := auth.FromContext(c.Request.Context())
	if claims == nil || claims.Anonymous {
		c.JSON(http.StatusForbidden, gin.H{"error": "not allowed"})
		return
	}
	nodeID, err := strconv.ParseUint(c.Param("node_id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "bad node id"})
		return
	}
	node, err := r.Nodes.FindByID(c.Request.Context(), nodeID)
	if err != nil || node == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "node not found"})
		return
	}
	if node.Disabled {
		c.JSON(http.StatusForbidden, gin.H{"error": "node disabled"})
		return
	}
	// Overload guard — reserve a slot before the WS upgrade.
	gRelease, gErr := r.GW.Admit(c.Request.Context(), claims.UserID, node)
	if gErr != nil {
		webssh.WriteGuardReject(c, gErr)
		return
	}
	defer gRelease()
	ws, err := webssh.AcceptWS(c, "tcp.v1")
	if err != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := r.run(ctx, ws, node); err != nil {
		_ = ws.Close(websocket.StatusInternalError, err.Error())
		return
	}
	_ = ws.Close(websocket.StatusNormalClosure, "bye")
}

func (r *WSRelay) run(ctx context.Context, ws *websocket.Conn, node *model.Node) error {
	dialer, _, release, err := r.GW.DialerForNode(ctx, node, fmt.Sprintf("tcpfwd-node-%d", node.ID))
	if err != nil {
		return err
	}
	defer release()

	dctx, dcancel := context.WithTimeout(ctx, 15*time.Second)
	conn, err := dialer.DialContext(dctx, "tcp", target(node))
	dcancel()
	if err != nil {
		return err
	}
	defer conn.Close()

	// Pump 1: WS → remote
	go func() {
		for {
			typ, data, err := ws.Read(ctx)
			if err != nil {
				_ = conn.Close()
				return
			}
			if typ != websocket.MessageText {
				continue
			}
			var f relayFrame
			if json.Unmarshal(data, &f) != nil {
				continue
			}
			switch f.T {
			case "data":
				b, err := base64.StdEncoding.DecodeString(f.D)
				if err != nil {
					continue
				}
				if _, err := conn.Write(b); err != nil {
					return
				}
			case "close":
				_ = conn.Close()
				return
			}
		}
	}()

	// Pump 2: remote → WS
	buf := make([]byte, 32*1024)
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			frame, _ := json.Marshal(relayFrame{T: "data", D: base64.StdEncoding.EncodeToString(buf[:n])})
			if werr := ws.Write(ctx, websocket.MessageText, frame); werr != nil {
				return werr
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func target(n *model.Node) string {
	return n.Host + ":" + strconv.Itoa(n.Port)
}
