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
import { Users, MonitorUp, StopCircle, EyeOff, UserCheck, AlertCircle, Bell, BellOff, ArrowRight } from "lucide-react";

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
  const [toastAlerts, setToastAlerts] = useState<Array<StudentEvent & { id: string; isExiting?: boolean }>>([]);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [notificationPermission, setNotificationPermission] = useState<string>("default");

  // Track recent system notifications to deduplicate within a short window
  const lastSystemNotificationRef = useRef<Record<string, { type: string; reason?: string; time: number }>>({});
  const originalTitleRef = useRef<string>("");

  useEffect(() => {
    if (typeof window !== "undefined") {
      originalTitleRef.current = document.title || "Lectra - Faculty Room";
      if ("Notification" in window) {
        setNotificationPermission(Notification.permission);
      }
    }
  }, []);

  const requestPermission = async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      try {
        const result = await Notification.requestPermission();
        setNotificationPermission(result);
      } catch (err) {
        console.error("Failed to request permission", err);
      }
    }
  };

  // Helper: Dispatch Native System Notification (Cross-App when tab is not focused/visible)
  const triggerSystemNotification = useCallback((event: StudentEvent) => {
    if (typeof window === "undefined") return;

    const isTabActive = document.visibilityState === "visible" && document.hasFocus();
    
    // Only dispatch OS-level system notification if the faculty is NOT actively focused on the LECTRA tab
    if (!isTabActive) {
      // 1. Optional document title fallback
      const reasonLabel = event.type === "AWAY"
        ? event.reason === "PAGE_HIDDEN" ? "switched tabs" : event.reason === "FULLSCREEN_EXITED" ? "exited Focus Mode" : "left window"
        : event.type === "VIEWING" ? "returned" : event.type.toLowerCase();
      document.title = `(${event.student_name} ${reasonLabel}) ${originalTitleRef.current}`;

      // 2. Check deduplication for system notification (avoid repeat alerts for same student within 3s)
      const now = Date.now();
      const last = lastSystemNotificationRef.current[event.student_id];
      if (last && last.type === event.type && last.reason === event.reason && (now - last.time < 3000)) {
        return;
      }
      lastSystemNotificationRef.current[event.student_id] = {
        type: event.type,
        reason: event.reason,
        time: now
      };

      // 3. Dispatch OS Notification if permission granted
      if ("Notification" in window && Notification.permission === "granted") {
        let title = "LECTRA Focus Alert";
        let body = `${event.student_name} changed activity`;

        if (event.type === "AWAY") {
          if (event.reason === "PAGE_HIDDEN") {
            title = `⚠ ${event.student_name} switched tabs`;
            body = `${event.student_name} left the lecture to view another tab or app.`;
          } else if (event.reason === "FULLSCREEN_EXITED") {
            title = `⚠ ${event.student_name} exited Focus Mode`;
            body = `${event.student_name} minimized or left fullscreen view.`;
          } else if (event.reason === "WINDOW_BLURRED") {
            title = `⚠ ${event.student_name} left lecture window`;
            body = `${event.student_name} switched focus to another desktop window.`;
          } else {
            title = `⚠ ${event.student_name} switched away`;
            body = `Student is no longer actively watching the stream.`;
          }
        } else if (event.type === "DISCONNECTED") {
          title = `✕ ${event.student_name} disconnected`;
          body = `Student lost connection to the lecture broadcast.`;
        } else if (event.type === "JOIN") {
          title = `● ${event.student_name} joined`;
          body = `Student joined lecture ${lectureId.toUpperCase()}`;
        } else if (event.type === "VIEWING" && event.durationStr) {
          title = `✓ ${event.student_name} returned`;
          body = `Student resumed watching the broadcast.`;
        } else {
          // Avoid spamming OS notifications for routine return/heartbeats
          return;
        }

        try {
          const notification = new Notification(title, {
            body,
            icon: "/favicon.ico",
            tag: `lectra-${event.student_id}-${event.type}`, // Group repeat events by student
            requireInteraction: false
          });

          notification.onclick = () => {
            window.focus();
            notification.close();
          };
        } catch (err) {
          console.warn("Could not display native notification", err);
        }
      }
    } else {
      // Tab is active: restore normal document title
      document.title = originalTitleRef.current;
    }
  }, [lectureId]);

  // Restore title when user focuses window
  useEffect(() => {
    const handleFocus = () => {
      if (typeof document !== "undefined") {
        document.title = originalTitleRef.current;
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  // Helper: Add Apple-style In-App Toast
  const triggerInAppToast = useCallback((event: StudentEvent) => {
    const alertId = `${event.student_id}-${Date.now()}-${Math.random()}`;
    const toastItem = { ...event, id: alertId };
    
    setToastAlerts(prev => [toastItem, ...prev].slice(0, 4));

    // Smooth exit timer
    setTimeout(() => {
      setToastAlerts(prev =>
        prev.map(t => (t.id === alertId ? { ...t, isExiting: true } : t))
      );
      setTimeout(() => {
        setToastAlerts(prev => prev.filter(t => t.id !== alertId));
      }, 300);
    }, 4500);
  }, []);

  // Process incoming event for both layers
  const handleIncomingEvent = useCallback((event: StudentEvent) => {
    console.log(`[FACULTY] processing event: ${event.type} for ${event.student_name}`);

    // Layer 1: In-app Apple-like toast
    triggerInAppToast(event);

    // Layer 2: System-wide native notification (when in VS Code / PowerPoint / background)
    triggerSystemNotification(event);

    // Persistent recent activity
    setNotifications(prev => [event, ...prev].slice(0, 15));
  }, [triggerInAppToast, triggerSystemNotification]);

  // Fetch initial and updated participants
  const fetchParticipants = useCallback(async () => {
    if (!lectureId) return;
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const res = await fetch(`${apiUrl}/api/lectures/${lectureId.toUpperCase()}/participants`);
      if (res.ok) {
        const data = await res.json();
        setStudents(prev => {
          const updated = { ...prev };
          for (const p of data.participants || []) {
            const prevState = prev[p.id];
            let awayStartedAt = prevState?.awayStartedAt;
            
            // Check state transition from poll
            if (p.status === "AWAY" && prevState?.status && prevState.status !== "AWAY") {
              awayStartedAt = Date.now();
              handleIncomingEvent({
                type: "AWAY",
                student_id: p.id,
                student_name: p.name,
                reason: p.reason,
                timestamp: p.lastUpdate
              });
            } else if (["VIEWING", "JOIN", "RECONNECTED"].includes(p.status) && prevState?.status === "AWAY") {
              const durationStr = awayStartedAt ? ` (Away for ${((Date.now() - awayStartedAt) / 1000).toFixed(1)}s)` : '';
              awayStartedAt = undefined;
              handleIncomingEvent({
                type: "VIEWING",
                student_id: p.id,
                student_name: p.name,
                durationStr,
                timestamp: p.lastUpdate
              });
            } else if (p.status === "AWAY" && !awayStartedAt) {
              awayStartedAt = Date.now();
            }

            updated[p.id] = {
              id: p.id,
              name: p.name,
              status: p.status,
              lastUpdate: p.lastUpdate,
              reason: p.reason,
              awayStartedAt
            };
          }
          return updated;
        });
      }
    } catch (err) {
      console.error("[FACULTY] failed to fetch participants", err);
    }
  }, [lectureId, handleIncomingEvent]);

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

    // Polling backup every 2.5 seconds to guarantee sync
    const pollInterval = setInterval(fetchParticipants, 2500);

    // Connect to SSE for instant events
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

        // Trigger two-layer notifications
        handleIncomingEvent(event);
        
        if (event.type === "END") {
          setSessionEnded(true);
        }
      } catch (err) {
        console.error("[SSE] error parsing message", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("[SSE] EventSource error, auto-reconnecting", err);
    };

    return () => {
      eventSource.close();
      clearInterval(pollInterval);
    };
  }, [lectureId, facultyId, fetchParticipants, handleIncomingEvent]);

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
      {/* LAYER 1: Apple-Style Right-Side In-App Floating Toasts */}
      <div className="fixed top-20 right-6 z-50 flex flex-col space-y-2.5 pointer-events-none max-w-xs sm:max-w-sm w-full">
        {toastAlerts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto px-4 py-3.5 rounded-[18px] backdrop-blur-xl border transition-all duration-300 shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.35)] ${
              toast.isExiting ? "animate-toast-exit" : "animate-toast-enter"
            } ${
              toast.type === "AWAY"
                ? "bg-amber-50/85 dark:bg-amber-950/75 border-amber-200/70 dark:border-amber-800/50 text-amber-950 dark:text-amber-100"
                : toast.type === "VIEWING"
                ? "bg-emerald-50/85 dark:bg-emerald-950/75 border-emerald-200/70 dark:border-emerald-800/50 text-emerald-950 dark:text-emerald-100"
                : toast.type === "JOIN"
                ? "bg-blue-50/85 dark:bg-blue-950/75 border-blue-200/70 dark:border-blue-800/50 text-blue-950 dark:text-blue-100"
                : "bg-red-50/85 dark:bg-red-950/75 border-red-200/70 dark:border-red-800/50 text-red-950 dark:text-red-100"
            }`}
          >
            <div className="flex items-start space-x-3">
              <div className="mt-0.5 shrink-0">
                {toast.type === "AWAY" ? (
                  <div className="w-6 h-6 rounded-full bg-amber-500/20 dark:bg-amber-500/30 flex items-center justify-center">
                    <EyeOff className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
                  </div>
                ) : toast.type === "VIEWING" ? (
                  <div className="w-6 h-6 rounded-full bg-emerald-500/20 dark:bg-emerald-500/30 flex items-center justify-center">
                    <UserCheck className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
                  </div>
                ) : toast.type === "JOIN" ? (
                  <div className="w-6 h-6 rounded-full bg-blue-500/20 dark:bg-blue-500/30 flex items-center justify-center">
                    <Users className="w-3.5 h-3.5 text-blue-600 dark:text-blue-400" />
                  </div>
                ) : (
                  <div className="w-6 h-6 rounded-full bg-red-500/20 dark:bg-red-500/30 flex items-center justify-center">
                    <AlertCircle className="w-3.5 h-3.5 text-red-600 dark:text-red-400" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between">
                  <p className="font-semibold text-xs tracking-tight truncate pr-2">
                    {toast.type === "AWAY" ? (
                      `${toast.student_name} switched away`
                    ) : toast.type === "VIEWING" ? (
                      `${toast.student_name} returned`
                    ) : toast.type === "JOIN" ? (
                      `${toast.student_name} joined`
                    ) : (
                      `${toast.student_name} disconnected`
                    )}
                  </p>
                  <span className="text-[10px] opacity-60 font-medium shrink-0">
                    Just now
                  </span>
                </div>
                <p className="text-[11px] opacity-80 mt-0.5 leading-snug truncate">
                  {toast.type === "AWAY"
                    ? toast.reason === "PAGE_HIDDEN"
                      ? "Switched browser tab or minimized"
                      : toast.reason === "WINDOW_BLURRED"
                      ? "Changed active window"
                      : toast.reason === "FULLSCREEN_EXITED"
                      ? "Exited Focus Mode"
                      : "Left the lecture view"
                    : toast.durationStr
                    ? `Returned after ${toast.durationStr.replace(/[()]/g, "")}`
                    : "Active in lecture"}
                </p>
              </div>
            </div>
          </div>
        ))}
      </div>

      <header className="bg-white dark:bg-[#121212] border-b border-gray-200 dark:border-gray-800 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center space-x-6">
          <div>
            <h1 className="text-xl font-semibold text-gray-900 dark:text-white">Active Lecture</h1>
            <div className="flex items-center space-x-2 mt-1">
              <span className="text-sm text-gray-500 dark:text-gray-400">Class Code:</span>
              <span className="px-2 py-1 bg-gray-100 dark:bg-[#2a2a2a] rounded font-mono text-sm font-bold tracking-wider text-gray-900 dark:text-gray-100">
                {lectureId.toUpperCase()}
              </span>
            </div>
          </div>

          {/* Permission Status Indicator */}
          <div className="hidden sm:flex items-center">
            {notificationPermission === "granted" ? (
              <div className="flex items-center space-x-1.5 px-3 py-1 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300 rounded-full text-xs font-medium">
                <Bell className="w-3.5 h-3.5" />
                <span>OS Alerts Active</span>
              </div>
            ) : notificationPermission === "denied" ? (
              <div className="flex items-center space-x-1.5 px-3 py-1 bg-gray-100 dark:bg-gray-800 text-gray-500 rounded-full text-xs font-medium" title="Enable notifications in browser settings for background OS alerts">
                <BellOff className="w-3.5 h-3.5" />
                <span>OS Alerts Blocked</span>
              </div>
            ) : (
              <button
                onClick={requestPermission}
                className="flex items-center space-x-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-100 rounded-full text-xs font-medium transition"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>Enable OS Alerts</span>
              </button>
            )}
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
