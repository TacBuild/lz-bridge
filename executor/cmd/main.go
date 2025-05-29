package main

import (
	"context"
	"executor/tasks"
	"log"
	"time"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	bridge := tasks.NewBridgeTask()

	if err := bridge.Run(ctx); err != nil {
		log.Printf("Initial run failed: %v", err)
	}

	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("Stopping scheduler")
			return

		case <-ticker.C:
			if err := bridge.Run(ctx); err != nil {
				log.Printf("Task failed: %v", err)
			}
		}
	}
}
