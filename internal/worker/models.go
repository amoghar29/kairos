package worker

import (
	"context"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

const lostClaimResult = "claim lost while executing: the job was reclaimed or finished elsewhere"

type InflightJob struct {
	Name      string             `json:"name"`
	ID        pgtype.UUID        `json:"id"`
	AttemptID pgtype.UUID        `json:"attempt_id"`
	Version   int32              `json:"version"`
	Queue     string             `json:"queue"`
	Handler   string             `json:"handler"`
	StartedAt time.Time          `json:"started_at"`
	Cancel    context.CancelFunc `json:"-"`
}

type RegistryEntry struct {
	Name      string        `json:"name"`
	ID        uuid.UUID     `json:"id"`
	Queues    []string      `json:"queues"`
	Handlers  []string      `json:"handlers"`
	InFlight  []InflightJob `json:"in_flight"`
	StartedAt time.Time     `json:"started_at"`
	LastSeen  time.Time     `json:"last_seen"`
}

func RegistryMatchPattern() string {
	return registryKeyPrefix + "*"
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
