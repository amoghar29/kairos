package cron

import (
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/robfig/cron/v3"
)

func ValidateExpression(expr string) error {
	if _, err := cron.ParseStandard(expr); err != nil {
		return fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}
	return nil
}


func NextRun(expr string, after pgtype.Timestamptz) (pgtype.Timestamptz, error) {
	schedule, err := cron.ParseStandard(expr)
	if err != nil {
		return pgtype.Timestamptz{}, fmt.Errorf("invalid cron expression %q: %w", expr, err)
	}

	from := time.Now().UTC()
	if after.Valid {
		from = after.Time.UTC()
	}

	next := schedule.Next(from)
	if next.IsZero() {
		return pgtype.Timestamptz{}, nil
	}
	return pgtype.Timestamptz{Time: next, Valid: true}, nil
}
