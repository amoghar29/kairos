package worker

import (
	"strings"
	"sync/atomic"
	"unicode/utf8"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/jackc/pgx/v5/pgtype"
)

const (
	maxLogLineBytes = 4096
	truncatedSuffix = "...[truncated]"
)

type JobLogger struct {
	sink      *logSink
	attemptID pgtype.UUID
	seq       atomic.Int32
}

func newJobLogger(sink *logSink, attemptID pgtype.UUID) *JobLogger {
	return &JobLogger{sink: sink, attemptID: attemptID}
}

func (l *JobLogger) Log(level, line string) {
	l.sink.append(l.attemptID, l.seq.Add(1), toLogLevel(level), truncateLine(line))
}

func toLogLevel(level string) db.LogLevel {
	lvl := db.LogLevel(strings.ToLower(strings.TrimSpace(level)))
	if lvl == "warn" {
		return db.LogLevelWarning
	}
	if !lvl.Valid() {
		return db.LogLevelInfo
	}
	return lvl
}

func truncateLine(line string) string {
	if len(line) <= maxLogLineBytes {
		return line
	}
	cut := maxLogLineBytes
	for cut > 0 && !utf8.RuneStart(line[cut]) {
		cut--
	}
	return line[:cut] + truncatedSuffix
}
