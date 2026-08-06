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
	"github.com/joho/godotenv"
)

func main() {
	if err := run(); err != nil {
		// Also to stderr: the log file may be closed by now, or may be the thing that failed.
		fmt.Fprintf(os.Stderr, "api: exiting: %v\n", err)
		os.Exit(1)
	}
}
func run() (err error) {
	_ = godotenv.Load()

	apiConfig, err := config.LoadAPIConfig()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}

	logger, logFile, err := logging.New(apiConfig.Log.File)
	if err != nil {
		return fmt.Errorf("init logging: %w", err)
	}
	defer logFile.Close()

	defer func() {
		if err != nil {
			logger.Error("api exiting", slog.Any("error", err))
		}
	}()

	queues, err := config.LoadQueues()
	if err != nil {
		return fmt.Errorf("load queues: %w", err)
	}
	logger.Info("loaded queues", slog.Any("queues", queues))

	ctx := context.Background()

	dbPool, err := db.NewPool(ctx, apiConfig.Postgres)
	if err != nil {
		return fmt.Errorf("connect to database: %w", err)
	}
	defer dbPool.Close()
	logger.Info("connected to database", slog.Int("max_conns", int(apiConfig.Postgres.MaxConns)))

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

	logger.Info("starting server", slog.String("addr", srv.Addr))
	if err := srv.ListenAndServe(); err != nil {
		return fmt.Errorf("http server on %s: %w", srv.Addr, err)
	}
	return nil
}
