package server

import (
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/michongs/jumpserver-anonymous/internal/api"
)

// TestWireGuardRoutesRegister makes sure the WireGuard route set (the only place
// in the ops tree that introduces a :name path param alongside static siblings)
// registers without an httprouter conflict panic.
func TestWireGuardRoutesRegister(t *testing.T) {
	gin.SetMode(gin.TestMode)
	defer func() {
		if r := recover(); r != nil {
			t.Fatalf("wireguard routes panicked on registration: %v", r)
		}
	}()
	r := gin.New()
	ops := r.Group("/api/v1")
	h := api.NewWireGuardHandlerStub("test")
	mw := func(c *gin.Context) {}

	ops.GET("/nodes/:id/wireguard", h.Status)
	ops.GET("/nodes/:id/wireguard/stream", h.Stream)
	ops.GET("/nodes/:id/wireguard/probe", h.Probe)
	ops.GET("/nodes/:id/wireguard/gateway", h.GatewayStatus)
	ops.GET("/nodes/:id/wireguard/ifaces/:name", h.GetIfaceConfig)
	ops.GET("/nodes/:id/wireguard/ifaces/:name/conf", h.ReadConf)
	ops.POST("/nodes/:id/wireguard/iface", mw, h.SetInterface)
	ops.POST("/nodes/:id/wireguard/install/stream", mw, h.Install)
	ops.POST("/nodes/:id/wireguard/keys", mw, h.GenKeyPair)
	ops.POST("/nodes/:id/wireguard/psk", mw, h.GenPSK)
	ops.POST("/nodes/:id/wireguard/ifaces", mw, h.CreateIface)
	ops.PATCH("/nodes/:id/wireguard/ifaces/:name", mw, h.UpdateIface)
	ops.DELETE("/nodes/:id/wireguard/ifaces/:name", mw, h.DeleteIface)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/autostart", mw, h.SetAutostart)
	ops.PUT("/nodes/:id/wireguard/ifaces/:name/conf", mw, h.WriteConf)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/conf/diff", mw, h.DiffConf)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/apply/stream", mw, h.ApplyConfigStream)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/peers", mw, h.AddPeer)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/peers/update", mw, h.UpdatePeer)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/peers/delete", mw, h.DeletePeer)
	ops.POST("/nodes/:id/wireguard/ifaces/:name/clients", mw, h.NewClient)
	ops.POST("/nodes/:id/wireguard/gateway/forwarding", mw, h.EnableForwarding)
	ops.POST("/nodes/:id/wireguard/gateway/nat", mw, h.SetNAT)
}
