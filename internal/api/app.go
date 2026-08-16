package api

import (
	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/dashboard"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/go-chi/chi/v5/middleware"
	"log/slog"
	"net/http"
)

type Application struct {
	Config              *config.Config
	Queues              config.Queues
	Logger              *slog.Logger
	JobRepository       *job.Repository
	DashboardRepository *dashboard.Repository
}

func (app *Application) logger(r *http.Request) *slog.Logger {
	return app.Logger.With(
		slog.String("request_id", middleware.GetReqID(r.Context())),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
	)
}
