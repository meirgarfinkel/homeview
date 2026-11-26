package main

import (
	"encoding/json"
	"os"
	"sync"
)

type event struct {
	Type    string `json:"type"`
	URL     string `json:"url,omitempty"`
	Message string `json:"message,omitempty"`
}

var (
	emitMu  sync.Mutex
	emitter = json.NewEncoder(os.Stdout)
)

// emit writes one JSON line to stdout. Human logs go to stderr only.
func emit(e event) {
	emitMu.Lock()
	defer emitMu.Unlock()
	_ = emitter.Encode(e)
}
