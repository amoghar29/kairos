package worker

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const lostClaimResult = "claim lost while executing: the job was reclaimed or finished elsewhere"

type InflightJob struct {
	Name      string
	ID        pgtype.UUID
	AttemptID pgtype.UUID
	Version   int32
	Queue     string
	Handler   string
	Cancel    context.CancelFunc `json:"-"`
}

type registryEntry struct {
	ID        uuid.UUID     `json:"id"`
	Queues    []string      `json:"queues"`
	InFlight  []InflightJob `json:"in_flight"`
	StartedAt time.Time     `json:"started_at"`
	LastSeen  time.Time     `json:"last_seen"`
}

type Job struct {
	ID         uuid.UUID
	Name       string
	Queue      string
	Handler    string
	Payload    []byte
	RetryCount int32
	MaxRetries int32
	Logs       *JobLogger
}

type HandlerFunc func(ctx context.Context, j Job) (string, error)
