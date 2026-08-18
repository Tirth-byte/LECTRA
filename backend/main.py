import os
import uuid
import random
import string
import json
import asyncio
import datetime
from typing import List, Dict, Optional

from fastapi import FastAPI, Depends, HTTPException, Request, BackgroundTasks
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
import redis.asyncio as redis
from dotenv import load_dotenv

load_dotenv()

from database import engine, Base, get_db, SessionLocal
import models, schemas
from livekit.api import AccessToken, VideoGrants

# Init DB
models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Lectra API")

FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:3000")
allow_origins = [url.strip() for url in FRONTEND_URL.split(",") if url.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
def health_check():
    return {"status": "ok"}

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "lectra_super_secret_key_1234567890_!")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
redis_client = redis.from_url(REDIS_URL)

def generate_short_code(length=6):
    return ''.join(random.choices(string.ascii_uppercase + string.digits, k=length))

def save_activity_bg(lecture_id: str, student_id: str, student_name: str, event_type: str, reason: Optional[str] = None):
    db = SessionLocal()
    try:
        activity = models.SessionActivity(
            lecture_id=lecture_id, 
            student_id=student_id, 
            student_name=student_name, 
            event_type=event_type,
            reason=reason
        )
        db.add(activity)
        db.commit()
    finally:
        db.close()

@app.post("/api/lectures", response_model=schemas.LectureResponse)
def create_lecture(lecture: schemas.LectureCreate, db: Session = Depends(get_db)):
    lecture_id = generate_short_code()
    faculty_id = str(uuid.uuid4())
    db_lecture = models.Lecture(id=lecture_id, faculty_id=faculty_id, title=lecture.title)
    db.add(db_lecture)
    db.commit()
    db.refresh(db_lecture)
    return db_lecture

@app.get("/api/lectures/{lecture_id}/token")
def get_faculty_token(lecture_id: str, faculty_id: str, db: Session = Depends(get_db)):
    db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
    if not db_lecture or db_lecture.faculty_id != faculty_id:
        raise HTTPException(status_code=404, detail="Lecture not found or unauthorized")
    
    grant = VideoGrants(room=lecture_id, room_join=True, can_publish=True, can_subscribe=True, room_admin=True)
    access_token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    access_token.with_identity(f"faculty-{faculty_id}").with_name("Faculty").with_grants(grant)
    return {"token": access_token.to_jwt()}

heartbeats: Dict[str, Dict[str, dict]] = {}

@app.post("/api/lectures/{lecture_id}/join", response_model=schemas.JoinResponse)
async def join_lecture(lecture_id: str, student: schemas.StudentJoin, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    def check_lecture():
        return db.query(models.Lecture).filter(models.Lecture.id == lecture_id, models.Lecture.status != "ENDED").first()
    db_lecture = await run_in_threadpool(check_lecture)
    
    if not db_lecture:
        raise HTTPException(status_code=404, detail="Active lecture not found")
    
    student_id = str(uuid.uuid4())
    grant = VideoGrants(room=lecture_id, room_join=True, can_publish=False, can_subscribe=True)
    access_token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    access_token.with_identity(f"student-{student_id}").with_name(student.name).with_grants(grant)
    
    if lecture_id not in heartbeats:
        heartbeats[lecture_id] = {}
    heartbeats[lecture_id][student_id] = {
        "name": student.name,
        "last_seen": datetime.datetime.utcnow().timestamp(),
        "disconnected": False,
        "state": "JOIN"
    }
    
    background_tasks.add_task(save_activity_bg, lecture_id, student_id, student.name, "JOIN")
    
    now_iso = datetime.datetime.utcnow().isoformat()
    event_data = {"type": "JOIN", "student_id": student_id, "student_name": student.name, "timestamp": now_iso}
    await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data))
    
    return {"token": access_token.to_jwt(), "student_id": student_id, "lecture_id": lecture_id}

async def monitor_heartbeats():
    while True:
        await asyncio.sleep(2)
        now = datetime.datetime.utcnow().timestamp()
        for lecture_id, students in list(heartbeats.items()):
            for student_id, data in list(students.items()):
                if not data.get("disconnected") and (now - data["last_seen"] > 8):
                    data["disconnected"] = True
                    event_data = {
                        "type": "DISCONNECTED", 
                        "student_id": student_id, 
                        "student_name": data["name"], 
                        "timestamp": datetime.datetime.utcnow().isoformat()
                    }
                    await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data))

@app.on_event("startup")
async def startup_event():
    asyncio.create_task(monitor_heartbeats())

@app.post("/api/lectures/{lecture_id}/heartbeat")
async def handle_heartbeat(lecture_id: str, student_id: str, payload: schemas.HeartbeatPayload, db: Session = Depends(get_db)):
    if lecture_id not in heartbeats:
        heartbeats[lecture_id] = {}
        
    student_data = heartbeats[lecture_id].get(student_id)
    now = datetime.datetime.utcnow().timestamp()
    now_iso = datetime.datetime.utcnow().isoformat()
    
    if not student_data:
        def get_name():
            last = db.query(models.SessionActivity).filter(models.SessionActivity.lecture_id == lecture_id, models.SessionActivity.student_id == student_id).order_by(models.SessionActivity.timestamp.desc()).first()
            return last.student_name if last else "Unknown"
        student_name = await run_in_threadpool(get_name)
        student_data = {"name": student_name, "disconnected": False, "state": payload.state}
    
    was_disconnected = student_data.get("disconnected", False)
    student_data["last_seen"] = now
    student_data["disconnected"] = False
    student_data["state"] = payload.state
    
    if was_disconnected:
        event_data_recon = {"type": "RECONNECTED", "student_id": student_id, "student_name": student_data["name"], "timestamp": now_iso}
        await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data_recon))
        
        event_data_state = {"type": payload.state, "student_id": student_id, "student_name": student_data["name"], "timestamp": now_iso}
        await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data_state))
        
    heartbeats[lecture_id][student_id] = student_data
    return {"status": "ok"}

@app.post("/api/lectures/{lecture_id}/presence")
async def update_presence(lecture_id: str, student_id: str, event: schemas.PresenceEvent, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    student_data = heartbeats.get(lecture_id, {}).get(student_id)
    
    if student_data:
        student_name = student_data.get("name", "Unknown")
        if student_data.get("state") == event.event_type.upper():
            return {"status": "ignored_duplicate"}
        student_data["state"] = event.event_type.upper()
    else:
        def get_name():
            last = db.query(models.SessionActivity).filter(models.SessionActivity.lecture_id == lecture_id, models.SessionActivity.student_id == student_id).order_by(models.SessionActivity.timestamp.desc()).first()
            return last.student_name if last else "Unknown Student"
        student_name = await run_in_threadpool(get_name)
        if lecture_id not in heartbeats:
            heartbeats[lecture_id] = {}
        heartbeats[lecture_id][student_id] = {
            "name": student_name,
            "last_seen": datetime.datetime.utcnow().timestamp(),
            "disconnected": False,
            "state": event.event_type.upper()
        }
    
    background_tasks.add_task(save_activity_bg, lecture_id, student_id, student_name, event.event_type.upper(), event.reason)
    
    now_iso = datetime.datetime.utcnow().isoformat()
    print(f"[PRESENCE] student={student_name} session={lecture_id} -> {event.event_type.upper()} reason={event.reason}")

    event_data = {
        "type": event.event_type.upper(), 
        "student_id": student_id, 
        "student_name": student_name, 
        "timestamp": now_iso,
        "reason": event.reason
    }
    await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data))
    
    return {"status": "ok"}

@app.post("/api/lectures/{lecture_id}/end")
async def end_lecture(lecture_id: str, db: Session = Depends(get_db)):
    def do_end():
        db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
        if not db_lecture:
            return None
        db_lecture.status = "ENDED"
        db_lecture.ended_at = datetime.datetime.utcnow()
        db.commit()
        activities = db.query(models.SessionActivity).filter(models.SessionActivity.lecture_id == lecture_id).all()
        unique_students = len(set([a.student_id for a in activities]))
        return db_lecture.ended_at, unique_students, len(activities)
        
    result = await run_in_threadpool(do_end)
    if not result:
        raise HTTPException(status_code=404, detail="Lecture not found")
        
    ended_at, unique_students, total_events = result
    
    event_data = {"type": "END", "student_id": "system", "student_name": "System", "timestamp": ended_at.isoformat()}
    await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data))
    
    return {"status": "ended", "summary": {"total_students": unique_students, "total_events": total_events}}

@app.post("/api/lectures/{lecture_id}/status")
async def update_status(lecture_id: str, data: schemas.StatusUpdate, db: Session = Depends(get_db)):
    def do_update():
        db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
        if not db_lecture:
            return False
        db_lecture.status = data.status
        db.commit()
        return True
    
    success = await run_in_threadpool(do_update)
    if not success:
        raise HTTPException(status_code=404, detail="Lecture not found")
    
    event_data = {"type": "STATUS_CHANGE", "status": data.status, "student_id": "system", "student_name": "System", "timestamp": datetime.datetime.utcnow().isoformat()}
    await redis_client.publish(f"lecture_events_{lecture_id}", json.dumps(event_data))
    return {"status": "ok"}

@app.get("/api/lectures/{lecture_id}/events")
async def lecture_events(lecture_id: str, req: Request):
    async def event_generator():
        pubsub = redis_client.pubsub()
        await pubsub.subscribe(f"lecture_events_{lecture_id}")
        try:
            while True:
                if await req.is_disconnected():
                    break
                message = await pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0)
                if message:
                    yield {"data": message["data"].decode("utf-8")}
                else:
                    yield {"data": json.dumps({"type": "PING"})}
        finally:
            await pubsub.unsubscribe(f"lecture_events_{lecture_id}")
            
    return EventSourceResponse(event_generator())
