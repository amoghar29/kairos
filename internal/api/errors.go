package api

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"github.com/amoghar29/kairos/models"
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
	app.writeJSON(w, r, status, models.ErrorResponse{Message: message, Code: code, Fields: fields})
}

func (app *Application) badRequest(w http.ResponseWriter, r *http.Request, message string) {
	app.writeError(w, r, http.StatusBadRequest, models.CodeInvalidJSON, message, nil)
}

func (app *Application) failedValidation(w http.ResponseWriter, r *http.Request, fields map[string]string) {
	app.writeError(w, r, http.StatusUnprocessableEntity, models.CodeValidationFailed, "the request body failed validation", fields)
}

func (app *Application) notFound(w http.ResponseWriter, r *http.Request) {
	app.writeError(w, r, http.StatusNotFound, models.CodeNotFound, "the requested resource could not be found", nil)
}

func (app *Application) conflict(w http.ResponseWriter, r *http.Request, message string) {
	app.writeError(w, r, http.StatusConflict, models.CodeConflict, message, nil)
}

func (app *Application) serverError(w http.ResponseWriter, r *http.Request, err error) {
	app.logger(r).Error("internal server error", slog.Any("error", err))
	app.writeError(w, r, http.StatusInternalServerError, models.CodeInternal, "the server encountered a problem", nil)
}
