package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

func (app *Application) Routes() http.Handler {
	r := chi.NewRouter()
	r.Use(middleware.RequestID)
	r.Use(middleware.RealIP)
	r.Use(app.requestLogger)
	r.Use(middleware.Recoverer)

	r.NotFound(app.notFound)
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		app.writeError(w, r, http.StatusMethodNotAllowed, CodeNotFound, "method not allowed for this resource", nil)
	})

	r.Get("/healthz", app.Healthcheck)

	r.Route("/v1/jobs", func(r chi.Router) {
		r.Post("/", app.CreateJob)
		r.Get("/", app.ListJobs)

		r.Route("/{id}", func(r chi.Router) {
			r.Get("/", app.GetJob)
			r.Delete("/", app.DeleteJob)
			r.Post("/cancel", app.CancelJob)
			r.Post("/rerun", app.RerunJob)
			r.Get("/attempts", app.ListJobAttempts)
		})
	})

	return r
}
