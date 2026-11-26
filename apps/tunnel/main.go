// Command kasa-tunnel publishes a local Kasa Home server through Tailscale
// Funnel. It talks to its parent over JSON lines on stdout.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/tsnet"
)

var version = "dev"

const (
	pollEvery       = 2 * time.Second
	watchEvery      = 10 * time.Second
	loginURLWait    = 10 * time.Second
	exitUsage       = 2
	exitFatal       = 1
	funnelListen    = ":443"
	secretEnvVar    = "KASA_TUNNEL_SECRET"
	defaultHostname = "kasa-home"
)

func main() {
	stateDir := flag.String("state-dir", "", "directory for Tailscale state")
	target := flag.String("target", "", "backend to forward to, as host:port")
	hostname := flag.String("hostname", defaultHostname, "Tailscale machine name")
	showVersion := flag.Bool("version", false, "print the version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println("kasa-tunnel " + version)
		return
	}

	secret := os.Getenv(secretEnvVar)
	if secret == "" {
		fmt.Fprintln(os.Stderr, secretEnvVar+" is required")
		os.Exit(exitUsage)
	}
	if *stateDir == "" || *target == "" {
		fmt.Fprintln(os.Stderr, "--state-dir and --target are required")
		os.Exit(exitUsage)
	}

	if err := run(*stateDir, *target, *hostname, secret); err != nil {
		emit(event{Type: "error", Message: err.Error()})
		fmt.Fprintln(os.Stderr, "kasa-tunnel:", err)
		os.Exit(exitFatal)
	}
}

func run(stateDir, target, hostname, secret string) error {
	targetURL, err := url.Parse("http://" + target)
	if err != nil {
		return fmt.Errorf("bad --target: %w", err)
	}

	logf := log.New(os.Stderr, "", log.LstdFlags).Printf
	srv := &tsnet.Server{Hostname: hostname, Dir: stateDir, Logf: logf, UserLogf: logf}
	defer srv.Close()

	sigCtx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithCancelCause(sigCtx)
	defer cancel(nil)
	// The parent keeps stdin open while it runs. Its end closing means it is
	// gone, so stop rather than hold the Funnel for a dead server.
	go cancelOnEOF(os.Stdin, func() { cancel(nil) })

	if err := srv.Start(); err != nil {
		return fmt.Errorf("start tailscale: %w", err)
	}

	lc, err := srv.LocalClient()
	if err != nil {
		return fmt.Errorf("local client: %w", err)
	}
	dnsName, err := waitUntilReady(ctx, lc)
	if err != nil {
		if ctx.Err() != nil {
			return nil
		}
		return err
	}

	ln, err := srv.ListenFunnel("tcp", funnelListen, tsnet.FunnelOnly())
	if err != nil {
		return fmt.Errorf("listen on funnel: %w", err)
	}
	emit(event{Type: "ready", URL: "https://" + dnsName})

	go func() {
		state := func(ctx context.Context) (string, error) {
			st, err := lc.Status(ctx)
			if err != nil {
				return "", err
			}
			return st.BackendState, nil
		}
		if err := watchBackend(ctx, state, watchEvery); err != nil {
			cancel(err)
		}
	}()

	// No WriteTimeout: it would cut off the live view's WebSocket.
	httpSrv := &http.Server{
		Handler:           newFunnelProxy(targetURL, secret),
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
		ConnContext: func(ctx context.Context, c net.Conn) context.Context {
			if ip, ok := clientAddrFromConn(c); ok {
				return withClientAddr(ctx, ip)
			}
			return ctx
		},
	}
	go func() {
		<-ctx.Done()
		httpSrv.Close()
	}()
	if err := httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		if ctx.Err() == nil {
			return fmt.Errorf("serve: %w", err)
		}
	}
	if cause := context.Cause(ctx); errors.Is(cause, errTailscaleStopped) {
		return cause
	}
	return nil
}

// waitUntilReady polls the node until it is signed in and Funnel is enabled,
// emitting login and enable URLs for the user as they appear. It returns the
// node's DNS name without the trailing dot.
func waitUntilReady(ctx context.Context, lc *local.Client) (string, error) {
	var (
		started      = time.Now()
		sawLoginURL  = ""
		sawEnableURL = ""
		interactive  = false
	)
	tick := time.NewTicker(pollEvery)
	defer tick.Stop()
	for {
		st, err := lc.Status(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			return "", fmt.Errorf("status: %w", err)
		}
		switch st.BackendState {
		case "NeedsLogin":
			if st.AuthURL != "" {
				if st.AuthURL != sawLoginURL {
					sawLoginURL = st.AuthURL
					emit(event{Type: "login", URL: st.AuthURL})
				}
			} else if !interactive && time.Since(started) > loginURLWait {
				interactive = true
				if err := lc.StartLoginInteractive(ctx); err != nil {
					return "", fmt.Errorf("start login: %w", err)
				}
			}
		case "Running":
			qf, err := lc.QueryFeature(ctx, "funnel")
			if err != nil {
				return "", fmt.Errorf("query funnel: %w", err)
			}
			if qf.Complete && st.Self != nil {
				return strings.TrimSuffix(st.Self.DNSName, "."), nil
			}
			if qf.URL != "" && qf.URL != sawEnableURL {
				sawEnableURL = qf.URL
				emit(event{Type: "enable", URL: qf.URL})
			}
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-tick.C:
		}
	}
}
