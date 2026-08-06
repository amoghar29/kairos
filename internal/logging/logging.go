package logging

import (
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
)

func New(path string) (*slog.Logger, io.Closer, error) {
	out, closer, err := open(path)
	if err != nil {
		return nil, nil, err
	}

	var handler slog.Handler
	if path == "" {
		handler = slog.NewTextHandler(out, &slog.HandlerOptions{
			Level: slog.LevelDebug,
		})
	} else {
		handler = slog.NewJSONHandler(out, &slog.HandlerOptions{
			Level: slog.LevelInfo,
		})
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)
	return logger, closer, nil
}

func open(path string) (io.Writer, io.Closer, error) {
	if path == "" {
		return os.Stdout, nopCloser{}, nil
	}

	if dir := filepath.Dir(path); dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, fmt.Errorf("creating log directory %s: %w", dir, err)
		}
	}

	file, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, nil, fmt.Errorf("opening log file %s: %w", path, err)
	}
	return file, file, nil
}

type nopCloser struct{}

func (nopCloser) Close() error { return nil }
