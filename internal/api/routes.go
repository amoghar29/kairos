package api

import (
	"net/http"

	"github.com/amoghar29/kairos/internal/dashboard"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func (app *Application) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(corsMiddleware)
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(app.requestLogger)
	r.Use(middleware.Recoverer)

	r.NotFound(app.notFound)
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		app.writeError(w, r, http.StatusMethodNotAllowed, CodeNotFound, "method not allowed for this resource", nil)
	})

	r.Route("/api", func(r chi.Router) {
		r.Route("/v1", func(r chi.Router) {
			r.Get("/healthz", app.Healthcheck)
			r.Get("/queues", app.ListQueues)
			r.Get("/workers", app.ListWorkers)
			r.Route("/handlers", func(r chi.Router) {
				r.Get("/", app.ListHandlers)
				r.Get("/{name}", app.GetHandler)
			})
			r.Route("/jobs", func(r chi.Router) {
				r.Post("/", app.CreateJob)
				r.Get("/", app.ListJobs)
				r.Get("/attempts", app.ListAttempts)

				r.Route("/{id}", func(r chi.Router) {
					r.Get("/", app.GetJob)
					r.Delete("/", app.DeleteJob)
					r.Post("/cancel", app.CancelJob)
					r.Post("/rerun", app.RerunJob)
					r.Post("/pause", app.PauseJob)
					r.Post("/schedule", app.RescheduleJob)
					r.Post("/reschedule", app.RescheduleJob)
					r.Route("/attempts", func(r chi.Router) {
						r.Get("/", app.ListJobAttempts)
						r.Get("/{attemptID}/logs", app.ListAttemptLogs)
					})
				})
			})
		})
	})

	r.Handle("/*", dashboard.Handler())

	return r
}
