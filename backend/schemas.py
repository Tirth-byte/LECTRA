from pydantic import BaseModel
from typing import Optional, List
import datetime

class LectureCreate(BaseModel):
    title: str

class LectureResponse(BaseModel):
    id: str
    title: str
    status: str
    created_at: datetime.datetime
    faculty_id: str

    class Config:
        from_attributes = True

class StudentJoin(BaseModel):
    name: str

class JoinResponse(BaseModel):
    token: str
    student_id: str
    lecture_id: str

class PresenceEvent(BaseModel):
    event_type: str # 'VIEWING', 'AWAY', 'LEAVE'
    reason: Optional[str] = None

class HeartbeatPayload(BaseModel):
    state: str

class StatusUpdate(BaseModel):
    status: str

class ActivityResponse(BaseModel):
    id: int
    student_id: str
    student_name: str
    event_type: str
    timestamp: datetime.datetime

    class Config:
        from_attributes = True
