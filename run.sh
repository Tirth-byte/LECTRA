#!/bin/bash

# Start Docker containers
echo "Starting LiveKit, Redis, and Postgres via Docker Compose..."
docker compose up -d

# Start backend
echo "Starting Backend API..."
cd backend
source venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000 &
BACKEND_PID=$!

# Start frontend
echo "Starting Frontend Next.js app..."
cd ../frontend
npm run dev &
FRONTEND_PID=$!

echo "Lectra is running!"
echo "Frontend: http://localhost:3000"
echo "Backend: http://localhost:8000"
echo "Press Ctrl+C to stop all services."

trap "kill $BACKEND_PID; kill $FRONTEND_PID; docker compose down" SIGINT
wait
