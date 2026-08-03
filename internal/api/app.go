package api

import (
	"log/slog"
	"net/http"
	"github.com/amoghar29/kairos/internal/config"
	"github.com/amoghar29/kairos/internal/job"
	"github.com/go-chi/chi/v5/middleware"
)

type Application struct {
	Config        *config.Config
	Queues        *config.Queues
	Logger        *slog.Logger
	JobRepository *job.JobRepository
}
func (app *Application) logger(r *http.Request) *slog.Logger {
	return app.Logger.With(
		slog.String("request_id", middleware.GetReqID(r.Context())),
		slog.String("method", r.Method),
		slog.String("path", r.URL.Path),
	)
}
