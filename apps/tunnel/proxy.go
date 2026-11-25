package main

import (
	"context"
	"crypto/tls"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"

	"tailscale.com/ipn"
)

type clientAddrKey struct{}

// withClientAddr records the real public address of a funnel client. A funnel
// connection's RemoteAddr is the Tailscale relay, so the server's ConnContext
// reads the client from ipn.FunnelConn.Src and stores it here.
func withClientAddr(ctx context.Context, ip string) context.Context {
	return context.WithValue(ctx, clientAddrKey{}, ip)
}

// clientAddr returns the funnel client recorded by withClientAddr.
func clientAddr(r *http.Request) (string, bool) {
	ip, ok := r.Context().Value(clientAddrKey{}).(string)
	return ip, ok && ip != ""
}

func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// newProxy forwards requests to target and takes the client address from
// RemoteAddr. Use it only where RemoteAddr is the real client (tests, direct
// listeners). The funnel path uses newFunnelProxy.
func newProxy(target *url.URL, secret string) http.Handler {
	return buildProxy(target, secret, remoteIP)
}

// newFunnelProxy is the production handler. A funnel connection's RemoteAddr is
// the relay, so the real client must come from the context. When it is missing
// the request is refused rather than attributed to the relay, which would make
// every remote client share one address.
func newFunnelProxy(target *url.URL, secret string) http.Handler {
	inner := buildProxy(target, secret, func(r *http.Request) string {
		ip, _ := clientAddr(r)
		return ip
	})
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := clientAddr(r); !ok {
			http.Error(w, "client address unavailable", http.StatusBadGateway)
			return
		}
		inner.ServeHTTP(w, r)
	})
}

// buildProxy tells the backend the request came through the tunnel (shared
// secret) and who the real client is. Incoming X-Forwarded-* headers are
// dropped by Rewrite, and any client-sent X-Kasa-Tunnel is overwritten.
func buildProxy(target *url.URL, secret string, client func(*http.Request) string) http.Handler {
	return &httputil.ReverseProxy{
		Rewrite: func(r *httputil.ProxyRequest) {
			r.SetURL(target)
			r.Out.Host = r.In.Host
			r.Out.Header.Set("X-Kasa-Tunnel", secret)
			r.Out.Header.Set("X-Forwarded-For", client(r.In))
		},
	}
}

// clientAddrFromConn extracts the real client address from a connection
// accepted by a tsnet funnel listener: a *tls.Conn wrapping *ipn.FunnelConn.
func clientAddrFromConn(c net.Conn) (string, bool) {
	tc, ok := c.(*tls.Conn)
	if !ok {
		return "", false
	}
	fc, ok := tc.NetConn().(*ipn.FunnelConn)
	if !ok || !fc.Src.IsValid() {
		return "", false
	}
	return fc.Src.Addr().Unmap().String(), true
}
