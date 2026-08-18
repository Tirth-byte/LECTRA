# Lectra

Lectra is a modern open-source classroom screen-broadcasting platform. Designed for physical classrooms where a faculty member demonstrates code and students follow on their own laptops.

## Architecture

- **Frontend**: Next.js (App Router), Tailwind CSS, LiveKit Components React
- **Backend**: FastAPI, SQLAlchemy (PostgreSQL), Redis (SSE Pub/Sub), LiveKit Server SDK
- **Infrastructure**: LiveKit Server, Redis, PostgreSQL (via Docker Compose)

## Getting Started

1. **Start the Infrastructure**
   ```bash
   docker compose up -d
   ```
   This starts the PostgreSQL database, Redis instance, and the LiveKit Server.

2. **Run the Backend (FastAPI)**
   ```bash
   cd backend
   python3 -m venv venv
   source venv/bin/activate
   pip install -r requirements.txt # (or use the installed env)
   uvicorn main:app --host 0.0.0.0 --port 8000
   ```

3. **Run the Frontend (Next.js)**
   ```bash
   cd frontend
   npm run dev
   ```

4. **Access the App**
   Open [http://localhost:3000](http://localhost:3000) in your browser.

## Features

- **Minimalist Interface**: No unnecessary meeting features. Built specifically for screen broadcasting.
- **High Quality**: 1080p optimized for code and text readability.
- **Focus Mode**: Transparent page presence tracking to show when students switch away from the viewer.
- **Real-Time Faculty Dashboard**: Live feed of student presence, beautiful notifications, and quick metrics.
- **Session Summaries**: Simple overview after a lecture ends.

## Design Philosophy
> Meet is designed for everyone to participate. Lectra is designed for everyone to follow one instructor.
