"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { 
  LiveKitRoom, 
  RoomAudioRenderer,
  useLocalParticipant,
  VideoTrack,
  useConnectionState
} from "@livekit/components-react";
import { Track, LocalVideoTrack, createLocalScreenTracks, ConnectionState } from "livekit-client";
import { Users, MonitorUp, StopCircle, EyeOff, UserCheck, AlertCircle } from "lucide-react";

type StudentEvent = {
  type: string;
  student_id: string;
  student_name: string;
  timestamp: string;
  reason?: string;
  durationStr?: string;
};

type StudentState = {
  id: string;
  name: string;
  status: "JOIN" | "VIEWING" | "AWAY" | "LEAVE" | "DISCONNECTED" | "RECONNECTED";
  lastUpdate: string;
  awayStartedAt?: number;
  reason?: string;
};

import { Suspense } from "react";

const StudentTimer = ({ awayStartedAt }: { awayStartedAt: number }) => {
  const [seconds, setSeconds] = useState(Math.floor((Date.now() - awayStartedAt) / 1000));
  useEffect(() => {
    const interval = setInterval(() => setSeconds(Math.floor((Date.now() - awayStartedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [awayStartedAt]);
  return <span>Away · {seconds}s</span>;
};

function FacultyDashboardContent() {
  const searchParams = useSearchParams();
  const lectureId = searchParams.get("lectureId") as string;
  const facultyId = searchParams.get("facultyId");

  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [students, setStudents] = useState<Record<string, StudentState>>({});
  const [notifications, setNotifications] = useState<StudentEvent[]>([]);
  const [toastAlerts, setToastAlerts] = useState<Array<StudentEvent & { id: string }>>([]);
  const notificationQueue = useRef<StudentEvent[]>([]);
  const notificationTimer = useRef<any>(null);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [summary, setSummary] = useState<any>(null);

  useEffect(() => {
    // Request notification permission
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // Fetch initial participants
  const fetchParticipants = useCallback(async () => {
    if (!lectureId) return;
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const res = await fetch(`${apiUrl}/api/lectures/${lectureId.toUpperCase()}/participants`);
      if (res.ok) {
        const data = await res.json();
        const initialMap: Record<string, StudentState> = {};
        for (const p of data.participants || []) {
          initialMap[p.id] = {
            id: p.id,
            name: p.name,
            status: p.status,
            lastUpdate: p.lastUpdate,
            reason: p.reason,
            awayStartedAt: p.status === "AWAY" ? Date.now() : undefined,
          };
        }
        setStudents(prev => ({ ...initialMap, ...prev }));
        console.log(`[FACULTY] loaded ${data.participants?.length || 0} participants for ${lectureId}`);
      }
    } catch (err) {
      console.error("[FACULTY] failed to fetch participants", err);
    }
  }, [lectureId]);

  useEffect(() => {
    if (!lectureId || !facultyId) return;
    const normalizedLectureId = lectureId.toUpperCase();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    
    // Fetch LiveKit token
    fetch(`${apiUrl}/api/lectures/${normalizedLectureId}/token?faculty_id=${facultyId}`)
      .then(res => res.json())
      .then(data => {
        if (data.token) setToken(data.token);
        else setError("Failed to get broadcast token.");
      })
      .catch(err => setError(err.message));

    // Initial participant fetch
    fetchParticipants();

    // Connect to SSE for events
    const eventSource = new EventSource(`${apiUrl}/api/lectures/${normalizedLectureId}/events`);
    
    eventSource.onopen = () => {
      console.log(`[SSE] Connected to event stream for ${normalizedLectureId}`);
      fetchParticipants();
    };

    eventSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === "PING" || data.type === "STATUS_CHANGE") return;

        const event = data as StudentEvent;
        console.log(`[SSE] faculty subscriber received ${event.type} for ${event.student_name}`);

        setStudents(prev => {
          const prevState = prev[event.student_id];
          let awayStartedAt = prevState?.awayStartedAt;
          
          if (event.type === "AWAY" && prevState?.status !== "AWAY") {
             awayStartedAt = Date.now();
          } else if (["VIEWING", "JOIN", "RECONNECTED"].includes(event.type) && prevState?.status === "AWAY") {
             const durationStr = awayStartedAt ? ` (Away for ${((Date.now() - awayStartedAt) / 1000).toFixed(1)}s)` : '';
             event.durationStr = durationStr;
             awayStartedAt = undefined;
          } else if (["VIEWING", "JOIN", "RECONNECTED", "DISCONNECTED"].includes(event.type)) {
             awayStartedAt = undefined;
          }

          console.log(`[FACULTY] participant updated: ${event.student_name} -> ${event.type}`);

          return {
            ...prev,
            [event.student_id]: {
              id: event.student_id,
              name: event.student_name,
              status: event.type as any,
              lastUpdate: event.timestamp,
              awayStartedAt,
              reason: event.reason
            }
          };
        });

        // Trigger Right-Side Floating Toast Alert
        const alertId = `${event.student_id}-${Date.now()}-${Math.random()}`;
        const toastItem = { ...event, id: alertId };
        setToastAlerts(prev => [toastItem, ...prev].slice(0, 4));

        // Auto remove toast after 5s
        setTimeout(() => {
          setToastAlerts(prev => prev.filter(t => t.id !== alertId));
        }, 5000);

        // Add to persistent recent activity feed
        setNotifications(prev => [event, ...prev].slice(0, 10));
        
        // System Notification grouping for backgrounded faculty tab
        if ("Notification" in window && Notification.permission === "granted" && document.hidden) {
          notificationQueue.current.push(event);
          if (notificationTimer.current) clearTimeout(notificationTimer.current);
          
          notificationTimer.current = setTimeout(() => {
            const queue = notificationQueue.current;
            if (queue.length === 1) {
              const action = queue[0].type === "AWAY" ? "left lecture view" : 
                             queue[0].type === "VIEWING" ? `returned` :
                             queue[0].type === "JOIN" ? "joined the lecture" : "disconnected";
              new Notification(`${queue[0].student_name} ${action}`, {
                body: `${queue[0].durationStr || 'just now'}`,
                icon: "/favicon.ico"
              });
            } else if (queue.length > 1) {
              new Notification(`${queue.length} students had activity`, {
                body: `Open Lectra to review activity.`,
                icon: "/favicon.ico"
              });
            }
            notificationQueue.current = [];
          }, 1500);
        }
        
        if (event.type === "END") {
          setSessionEnded(true);
        }
      } catch (err) {
        console.error("[SSE] error parsing message", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("[SSE] EventSource connection error, will auto-reconnect", err);
    };

    return () => {
      eventSource.close();
    };
  }, [lectureId, facultyId, fetchParticipants]);

  const endLecture = async () => {
    if (!confirm("Are you sure you want to end this lecture?")) return;
    
    try {
      const res = await fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/lectures/${lectureId.toUpperCase()}/end`, {
        method: "POST"
      });
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary);
        setSessionEnded(true);
      }
    } catch (err) {
      console.error(err);
    }
  };

  if (error) return <div className="p-8 text-red-500">{error}</div>;
  if (!token) return <div className="p-8 dark:text-white">Loading dashboard...</div>;

  if (sessionEnded) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8 text-center space-y-6">
          <div className="w-16 h-16 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mx-auto">
            <StopCircle className="w-8 h-8" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">Lecture Ended</h1>
            <p className="text-gray-500 dark:text-gray-400">
              The broadcast has been stopped and students have been disconnected.
            </p>
          </div>
          {summary && (
            <div className="bg-gray-50 dark:bg-[#222] rounded-xl p-4 flex justify-around">
              <div className="text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.total_students}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Students</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.total_events}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Presence Events</p>
              </div>
            </div>
          )}
          <a href="/faculty" className="block w-full bg-gray-100 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:hover:bg-[#333] text-gray-900 dark:text-white py-3 rounded-xl font-medium transition-colors">
            Return to Dashboard
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex flex-col relative">
      {/* Right Side Floating Notifications Stack */}
      <div className="fixed top-20 right-6 z-50 flex flex-col space-y-3 pointer-events-none max-w-sm w-full">
        {toastAlerts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto p-4 rounded-2xl shadow-xl border backdrop-blur-md transition-all duration-300 transform translate-x-0 ${
              toast.type === "AWAY"
                ? "bg-amber-500/15 dark:bg-amber-950/60 border-amber-500/30 text-amber-900 dark:text-amber-100"
                : toast.type === "VIEWING"
                ? "bg-emerald-500/15 dark:bg-emerald-950/60 border-emerald-500/30 text-emerald-900 dark:text-emerald-100"
                : toast.type === "JOIN"
                ? "bg-blue-500/15 dark:bg-blue-950/60 border-blue-500/30 text-blue-900 dark:text-blue-100"
                : "bg-red-500/15 dark:bg-red-950/60 border-red-500/30 text-red-900 dark:text-red-100"
            }`}
          >
            <div className="flex items-start space-x-3">
              <div className="mt-0.5">
                {toast.type === "AWAY" ? (
                  <EyeOff className="w-5 h-5 text-amber-500" />
                ) : toast.type === "VIEWING" ? (
                  <UserCheck className="w-5 h-5 text-emerald-500" />
                ) : toast.type === "JOIN" ? (
                  <Users className="w-5 h-5 text-blue-500" />
                ) : (
                  <AlertCircle className="w-5 h-5 text-red-500" />
                )}
              </div>
              <div className="flex-1">
                <p className="font-semibold text-sm">
                  {toast.type === "AWAY" ? (
                    `⚠ ${toast.student_name} left the lecture`
                  ) : toast.type === "VIEWING" ? (
                    `✓ ${toast.student_name} returned to lecture`
                  ) : toast.type === "JOIN" ? (
                    `● ${toast.student_name} joined`
                  ) : (
                    `✕ ${toast.student_name} disconnected`
                  )}
                </p>
                <p className="text-xs opacity-80 mt-0.5">
                  {toast.type === "AWAY"
                    ? toast.reason === "PAGE_HIDDEN"
                      ? "Switched browser tab or minimized"
                      : toast.reason === "WINDOW_BLURRED"
                      ? "Changed application window"
                      : toast.reason === "FULLSCREEN_EXITED"
                      ? "Exited fullscreen mode"
                      : "Student switched away"
                    : toast.durationStr
                    ? `Returned after ${toast.durationStr.replace(/[()]/g, "")}`
                    : "Just now"}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <header className="bg-white dark:bg-[#121212] border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Active Lecture</h1>
          <div className="flex items-center space-x-2 mt-1">
            <span className="text-sm text-gray-500 dark:text-gray-400">Class Code:</span>
            <span className="px-2 py-1 bg-gray-100 dark:bg-[#2a2a2a] rounded font-mono text-sm font-bold tracking-wider text-gray-900 dark:text-gray-100">
              {lectureId.toUpperCase()}
            </span>
          </div>
        </div>
        <button
          onClick={endLecture}
          className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 rounded-lg text-sm font-medium transition-colors"
        >
          End Lecture
        </button>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Broadcast Control */}
        <div className="lg:col-span-2 flex flex-col space-y-6">
          <LiveKitRoom
            video={false}
            audio={false}
            token={token}
            serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880"}
            connect={true}
            className="flex-1 flex flex-col"
            onDisconnected={() => console.error("LiveKitRoom disconnected")}
            onError={(error) => console.error("LiveKitRoom error:", error)}
          >
            <BroadcastControl lectureId={lectureId.toUpperCase()} />
            <RoomAudioRenderer />
          </LiveKitRoom>
        </div>

        {/* Right Column: Students & Activity */}
        <div className="flex flex-col space-y-6">
          <div className="bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm flex-1">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-medium text-gray-900 dark:text-white flex items-center space-x-2">
                <Users className="w-5 h-5 text-gray-500" />
                <span>Class Presence</span>
              </h2>
              <span className="bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 text-xs font-bold px-2.5 py-1 rounded-full">
                {Object.values(students).filter(s => ["JOIN", "VIEWING", "RECONNECTED"].includes(s.status)).length} Active
              </span>
            </div>

            <div className="space-y-4">
              {Object.values(students).length === 0 ? (
                <p className="text-sm text-gray-500 dark:text-gray-400 text-center py-8">
                  Waiting for students to join using code {lectureId.toUpperCase()}
                </p>
              ) : (
                <div className="space-y-3">
                  {Object.values(students).map(s => (
                    <div key={s.id} className="flex items-center justify-between p-3 bg-gray-50 dark:bg-[#222] rounded-xl">
                      <span className="font-medium text-gray-900 dark:text-gray-200 text-sm">{s.name}</span>
                      {["JOIN", "VIEWING", "RECONNECTED"].includes(s.status) && (
                        <div className="flex items-center text-emerald-600 dark:text-emerald-400 text-xs font-medium space-x-1">
                          <UserCheck className="w-4 h-4" />
                          <span>Watching</span>
                        </div>
                      )}
                      {s.status === "AWAY" && (
                        <div className="flex items-center text-amber-600 dark:text-amber-400 text-xs font-medium space-x-1">
                          <EyeOff className="w-4 h-4" />
                          {s.awayStartedAt ? <StudentTimer awayStartedAt={s.awayStartedAt} /> : <span>Away</span>}
                        </div>
                      )}
                      {s.status === "DISCONNECTED" && (
                        <div className="flex items-center text-red-500 text-xs font-medium space-x-1">
                          <AlertCircle className="w-4 h-4" />
                          <span>Disconnected</span>
                        </div>
                      )}
                      {s.status === "LEAVE" && (
                        <div className="flex items-center text-gray-400 text-xs font-medium space-x-1">
                          <AlertCircle className="w-4 h-4" />
                          <span>Left</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
          
          {/* Recent Activity Persistent Log */}
          {notifications.length > 0 && (
            <div className="bg-white dark:bg-[#1a1a1a] border border-gray-200 dark:border-gray-800 rounded-2xl p-6 shadow-sm">
              <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-4 uppercase tracking-wider">Recent Activity</h3>
              <div className="space-y-3">
                {notifications.map((n, idx) => (
                  <div key={idx} className="flex items-start space-x-3 text-sm">
                    <div className={`mt-0.5 w-2 h-2 rounded-full ${n.type === 'AWAY' ? 'bg-amber-500' : ['VIEWING', 'RECONNECTED'].includes(n.type) ? 'bg-emerald-500' : n.type === 'JOIN' ? 'bg-blue-500' : 'bg-gray-400'}`} />
                    <p className="text-gray-600 dark:text-gray-300">
                      <span className="font-semibold text-gray-900 dark:text-white">{n.student_name}</span>{" "}
                      {n.type === "AWAY" ? "left lecture view" : 
                       n.type === "VIEWING" ? `returned${n.durationStr || ''}` : 
                       n.type === "JOIN" ? "joined the lecture" :
                       n.type === "RECONNECTED" ? "reconnected" :
                       n.type === "DISCONNECTED" ? "disconnected" : 
                       "left the lecture"}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

export default function FacultyDashboard() {
  return (
    <Suspense fallback={<div className="p-8 text-white min-h-screen bg-black">Loading dashboard...</div>}>
      <FacultyDashboardContent />
    </Suspense>
  );
}

function BroadcastControl({ lectureId }: { lectureId: string }) {
  const { localParticipant } = useLocalParticipant();
  const connectionState = useConnectionState();
  const [screenTrack, setScreenTrack] = useState<LocalVideoTrack | null>(null);

  const startScreenShare = async () => {
    if (connectionState !== ConnectionState.Connected) return;
    try {
      const tracks = await createLocalScreenTracks({
        audio: false,
        video: true
      });
      
      const track = tracks.find(t => t.kind === 'video') as LocalVideoTrack;
      if (track && localParticipant) {
        await localParticipant.publishTrack(track);
        setScreenTrack(track);

        // Update status to LIVE
        fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/lectures/${lectureId}/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "LIVE" })
        }).catch(console.error);

        // Handle native browser stop button
        track.on('ended', () => {
          stopScreenShare();
        });
      }
    } catch (e) {
      console.error("Could not start screen share", e);
    }
  };

  const stopScreenShare = () => {
    if (screenTrack && localParticipant) {
      localParticipant.unpublishTrack(screenTrack);
      screenTrack.stop();
      setScreenTrack(null);
      
      // Update status to WAITING
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/lectures/${lectureId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "WAITING" })
      }).catch(console.error);
    }
  };

  // Helper component to render a local video track robustly
  const renderLocalVideo = (track: any) => {
    return (
      <video
        ref={(el) => {
          if (el) {
            track.attach(el);
          } else {
            track.detach();
          }
        }}
        className="w-full h-full object-contain"
        autoPlay
        muted
        playsInline
      />
    );
  };

  return (
    <div className="flex-1 bg-gray-900 rounded-2xl overflow-hidden relative flex items-center justify-center border border-gray-800 shadow-xl">
      {screenTrack ? (
        <>
          {renderLocalVideo(screenTrack)}
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center space-x-4 bg-gray-900/80 backdrop-blur-md px-6 py-3 rounded-2xl border border-gray-700">
            <div className="flex items-center space-x-2 text-emerald-400 font-medium">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <span>Broadcasting Live</span>
            </div>
            <div className="w-px h-6 bg-gray-700" />
            <button
              onClick={stopScreenShare}
              className="flex items-center space-x-2 text-red-400 hover:text-red-300 font-medium transition-colors"
            >
              <StopCircle className="w-5 h-5" />
              <span>Stop Share</span>
            </button>
          </div>
        </>
      ) : (
        <div className="text-center space-y-6 max-w-sm">
          <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto">
            <MonitorUp className="w-10 h-10 text-gray-400" />
          </div>
          <div>
            <h3 className="text-xl font-medium text-white mb-2">Ready to Broadcast</h3>
            <div className="flex items-center justify-center space-x-2">
              <div className={`w-3 h-3 rounded-full ${connectionState === ConnectionState.Connected ? "bg-green-500" : connectionState === ConnectionState.Connecting ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`}></div>
              <span className="text-sm font-medium text-gray-400">
                {connectionState === ConnectionState.Connected ? "Ready to broadcast" : 
                 connectionState === ConnectionState.Connecting ? "Connecting to LiveKit server..." : 
                 `Connection Status: ${connectionState}`}
              </span>
            </div>
          </div>
          <button
            onClick={startScreenShare}
            disabled={connectionState !== ConnectionState.Connected}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-400 text-white py-3 px-6 rounded-xl font-medium transition-colors shadow-lg shadow-blue-900/20 flex justify-center items-center"
          >
            {connectionState === ConnectionState.Connected ? "Select Screen to Share" : `Wait: ${connectionState}`}
          </button>
        </div>
      )}
    </div>
  );
}
