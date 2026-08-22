import os
import uuid
import random
import string
import json
import asyncio
import datetime
import logging
from contextlib import asynccontextmanager
from typing import List, Dict, Optional

from fastapi import FastAPI, Depends, HTTPException, Request, BackgroundTasks
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy.orm import Session
from sse_starlette.sse import EventSourceResponse
import redis.asyncio as redis
from redis.asyncio.retry import Retry
from redis.backoff import ExponentialBackoff
from dotenv import load_dotenv

load_dotenv()

from database import engine, Base, get_db, SessionLocal
import models, schemas
from livekit.api import AccessToken, VideoGrants

logger = logging.getLogger("lectra.backend")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# Init DB
models.Base.metadata.create_all(bind=engine)

LIVEKIT_API_KEY = os.getenv("LIVEKIT_API_KEY", "devkey")
LIVEKIT_API_SECRET = os.getenv("LIVEKIT_API_SECRET", "lectra_super_secret_key_1234567890_!")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# VAPID Web Push Keys
VAPID_PUBLIC_KEY = os.getenv("VAPID_PUBLIC_KEY", "BCWdovh0jjaE521xDcgtCgqW4uxnJ7mklCVKb4-_HNPF3MDeGBxaF0yOsRzN_G_gzwKLWOv6vWJuA2HuggnNhU0")
VAPID_PRIVATE_KEY = os.getenv("VAPID_PRIVATE_KEY", "fL2rz5De-UHvJzhA4zTufCxyCSXlQA1VZ8KQfUQ77fA")
VAPID_CLAIMS = {"sub": os.getenv("VAPID_SUBJECT", "mailto:admin@lectra.app")}

try:
    from pywebpush import webpush, WebPushException
except ImportError:
    webpush = None
    WebPushException = Exception

def send_web_push_sync(lecture_id: str, payload_data: dict):
    """Synchronous worker to dispatch Web Push to all active subscriptions for a lecture."""
    if not webpush:
        logger.warning("[WEB PUSH] pywebpush not available")
        return

    db = SessionLocal()
    try:
        subscriptions = (
            db.query(models.PushSubscription)
            .filter(
                models.PushSubscription.lecture_id == lecture_id,
                models.PushSubscription.active == True,
            )
            .all()
        )
        if not subscriptions:
            return

        logger.info("[WEB PUSH] sending lecture=%s event=%s count=%d", lecture_id, payload_data.get("type", "ALERT"), len(subscriptions))
        payload_json = json.dumps(payload_data)

        for sub in subscriptions:
            sub_info = {
                "endpoint": sub.endpoint,
                "keys": {
                    "p256dh": sub.p256dh,
                    "auth": sub.auth,
                },
            }
            try:
                webpush(
                    subscription_info=sub_info,
                    data=payload_json,
                    vapid_private_key=VAPID_PRIVATE_KEY,
                    vapid_claims=VAPID_CLAIMS,
                )
                logger.info("[WEB PUSH] delivered subscription_id=%s", sub.id)
            except WebPushException as ex:
                status_code = getattr(getattr(ex, "response", None), "status_code", None)
                logger.warning("[WEB PUSH] delivery failed for sub=%s status=%s: %s", sub.id, status_code, ex)
                if status_code in (404, 410):
                    # Subscription is expired or unregistered
                    sub.active = False
                    db.commit()
            except Exception as ex:
                logger.warning("[WEB PUSH] unexpected error for sub=%s: %s", sub.id, ex)
    except Exception as exc:
        logger.exception("[WEB PUSH] Error in send_web_push_sync: %s", exc)
    finally:
        db.close()

# Production-safe connection pool for Redis (supports redis:// and Upstash rediss:// with TLS)
redis_pool = redis.ConnectionPool.from_url(
    REDIS_URL,
    max_connections=20,
    decode_responses=True,
    health_check_interval=30,
    socket_connect_timeout=10,
    socket_timeout=10,
    socket_keepalive=True,
    retry_on_timeout=True,
    retry_on_error=[redis.ConnectionError, redis.TimeoutError],
    retry=Retry(ExponentialBackoff(cap=10, base=1), 3),
)
redis_client = redis.Redis(connection_pool=redis_pool)


async def publish_lecture_event(lecture_id: str, event_data: dict) -> bool:
    """Safely publish an event to Redis Pub/Sub without breaking the caller on transient failure."""
    channel = f"lecture_events_{lecture_id}"
    try:
        await redis_client.publish(channel, json.dumps(event_data))
        return True
    except (redis.ConnectionError, redis.TimeoutError) as exc:
        logger.warning(
            "Transient Redis connection error publishing to %s (event_type=%s): %s",
            channel,
            event_data.get("type"),
            exc,
        )
        return False
    except Exception as exc:
        logger.exception(
            "Unexpected error publishing event to Redis on channel %s: %s",
            channel,
            exc,
        )
        return False


heartbeats: Dict[str, Dict[str, dict]] = {}


async def monitor_heartbeats():
    while True:
        try:
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
                            "timestamp": datetime.datetime.utcnow().isoformat(),
                        }
                        await publish_lecture_event(lecture_id, event_data)
        except asyncio.CancelledError:
            break
        except Exception as exc:
            logger.exception("Error in heartbeat monitor task: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: test Redis connectivity non-blockingly
    try:
        await redis_client.ping()
        logger.info("Successfully connected to Redis.")
    except Exception as exc:
        logger.warning(
            "Initial Redis ping failed during startup (%s). Server will proceed and retry on demand.",
            exc,
        )

    monitor_task = asyncio.create_task(monitor_heartbeats())
    try:
        yield
    finally:
        # Shutdown: cancel background tasks and close Redis cleanly
        monitor_task.cancel()
        try:
            await monitor_task
        except asyncio.CancelledError:
            pass

        try:
            await redis_client.aclose()
            await redis_pool.disconnect()
            logger.info("Redis client and connection pool closed cleanly.")
        except Exception as exc:
            logger.warning("Error during Redis client shutdown: %s", exc)


app = FastAPI(title="Lectra API", lifespan=lifespan)

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


def generate_short_code(length=6):
    return "".join(random.choices(string.ascii_uppercase + string.digits, k=length))


def save_activity_bg(
    lecture_id: str,
    student_id: str,
    student_name: str,
    event_type: str,
    reason: Optional[str] = None,
):
    db = SessionLocal()
    try:
        activity = models.SessionActivity(
            lecture_id=lecture_id,
            student_id=student_id,
            student_name=student_name,
            event_type=event_type,
            reason=reason,
        )
        db.add(activity)
        db.commit()
    finally:
        db.close()


@app.post("/api/lectures", response_model=schemas.LectureResponse)
def create_lecture(lecture: schemas.LectureCreate, db: Session = Depends(get_db)):
    lecture_id = generate_short_code().upper()
    faculty_id = str(uuid.uuid4())
    db_lecture = models.Lecture(id=lecture_id, faculty_id=faculty_id, title=lecture.title)
    db.add(db_lecture)
    db.commit()
    db.refresh(db_lecture)
    logger.info("[LECTURE_CREATED] id=%s title=%s faculty_id=%s", lecture_id, lecture.title, faculty_id)
    return db_lecture


@app.get("/api/lectures/{lecture_id}", response_model=schemas.LectureResponse)
def get_lecture(lecture_id: str, db: Session = Depends(get_db)):
    lecture_id = lecture_id.upper()
    db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
    if not db_lecture:
        raise HTTPException(status_code=404, detail="Lecture not found")
    return db_lecture


@app.get("/api/lectures/{lecture_id}/token")
def get_faculty_token(lecture_id: str, faculty_id: str, db: Session = Depends(get_db)):
    lecture_id = lecture_id.upper()
    db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
    if not db_lecture or db_lecture.faculty_id != faculty_id:
        raise HTTPException(status_code=404, detail="Lecture not found or unauthorized")

    grant = VideoGrants(
        room=lecture_id,
        room_join=True,
        can_publish=True,
        can_subscribe=True,
        room_admin=True,
    )
    access_token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    access_token.with_identity(f"faculty-{faculty_id}").with_name("Faculty").with_grants(grant)
    return {"token": access_token.to_jwt()}


@app.get("/api/lectures/{lecture_id}/participants")
async def get_participants(lecture_id: str, db: Session = Depends(get_db)):
    """Fetch current participants and their latest known presence state for the lecture."""
    lecture_id = lecture_id.upper()
    active_memory = heartbeats.get(lecture_id, {})
    now = datetime.datetime.utcnow().timestamp()

    # Build response prioritizing active in-memory state, falling back to database
    participants_map = {}

    # 1. Load from DB session_activity
    def query_db_activities():
        return (
            db.query(models.SessionActivity)
            .filter(models.SessionActivity.lecture_id == lecture_id)
            .order_by(models.SessionActivity.timestamp.asc())
            .all()
        )

    activities = await run_in_threadpool(query_db_activities)
    for act in activities:
        participants_map[act.student_id] = {
            "id": act.student_id,
            "name": act.student_name,
            "status": act.event_type,
            "lastUpdate": act.timestamp.isoformat() if act.timestamp else datetime.datetime.utcnow().isoformat(),
            "reason": act.reason,
        }

    # 2. Merge with latest in-memory heartbeat / presence state
    for student_id, data in active_memory.items():
        is_disconnected = data.get("disconnected") or (now - data.get("last_seen", 0) > 12)
        status = "DISCONNECTED" if is_disconnected else data.get("state", "VIEWING")
        participants_map[student_id] = {
            "id": student_id,
            "name": data.get("name", "Student"),
            "status": status,
            "lastUpdate": datetime.datetime.fromtimestamp(data.get("last_seen", now)).isoformat(),
            "reason": data.get("reason"),
        }

    return {"lecture_id": lecture_id, "participants": list(participants_map.values())}


@app.post("/api/lectures/{lecture_id}/join", response_model=schemas.JoinResponse)
async def join_lecture(
    lecture_id: str,
    student: schemas.StudentJoin,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    student_name = student.name.strip()

    def check_lecture():
        return db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()

    db_lecture = await run_in_threadpool(check_lecture)

    if not db_lecture:
        raise HTTPException(status_code=404, detail="Lecture not found")
    if db_lecture.status == "ENDED":
        raise HTTPException(status_code=400, detail="This class has ended")

    student_id = str(uuid.uuid4())
    grant = VideoGrants(room=lecture_id, room_join=True, can_publish=False, can_subscribe=True)
    access_token = AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    access_token.with_identity(f"student-{student_id}").with_name(student_name).with_grants(grant)

    if lecture_id not in heartbeats:
        heartbeats[lecture_id] = {}
    heartbeats[lecture_id][student_id] = {
        "name": student_name,
        "last_seen": datetime.datetime.utcnow().timestamp(),
        "disconnected": False,
        "state": "VIEWING",
    }

    background_tasks.add_task(save_activity_bg, lecture_id, student_id, student_name, "JOIN")

    now_iso = datetime.datetime.utcnow().isoformat()
    logger.info("[JOIN] %s (student_id=%s) joined %s", student_name, student_id, lecture_id)

    event_data = {
        "type": "JOIN",
        "student_id": student_id,
        "student_name": student_name,
        "timestamp": now_iso,
    }
    logger.info("[REDIS] publishing student_joined event for %s on %s", student_name, lecture_id)
    await publish_lecture_event(lecture_id, event_data)

    return {
        "token": access_token.to_jwt(),
        "student_id": student_id,
        "lecture_id": lecture_id,
    }


@app.post("/api/lectures/{lecture_id}/heartbeat")
async def handle_heartbeat(
    lecture_id: str,
    student_id: str,
    payload: schemas.HeartbeatPayload,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    if lecture_id not in heartbeats:
        heartbeats[lecture_id] = {}

    student_data = heartbeats[lecture_id].get(student_id)
    now = datetime.datetime.utcnow().timestamp()
    now_iso = datetime.datetime.utcnow().isoformat()

    if not student_data:

        def get_name():
            last = (
                db.query(models.SessionActivity)
                .filter(
                    models.SessionActivity.lecture_id == lecture_id,
                    models.SessionActivity.student_id == student_id,
                )
                .order_by(models.SessionActivity.timestamp.desc())
                .first()
            )
            return last.student_name if last else "Unknown"

        student_name = await run_in_threadpool(get_name)
        student_data = {"name": student_name, "disconnected": False, "state": payload.state.upper()}

    was_disconnected = student_data.get("disconnected", False)
    student_data["last_seen"] = now
    student_data["disconnected"] = False
    student_data["state"] = payload.state.upper()

    if was_disconnected:
        logger.info("[RECONNECTED] student=%s (id=%s) session=%s", student_data["name"], student_id, lecture_id)
        event_data_recon = {
            "type": "RECONNECTED",
            "student_id": student_id,
            "student_name": student_data["name"],
            "timestamp": now_iso,
        }
        await publish_lecture_event(lecture_id, event_data_recon)

        event_data_state = {
            "type": payload.state.upper(),
            "student_id": student_id,
            "student_name": student_data["name"],
            "timestamp": now_iso,
        }
        await publish_lecture_event(lecture_id, event_data_state)

    heartbeats[lecture_id][student_id] = student_data
    return {"status": "ok"}


@app.post("/api/lectures/{lecture_id}/presence")
async def update_presence(
    lecture_id: str,
    student_id: str,
    event: schemas.PresenceEvent,
    background_tasks: BackgroundTasks,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    event_type = event.event_type.upper()
    student_data = heartbeats.get(lecture_id, {}).get(student_id)

    if student_data:
        student_name = student_data.get("name", "Unknown")
        if (
            student_data.get("state") == event_type
            and student_data.get("reason") == event.reason
            and not student_data.get("disconnected")
        ):
            return {"status": "ignored_duplicate"}
        student_data["state"] = event_type
        student_data["last_seen"] = datetime.datetime.utcnow().timestamp()
        student_data["disconnected"] = False
        student_data["reason"] = event.reason
    else:

        def get_name():
            last = (
                db.query(models.SessionActivity)
                .filter(
                    models.SessionActivity.lecture_id == lecture_id,
                    models.SessionActivity.student_id == student_id,
                )
                .order_by(models.SessionActivity.timestamp.desc())
                .first()
            )
            return last.student_name if last else "Unknown Student"

        student_name = await run_in_threadpool(get_name)
        if lecture_id not in heartbeats:
            heartbeats[lecture_id] = {}
        heartbeats[lecture_id][student_id] = {
            "name": student_name,
            "last_seen": datetime.datetime.utcnow().timestamp(),
            "disconnected": False,
            "state": event_type,
            "reason": event.reason,
        }

    background_tasks.add_task(
        save_activity_bg,
        lecture_id,
        student_id,
        student_name,
        event_type,
        event.reason,
    )

    now_iso = datetime.datetime.utcnow().isoformat()
    logger.info(
        "[PRESENCE] student=%s (id=%s) session=%s -> %s reason=%s",
        student_name,
        student_id,
        lecture_id,
        event_type,
        event.reason,
    )

    event_data = {
        "type": event_type,
        "student_id": student_id,
        "student_name": student_name,
        "timestamp": now_iso,
        "reason": event.reason,
    }
    logger.info("[REDIS] publishing presence event %s for %s on %s", event_type, student_name, lecture_id)
    await publish_lecture_event(lecture_id, event_data)

    # Trigger Web Push on Backend for Cross-App OS Delivery
    if event_type in ("AWAY", "DISCONNECTED", "FULLSCREEN_EXITED"):
        title = "LECTRA"
        if event_type == "AWAY":
            if event.reason == "PAGE_HIDDEN":
                body = f"⚠ {student_name} switched tabs"
            elif event.reason == "FULLSCREEN_EXITED":
                body = f"⚠ {student_name} exited Focus Mode"
            elif event.reason == "WINDOW_BLURRED":
                body = f"⚠ {student_name} left the lecture window"
            else:
                body = f"⚠ {student_name} switched away"
        elif event_type == "DISCONNECTED":
            body = f"● {student_name} disconnected"
        else:
            body = f"⚠ {student_name} changed activity"

        push_payload = {
            "title": title,
            "body": body,
            "tag": f"lectra-{lecture_id}-{student_id}-{event_type}",
            "data": {
                "lecture_id": lecture_id,
                "student_id": student_id,
                "type": event_type,
                "url": f"/faculty/room?lectureId={lecture_id}",
            },
        }
        background_tasks.add_task(send_web_push_sync, lecture_id, push_payload)

    return {"status": "ok"}


@app.get("/api/push/public-key")
def get_vapid_public_key():
    return {"public_key": VAPID_PUBLIC_KEY}


@app.post("/api/lectures/{lecture_id}/push-subscriptions")
def save_push_subscription(
    lecture_id: str,
    sub_data: schemas.PushSubscriptionCreate,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    existing = (
        db.query(models.PushSubscription)
        .filter(models.PushSubscription.endpoint == sub_data.endpoint)
        .first()
    )
    if existing:
        existing.lecture_id = lecture_id
        existing.faculty_id = sub_data.faculty_id
        existing.p256dh = sub_data.keys.p256dh
        existing.auth = sub_data.keys.auth
        existing.active = True
        db.commit()
        db.refresh(existing)
        logger.info("[PUSH_SUB] updated subscription_id=%s for lecture=%s", existing.id, lecture_id)
        return {"status": "updated", "id": existing.id}
    else:
        new_sub = models.PushSubscription(
            lecture_id=lecture_id,
            faculty_id=sub_data.faculty_id,
            endpoint=sub_data.endpoint,
            p256dh=sub_data.keys.p256dh,
            auth=sub_data.keys.auth,
            active=True,
        )
        db.add(new_sub)
        db.commit()
        db.refresh(new_sub)
        logger.info("[PUSH_SUB] created subscription_id=%s for lecture=%s", new_sub.id, lecture_id)
        return {"status": "created", "id": new_sub.id}


@app.delete("/api/lectures/{lecture_id}/push-subscriptions")
def delete_push_subscription(
    lecture_id: str,
    endpoint: str,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    sub = (
        db.query(models.PushSubscription)
        .filter(
            models.PushSubscription.lecture_id == lecture_id,
            models.PushSubscription.endpoint == endpoint,
        )
        .first()
    )
    if sub:
        sub.active = False
        db.commit()
        logger.info("[PUSH_SUB] deactivated subscription_id=%s for lecture=%s", sub.id, lecture_id)
    return {"status": "ok"}


@app.post("/api/lectures/{lecture_id}/test-push")
def synchronous_test_push(
    lecture_id: str,
    db: Session = Depends(get_db),
):
    lecture_id = lecture_id.upper()
    subscriptions = (
        db.query(models.PushSubscription)
        .filter(
            models.PushSubscription.lecture_id == lecture_id,
            models.PushSubscription.active == True,
        )
        .all()
    )

    if not subscriptions:
        logger.warning("[WEB PUSH] no active subscriptions found for lecture=%s", lecture_id)
        return {
            "success": False,
            "error": "No active subscriptions found for this lecture.",
            "subscriptions_count": 0,
        }

    test_payload = {
        "title": "LECTRA Test",
        "body": "Cross-app Web Push notifications are working.",
        "tag": f"lectra-test-{lecture_id}-{datetime.datetime.utcnow().timestamp()}",
        "data": {
            "lecture_id": lecture_id,
            "url": f"/faculty/room?lectureId={lecture_id}",
        },
    }

    results = []
    payload_json = json.dumps(test_payload)

    for sub in subscriptions:
        sub_info = {
            "endpoint": sub.endpoint,
            "keys": {
                "p256dh": sub.p256dh,
                "auth": sub.auth,
            },
        }
        try:
            logger.info("[WEB PUSH] sending test push to sub_id=%s endpoint_host=%s", sub.id, sub.endpoint.split("/")[2] if "/" in sub.endpoint else "unknown")
            response = webpush(
                subscription_info=sub_info,
                data=payload_json,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS,
            )
            status_code = getattr(response, "status_code", 201)
            logger.info("[WEB PUSH] provider status=%s for sub_id=%s", status_code, sub.id)
            results.append({"subscription_id": sub.id, "status_code": status_code, "success": True})
        except WebPushException as ex:
            status_code = getattr(getattr(ex, "response", None), "status_code", None)
            err_msg = str(ex)
            logger.warning("[WEB PUSH] delivery failed for sub_id=%s status=%s: %s", sub.id, status_code, err_msg)
            if status_code in (404, 410):
                sub.active = False
                db.commit()
            results.append({"subscription_id": sub.id, "status_code": status_code, "error": err_msg, "success": False})
        except Exception as ex:
            logger.exception("[WEB PUSH] unexpected exception sending test push: %s", ex)
            results.append({"subscription_id": sub.id, "error": str(ex), "success": False})

    all_success = any(r.get("success") for r in results)
    return {
        "success": all_success,
        "subscriptions_count": len(subscriptions),
        "deliveries": results,
    }


@app.post("/api/lectures/{lecture_id}/push-test")
def test_push_notification(
    lecture_id: str,
    db: Session = Depends(get_db),
):
    return synchronous_test_push(lecture_id, db)


@app.post("/api/lectures/{lecture_id}/end")
async def end_lecture(lecture_id: str):
    lecture_id = lecture_id.upper()

    def do_end():
        db = SessionLocal()
        try:
            db_lecture = db.query(models.Lecture).filter(models.Lecture.id == lecture_id).first()
            if not db_lecture:
                return None
            db_lecture.status = "ENDED"
            db_lecture.ended_at = datetime.datetime.utcnow()
            db.commit()
            activities = (
                db.query(models.SessionActivity)
                .filter(models.SessionActivity.lecture_id == lecture_id)
                .all()
            )
            unique_students = len(set([a.student_id for a in activities]))
            return db_lecture.ended_at.isoformat(), unique_students, len(activities)
        finally:
            db.close()

    try:
        result = await run_in_threadpool(do_end)
    except Exception as exc:
        logger.error("[END_LECTURE] DB Error ending lecture %s: %s", lecture_id, exc)
        raise HTTPException(status_code=500, detail="Database error ending lecture")

    if not result:
        raise HTTPException(status_code=404, detail="Lecture not found")

    ended_at_str, unique_students, total_events = result

    event_data = {
        "type": "LECTURE_ENDED",
        "lecture_id": lecture_id,
        "student_id": "system",
        "student_name": "System",
        "timestamp": ended_at_str,
    }
    try:
        await publish_lecture_event(lecture_id, event_data)
    except Exception as e:
        logger.warn("[END_LECTURE] Error publishing LECTURE_ENDED event: %s", e)

    return {
        "status": "ended",
        "summary": {"total_students": unique_students, "total_events": total_events},
    }


@app.post("/api/lectures/{lecture_id}/status")
async def update_status(
    lecture_id: str, data: schemas.StatusUpdate, db: Session = Depends(get_db)
):
    lecture_id = lecture_id.upper()
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

    event_data = {
        "type": "STATUS_CHANGE",
        "status": data.status,
        "student_id": "system",
        "student_name": "System",
        "timestamp": datetime.datetime.utcnow().isoformat(),
    }
    await publish_lecture_event(lecture_id, event_data)
    return {"status": "ok"}


@app.get("/api/lectures/{lecture_id}/events")
async def lecture_events(lecture_id: str, req: Request):
    lecture_id = lecture_id.upper()
    channel = f"lecture_events_{lecture_id}"

    async def event_generator():
        client = None
        pubsub = None
        listener_task = None
        queue = asyncio.Queue()

        async def reader(ps):
            try:
                async for message in ps.listen():
                    if message and message.get("type") == "message" and message.get("data") is not None:
                        logger.info("[REDIS RECEIVE] channel=%s data=%s", channel, message["data"])
                        await queue.put(message["data"])
            except asyncio.CancelledError:
                pass
            except Exception as exc:
                logger.warning("[REDIS SUBSCRIBER ERROR] channel=%s: %s", channel, exc)

        try:
            while True:
                if await req.is_disconnected():
                    break

                if pubsub is None:
                    try:
                        client = redis.from_url(
                            REDIS_URL,
                            decode_responses=True,
                            health_check_interval=30,
                            socket_connect_timeout=10,
                            socket_timeout=10,
                            socket_keepalive=True,
                            retry_on_timeout=True,
                        )
                        pubsub = client.pubsub()
                        await pubsub.subscribe(channel)
                        logger.info("Subscribed to Redis channel %s for SSE client", channel)
                        listener_task = asyncio.create_task(reader(pubsub))
                    except Exception as exc:
                        logger.warning("Failed to subscribe to Redis channel %s: %s. Retrying in 2s...", channel, exc)
                        if pubsub:
                            try:
                                await pubsub.aclose()
                            except Exception:
                                pass
                            pubsub = None
                        if client:
                            try:
                                await client.aclose()
                            except Exception:
                                pass
                            client = None
                        yield {"data": json.dumps({"type": "PING"})}
                        await asyncio.sleep(2)
                        continue

                # Wait for next event or send periodic ping every 1.5s
                try:
                    event_data = await asyncio.wait_for(queue.get(), timeout=1.5)
                    yield {"data": event_data}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "PING"})}
                except Exception as exc:
                    logger.exception("Error in SSE event yield loop for %s: %s", channel, exc)
                    yield {"data": json.dumps({"type": "PING"})}

        finally:
            if listener_task:
                listener_task.cancel()
                try:
                    await listener_task
                except asyncio.CancelledError:
                    pass
            if pubsub:
                try:
                    await pubsub.unsubscribe(channel)
                    await pubsub.aclose()
                except Exception:
                    pass
            if client:
                try:
                    await client.aclose()
                except Exception:
                    pass
            logger.info("Cleaned up SSE subscription for channel %s", channel)

    response = EventSourceResponse(event_generator())
    response.headers["Cache-Control"] = "no-cache"
    response.headers["Connection"] = "keep-alive"
    response.headers["X-Accel-Buffering"] = "no"
    return response
