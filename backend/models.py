from sqlalchemy import Column, Integer, String, Boolean, ForeignKey, DateTime, JSON
from database import Base
import datetime

class Lecture(Base):
    __tablename__ = "lectures"
    id = Column(String, primary_key=True, index=True) # E.g., 'ABCD-1234'
    faculty_id = Column(String, index=True) # UUID for faculty
    title = Column(String)
    status = Column(String, default="WAITING") # 'WAITING', 'LIVE', 'ENDED'
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    ended_at = Column(DateTime, nullable=True)

class SessionActivity(Base):
    __tablename__ = "session_activity"
    id = Column(Integer, primary_key=True, index=True)
    lecture_id = Column(String, ForeignKey("lectures.id"))
    student_id = Column(String, index=True)
    student_name = Column(String)
    event_type = Column(String) # 'JOIN', 'LEAVE', 'AWAY', 'VIEWING'
    reason = Column(String, nullable=True)
    timestamp = Column(DateTime, default=datetime.datetime.utcnow)

class PushSubscription(Base):
    __tablename__ = "push_subscriptions"
    id = Column(Integer, primary_key=True, index=True)
    lecture_id = Column(String, ForeignKey("lectures.id"), index=True)
    faculty_id = Column(String, index=True)
    endpoint = Column(String, unique=True, index=True)
    p256dh = Column(String)
    auth = Column(String)
    active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
