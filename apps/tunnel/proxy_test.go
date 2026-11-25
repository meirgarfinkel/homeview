package main

import (
	"bufio"
	"crypto/tls"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"testing"

	"tailscale.com/ipn"
)

func mustURL(t *testing.T, raw string) *url.URL {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	return u
}

func TestProxySetsSecretAndReplacesForwardedFor(t *testing.T) {
	var gotSecret, gotFwd string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotSecret = r.Header.Get("X-Kasa-Tunnel")
		gotFwd = r.Header.Get("X-Forwarded-For")
	}))
	defer backend.Close()

	req := httptest.NewRequest("GET", "http://kasa.example/", nil)
	req.RemoteAddr = "203.0.113.9:5555"
	req.Header.Set("X-Kasa-Tunnel", "fake")
	req.Header.Set("X-Forwarded-For", "1.2.3.4")
	newProxy(mustURL(t, backend.URL), "s3cret").ServeHTTP(httptest.NewRecorder(), req)

	if gotSecret != "s3cret" {
		t.Errorf("secret = %q, want s3cret", gotSecret)
	}
	if gotFwd != "203.0.113.9" {
		t.Errorf("X-Forwarded-For = %q, want 203.0.113.9", gotFwd)
	}
}

func TestProxyKeepsHost(t *testing.T) {
	var gotHost string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotHost = r.Host
	}))
	defer backend.Close()

	req := httptest.NewRequest("GET", "http://kasa-home.tail1234.ts.net/", nil)
	newProxy(mustURL(t, backend.URL), "s").ServeHTTP(httptest.NewRecorder(), req)

	if gotHost != "kasa-home.tail1234.ts.net" {
		t.Errorf("Host = %q", gotHost)
	}
}

func TestProxyPassesWebSocketUpgrade(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			return
		}
		defer conn.Close()
		buf.WriteString("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")
		buf.Flush()
		io.Copy(conn, buf) // echo
	}))
	defer backend.Close()

	front := httptest.NewServer(newProxy(mustURL(t, backend.URL), "s"))
	defer front.Close()

	conn, err := net.Dial("tcp", front.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	io.WriteString(conn, "GET /ws HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n")

	br := bufio.NewReader(conn)
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 101 {
		t.Fatalf("status = %d, want 101", resp.StatusCode)
	}
	io.WriteString(conn, "ping\n")
	line, err := br.ReadString('\n')
	if err != nil || line != "ping\n" {
		t.Fatalf("echo = %q, err = %v", line, err)
	}
}

func TestFunnelProxyRefusesWithoutClientAddr(t *testing.T) {
	called := false
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	defer backend.Close()

	req := httptest.NewRequest("GET", "http://kasa.example/", nil)
	req.RemoteAddr = "100.64.0.1:443"
	rec := httptest.NewRecorder()
	newFunnelProxy(mustURL(t, backend.URL), "s").ServeHTTP(rec, req)

	if rec.Code != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", rec.Code)
	}
	if called {
		t.Error("backend was reached without a client address")
	}
}

func TestFunnelProxyForwardsClientAddrFromContext(t *testing.T) {
	var gotFwd string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotFwd = r.Header.Get("X-Forwarded-For")
	}))
	defer backend.Close()

	req := httptest.NewRequest("GET", "http://kasa.example/", nil)
	req.RemoteAddr = "100.64.0.1:443"
	req = req.WithContext(withClientAddr(req.Context(), "198.51.100.7"))
	newFunnelProxy(mustURL(t, backend.URL), "s").ServeHTTP(httptest.NewRecorder(), req)

	if gotFwd != "198.51.100.7" {
		t.Errorf("X-Forwarded-For = %q, want 198.51.100.7", gotFwd)
	}
}

func TestClientAddrFromConn(t *testing.T) {
	a, b := net.Pipe()
	defer a.Close()
	defer b.Close()

	if _, ok := clientAddrFromConn(a); ok {
		t.Error("plain conn reported a client address")
	}
	if _, ok := clientAddrFromConn(tls.Client(a, &tls.Config{})); ok {
		t.Error("tls conn over a non-funnel conn reported a client address")
	}
	if _, ok := clientAddrFromConn(tls.Client(&ipn.FunnelConn{Conn: a}, &tls.Config{})); ok {
		t.Error("funnel conn with no source reported a client address")
	}

	fc := &ipn.FunnelConn{Conn: a, Src: netip.MustParseAddrPort("[::ffff:203.0.113.9]:4444")}
	ip, ok := clientAddrFromConn(tls.Client(fc, &tls.Config{}))
	if !ok || ip != "203.0.113.9" {
		t.Errorf("got %q, %v; want 203.0.113.9, true", ip, ok)
	}
}
