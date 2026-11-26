package main

import (
	"context"
	"errors"
	"io"
	"testing"
	"time"
)

func TestCancelOnEOFCancelsWhenTheParentClosesStdin(t *testing.T) {
	r, w := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cancelOnEOF(r, cancel)

	if _, err := w.Write([]byte("anything the parent writes is ignored\n")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-ctx.Done():
		t.Fatal("cancelled while stdin was still open")
	case <-time.After(50 * time.Millisecond):
	}

	w.Close()
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("not cancelled after stdin closed")
	}
}

func TestCancelOnEOFCancelsWhenStdinFails(t *testing.T) {
	r, w := io.Pipe()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go cancelOnEOF(r, cancel)
	w.CloseWithError(errors.New("broken pipe"))
	select {
	case <-ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("not cancelled after stdin failed")
	}
}

// states plays back node states, then repeats the last one.
func states(seq ...string) func(context.Context) (string, error) {
	i := 0
	return func(context.Context) (string, error) {
		s := seq[min(i, len(seq)-1)]
		i++
		return s, nil
	}
}

func TestWatchBackendReportsWhenTailscaleStops(t *testing.T) {
	err := watchBackend(context.Background(), states("Running", "Running", "NeedsLogin"), time.Millisecond)
	if !errors.Is(err, errTailscaleStopped) {
		t.Fatalf("err = %v, want errTailscaleStopped", err)
	}
	if err.Error() != "The Tailscale connection stopped. Sign in again." {
		t.Errorf("message = %q", err.Error())
	}
}

func TestWatchBackendKeepsGoingThroughStatusErrors(t *testing.T) {
	calls := 0
	state := func(context.Context) (string, error) {
		calls++
		if calls < 3 {
			return "", errors.New("busy")
		}
		return "Stopped", nil
	}
	if err := watchBackend(context.Background(), state, time.Millisecond); !errors.Is(err, errTailscaleStopped) {
		t.Fatalf("err = %v, want errTailscaleStopped", err)
	}
}

func TestWatchBackendReturnsNilWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	if err := watchBackend(ctx, states("Running"), time.Millisecond); err != nil {
		t.Fatalf("err = %v, want nil", err)
	}
}
