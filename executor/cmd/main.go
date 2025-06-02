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

	bridgeToTac := tasks.NewBridgeToTacTask()
	bridgeToEth := tasks.NewBridgeToEthTask()

	if err := bridgeToTac.Run(ctx); err != nil {
		log.Printf("Initial run ton->tac failed: %v", err)
		panic(err)
	} else {
		log.Printf("Initial run ton->tac executed successfully")
	}

	if err := bridgeToEth.Run(ctx); err != nil {
		log.Printf("Initial run ton->eth failed: %v", err)
		panic(err)
	} else {
		log.Printf("Initial run ton->tac executed successfully")
	}

	ticker := time.NewTicker(10 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Println("Stopping scheduler")
			return

		case <-ticker.C:
			if err := bridgeToTac.Run(ctx); err != nil {
				log.Printf("Task ton->tac failed: %v", err)
			} else {
				log.Printf("ton->tac finished successfully")
			}

			if err := bridgeToEth.Run(ctx); err != nil {
				log.Printf("Task ton->eth failed: %v", err)
			} else {
				log.Printf("ton->eth finished successfully")
			}
		}
	}
}
