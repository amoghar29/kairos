package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/amoghar29/kairos/internal/api"
	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/db"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/amoghar29/kairos/internal/logging"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func main() {
	if err := run(); err != nil {
		slog.Error("startup failed", slog.Any("error", err))
		os.Exit(1)
	}
}
func run() error {
	_ = godotenv.Load()

	apiConfig, err := config.LoadAPIConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger := logging.New(apiConfig.IsDevelopment())

	queues, err := config.LoadQueues()
	if err != nil {
		return fmt.Errorf("load queues: %w", err)
	}
	logger.Info("loaded queues", slog.Any("queues", queues))

	ctx := context.Background()

	dbPool, err := pgxpool.New(ctx, apiConfig.DBDSN)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer dbPool.Close()

	if err := dbPool.Ping(ctx); err != nil {
		return fmt.Errorf("ping database: %w", err)
	}
	logger.Info("connected to database")

	app := &api.Application{
		Config:        apiConfig,
		Queues:        queues,
		Logger:        logger,
		JobRepository: job.NewJobRepository(db.New(dbPool)),
	}

	srv := &http.Server{
		Addr:         fmt.Sprintf(":%d", apiConfig.Port),
		Handler:      app.Routes(),
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  time.Minute,
		ErrorLog:     slog.NewLogLogger(logger.Handler(), slog.LevelError),
	}

	logger.Info("starting server",
		slog.String("addr", srv.Addr),
		slog.String("env", apiConfig.Env),
	)
	return srv.ListenAndServe()
}
