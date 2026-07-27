package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/amoghar29/kairos/internal/job"
	"github.com/go-chi/chi/v5"
	"github.com/jackc/pgx/v5/pgtype"
)

const maxRequestBody = 1 << 20 


func decodeBody(w http.ResponseWriter, r *http.Request, dst any) error {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBody)
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()

	if err := dec.Decode(dst); err != nil {
		return err
	}
	if err := dec.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("body must contain a single JSON object")
	}
	return nil
}

func jobIDFromURL(r *http.Request) (pgtype.UUID, error) {
	var id pgtype.UUID
	err := id.Scan(chi.URLParam(r, "id"))
	return id, err
}

func (app *Application) CreateJob(w http.ResponseWriter, r *http.Request) {
	var req CreateJobRequest
	if err := decodeBody(w, r, &req); err != nil {
		app.badRequest(w, r, err.Error())
		return
	}

	if fields := req.Validate(app.Queues); fields != nil {
		app.failedValidation(w, r, fields)
		return
	}

	created, isNew, err := app.JobRepository.Create(r.Context(), req.ToParams(app.Queues))
	switch {
	case errors.Is(err, job.ErrIdempotencyCollision):
		app.idempotencyCollision(w, r)
		return
	case err != nil:
		app.serverError(w, r, err)
		return
	}

	status := http.StatusOK
	if isNew {
		status = http.StatusCreated
	}
	app.writeJSON(w, r, status, NewJobResponse(created))
}

func (app *Application) GetJob(w http.ResponseWriter, r *http.Request) {
	id, err := jobIDFromURL(r)
	if err != nil {
		app.badRequest(w, r, "id must be a valid UUID")
		return
	}

	found, err := app.JobRepository.GetByID(r.Context(), id)
	switch {
	case errors.Is(err, job.ErrNotFound):
		app.notFound(w, r)
		return
	case err != nil:
		app.serverError(w, r, err)
		return
	}

	app.writeJSON(w, r, http.StatusOK, NewJobResponse(found))
}

func (app *Application) ListJobs(w http.ResponseWriter, r *http.Request) {
	page, fields := parsePagination(r)
	if fields != nil {
		app.failedValidation(w, r, fields)
		return
	}

	jobs, err := app.JobRepository.List(r.Context(), page.Limit, page.Offset)
	if err != nil {
		app.serverError(w, r, err)
		return
	}

	app.writeJSON(w, r, http.StatusOK, ListResponse[JobResponse]{
		Items:  mapSlice(jobs, NewJobResponse),
		Limit:  page.Limit,
		Offset: page.Offset,
	})
}

func (app *Application) DeleteJob(w http.ResponseWriter, r *http.Request) {
	id, err := jobIDFromURL(r)
	if err != nil {
		app.badRequest(w, r, "id must be a valid UUID")
		return
	}

	switch err := app.JobRepository.Delete(r.Context(), id); {
	case errors.Is(err, job.ErrNotFound):
		app.notFound(w, r)
		return
	case err != nil:
		app.serverError(w, r, err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (app *Application) CancelJob(w http.ResponseWriter, r *http.Request) {
	id, err := jobIDFromURL(r)
	if err != nil {
		app.badRequest(w, r, "id must be a valid UUID")
		return
	}

	var req CancelJobRequest
	if err := decodeBody(w, r, &req); err != nil {
		app.badRequest(w, r, err.Error())
		return
	}
	if fields := req.Validate(); fields != nil {
		app.failedValidation(w, r, fields)
		return
	}

	cancelled, err := app.JobRepository.Cancel(r.Context(), id, req.Version)
	switch {
	case errors.Is(err, job.ErrNotFound):
		app.notFound(w, r)
		return
	case errors.Is(err, job.ErrConflict):
		app.conflict(w, r, "job was modified by another request or is no longer cancellable")
		return
	case err != nil:
		app.serverError(w, r, err)
		return
	}

	app.writeJSON(w, r, http.StatusOK, NewJobResponse(cancelled))
}

func (app *Application) ListJobAttempts(w http.ResponseWriter, r *http.Request) {
	id, err := jobIDFromURL(r)
	if err != nil {
		app.badRequest(w, r, "id must be a valid UUID")
		return
	}

	page, fields := parsePagination(r)
	if fields != nil {
		app.failedValidation(w, r, fields)
		return
	}

	if _, err := app.JobRepository.GetByID(r.Context(), id); err != nil {
		if errors.Is(err, job.ErrNotFound) {
			app.notFound(w, r)
		} else {
			app.serverError(w, r, err)
		}
		return
	}

	attempts, err := app.JobRepository.ListAttempts(r.Context(), id, page.Limit, page.Offset)
	if err != nil {
		app.serverError(w, r, err)
		return
	}

	app.writeJSON(w, r, http.StatusOK, ListResponse[JobAttemptResponse]{
		Items:  mapSlice(attempts, NewJobAttemptResponse),
		Limit:  page.Limit,
		Offset: page.Offset,
	})
}

func (app *Application) Healthcheck(w http.ResponseWriter, r *http.Request) {
	app.writeJSON(w, r, http.StatusOK, map[string]string{"status": "available"})
}
func mapSlice[In any, Out any](in []In, fn func(In) Out) []Out {
	out := make([]Out, 0, len(in))
	for _, v := range in {
		out = append(out, fn(v))
	}
	return out
}
