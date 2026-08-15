package worker

import (
	"sync"
	"time"

	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/jackc/pgx/v5/pgtype"
)

type logSink struct {
	mu      sync.Mutex
	lines   []job.LogLine
	dropped int
	wake    chan struct{}

	flushThreshold int
	capacity       int
}

func newLogSink(flushThreshold, capacity int) *logSink {
	return &logSink{
		lines:          make([]job.LogLine, 0, flushThreshold),
		wake:           make(chan struct{}, 1),
		flushThreshold: flushThreshold,
		capacity:       capacity,
	}
}

func (s *logSink) append(attemptID pgtype.UUID, seq int32, level db.LogLevel, line string) {
	entry := job.LogLine{
		AttemptID: attemptID,
		Seq:       seq,
		Level:     level,
		Line:      line,
		CreatedAt: pgtype.Timestamptz{Time: time.Now().UTC(), Valid: true},
	}

	s.mu.Lock()
	if len(s.lines) >= s.capacity {
		s.dropped++
		s.mu.Unlock()
		return
	}
	s.lines = append(s.lines, entry)
	full := len(s.lines) >= s.flushThreshold
	s.mu.Unlock()

	if full {
		select {
		case s.wake <- struct{}{}:
		default:
		}
	}
}

func (s *logSink) drain() ([]job.LogLine, int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.lines) == 0 && s.dropped == 0 {
		return nil, 0
	}
	lines, dropped := s.lines, s.dropped
	s.lines = make([]job.LogLine, 0, s.flushThreshold)
	s.dropped = 0

	return lines, dropped
}
