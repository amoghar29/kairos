package api

import (
	"encoding/json"
	"log/slog"
	"net/http"
)

type ErrorResponse struct {
	Message string            `json:"message"`
	Code    string            `json:"code"`
	Fields  map[string]string `json:"fields,omitempty"`
}

const (
	CodeInvalidJSON          = "invalid_json"
	CodeValidationFailed     = "validation_failed"
	CodeIdempotencyCollision = "idempotency_collision"
	CodeNotFound             = "not_found"
	CodeConflict             = "conflict"
	CodeInternal             = "internal_error"
)


func (app *Application) writeJSON(w http.ResponseWriter, r *http.Request, status int, data any) {
	body, err := json.Marshal(data)
	if err != nil {
		app.logger(r).Error("failed to marshal response", slog.Any("error", err))
		w.WriteHeader(http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if _, err := w.Write(body); err != nil {
		app.logger(r).Warn("failed to write response body", slog.Any("error", err))
	}
}

func (app *Application) writeError(w http.ResponseWriter, r *http.Request, status int, code, message string, fields map[string]string) {
	app.writeJSON(w, r, status, ErrorResponse{Message: message, Code: code, Fields: fields})
}

func (app *Application) badRequest(w http.ResponseWriter, r *http.Request, message string) {
	app.writeError(w, r, http.StatusBadRequest, CodeInvalidJSON, message, nil)
}

func (app *Application) failedValidation(w http.ResponseWriter, r *http.Request, fields map[string]string) {
	app.writeError(w, r, http.StatusUnprocessableEntity, CodeValidationFailed, "the request body failed validation", fields)
}

func (app *Application) notFound(w http.ResponseWriter, r *http.Request) {
	app.writeError(w, r, http.StatusNotFound, CodeNotFound, "the requested resource could not be found", nil)
}

func (app *Application) conflict(w http.ResponseWriter, r *http.Request, message string) {
	app.writeError(w, r, http.StatusConflict, CodeConflict, message, nil)
}

func (app *Application) idempotencyCollision(w http.ResponseWriter, r *http.Request) {
	app.writeError(w, r, http.StatusConflict, CodeIdempotencyCollision,
		"a different job already exists with this idempotency key", nil)
}


func (app *Application) serverError(w http.ResponseWriter, r *http.Request, err error) {
	app.logger(r).Error("internal server error", slog.Any("error", err))
	app.writeError(w, r, http.StatusInternalServerError, CodeInternal, "the server encountered a problem", nil)
}
