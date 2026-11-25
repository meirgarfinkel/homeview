package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
)

type clientAddrKey struct{}

// withClientAddr records the real public address of a funnel client. A funnel
// connection's RemoteAddr is the Tailscale relay, so the server's ConnContext
// reads the client from ipn.FunnelConn.Src and stores it here.
func withClientAddr(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, clientAddrKey{}, ip)
}

func clientIP(r *http.Request) string {
	if ip, ok := r.Context().Value(clientAddrKey{}).(string); ok && ip != "" {
		return ip
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// newProxy forwards requests to target. It tells the backend the request came
// through the tunnel (shared secret) and who the real client is. Incoming
// X-Forwarded-* headers are dropped by Rewrite, and any client-sent
// X-Kasa-Tunnel is overwritten.
func newProxy(target *url.URL, secret string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			r.Out.Header.Set("X-Kasa-Tunnel", secret)
			r.Out.Header.Set("X-Forwarded-For", clientIP(r.In))
		},
	}
}
