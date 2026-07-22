package main

import (
	"os"
	"log"
	"github.com/go-chi/chi/v5"
	"github.com/joho/godotenv"
	"net/http"
)



func main() {

	godotenv.Load()
	port := os.Getenv("PORT")

	if port == "" {
		log.Fatal("PORT environment variable is not set")
	}

	main_router := chi.NewRouter()

	server := &http.Server{
		Addr:    ":" + port,
		Handler: main_router,
	}
	err := server.ListenAndServe()
	if err != nil {
		log.Fatal("Failed to start server:", err)
	}
}