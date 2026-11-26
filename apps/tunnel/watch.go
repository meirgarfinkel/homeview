package main

import (
	"context"
	"errors"
	"io"
	"time"
)

// errTailscaleStopped is shown to the user as is, so it reads as plain copy.
var errTailscaleStopped = errors.New("The Tailscale connection stopped. Sign in again.")

// cancelOnEOF reads r until it ends or fails, then calls cancel. The parent
// holds the other end of stdin and never writes to it, so stdin ends exactly
// when the parent goes away, even after a crash or a force quit.
func cancelOnEOF(r io.Reader, cancel func()) {
	_, _ = io.Copy(io.Discard, r)
	cancel()
}

// watchBackend asks for the node's state every so often and returns
// errTailscaleStopped once it is no longer Running, for example after the
// node key expires or the machine is removed from the tailnet. It returns nil
// when ctx ends. A failed status check is skipped and tried again next time.
func watchBackend(ctx context.Context, state func(context.Context) (string, error), every time.Duration) error {
	tick := time.NewTicker(every)
	defer tick.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-tick.C:
		}
		s, err := state(ctx)
		if err != nil {
			continue
		}
		if s != "Running" {
			return errTailscaleStopped
		}
	}
}
