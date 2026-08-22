"use client";

import { useEffect, useState, useRef, useCallback, memo } from "react";
import { useSearchParams } from "next/navigation";
import { 
  LiveKitRoom, 
  RoomAudioRenderer,
  useLocalParticipant,
  useConnectionState
} from "@livekit/components-react";
import { Track, LocalVideoTrack, createLocalScreenTracks, ConnectionState } from "livekit-client";
import { Users, MonitorUp, StopCircle, EyeOff, UserCheck, AlertCircle, Bell, BellOff, ArrowRight, Loader2 } from "lucide-react";

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

const StudentTimer = memo(function StudentTimer({ awayStartedAt }: { awayStartedAt: number }) {
  const [seconds, setSeconds] = useState(Math.floor((Date.now() - awayStartedAt) / 1000));
  useEffect(() => {
    const interval = setInterval(() => setSeconds(Math.floor((Date.now() - awayStartedAt) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [awayStartedAt]);
  return <span>Away · {seconds}s</span>;
});

// Memoized Apple-like Toast Stack
const ToastStack = memo(function ToastStack({
  toasts,
}: {
  toasts: Array<StudentEvent & { id: string; isExiting?: boolean }>;
}) {
  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-20 right-6 z-50 flex flex-col space-y-2.5 pointer-events-none max-w-xs sm:max-w-sm w-full">
      {toasts.map(toast => (
        <div
          key={toast.id}
          className={`pointer-events-auto px-4 py-3 rounded-[18px] backdrop-blur-xl border transition-all shadow-[0_8px_30px_rgb(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.35)] ${
            toast.isExiting ? "animate-toast-exit" : "animate-toast-enter"
          } ${
            toast.type === "AWAY"
              ? "bg-amber-50/90 dark:bg-amber-950/80 border-amber-200/70 dark:border-amber-800/50 text-amber-950 dark:text-amber-100"
              : toast.type === "VIEWING"
              ? "bg-emerald-50/90 dark:bg-emerald-950/80 border-emerald-200/70 dark:border-emerald-800/50 text-emerald-950 dark:text-emerald-100"
              : toast.type === "JOIN"
              ? "bg-blue-50/90 dark:bg-blue-950/80 border-blue-200/70 dark:border-blue-800/50 text-blue-950 dark:text-blue-100"
              : "bg-red-50/90 dark:bg-red-950/80 border-red-200/70 dark:border-red-800/50 text-red-950 dark:text-red-100"
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
  );
});

function FacultyDashboardContent() {
  const searchParams = useSearchParams();
  const lectureId = (searchParams.get("lectureId") as string) || "";
  const facultyId = searchParams.get("facultyId");

  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [students, setStudents] = useState<Record<string, StudentState>>({});
  const [notifications, setNotifications] = useState<StudentEvent[]>([]);
  const [toastAlerts, setToastAlerts] = useState<Array<StudentEvent & { id: string; isExiting?: boolean }>>([]);
  const [sessionEnded, setSessionEnded] = useState(false);
  const [summary, setSummary] = useState<any>(null);
  const [notificationPermission, setNotificationPermission] = useState<string>("default");
  const [showPermissionHelp, setShowPermissionHelp] = useState(false);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [isEnding, setIsEnding] = useState(false);

  // Stable references
  const lastSystemNotificationRef = useRef<Record<string, { type: string; reason?: string; time: number }>>({});
  const originalTitleRef = useRef<string>("Lectra - Faculty Room");

  // Register service worker on mount for reliable OS notifications
  useEffect(() => {
    if (typeof window !== "undefined") {
      originalTitleRef.current = document.title || "Lectra - Faculty Room";
      if ("Notification" in window) {
        console.log("[NOTIFICATION] supported:", true);
        console.log("[NOTIFICATION] initial permission:", Notification.permission);
        setNotificationPermission(Notification.permission);
      } else {
        console.log("[NOTIFICATION] supported:", false);
      }

      if ("serviceWorker" in navigator) {
        navigator.serviceWorker
          .register("/sw.js")
          .then((reg) => {
            console.log("[SERVICE_WORKER] registered successfully with scope:", reg.scope);
          })
          .catch((err) => {
            console.warn("[SERVICE_WORKER] registration failed:", err);
          });
      }
    }
  }, []);

  const requestPermission = async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      try {
        console.log("[NOTIFICATION] requesting permission from user...");
        const result = await Notification.requestPermission();
        console.log("[NOTIFICATION] permission result:", result);
        setNotificationPermission(result);
      } catch (err) {
        console.error("Failed to request permission", err);
      }
    }
  };

  // Robust native system notification helper
  const showNativeOSNotification = useCallback(async (title: string, options: NotificationOptions) => {
    if (typeof window === "undefined" || !("Notification" in window)) {
      console.warn("[NOTIFICATION] unsupported");
      return false;
    }

    if (Notification.permission !== "granted") {
      console.warn("[NOTIFICATION] permission not granted:", Notification.permission);
      return false;
    }

    try {
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) {
          await reg.showNotification(title, options);
          console.log("[NOTIFICATION] shown using service worker:", title);
          return true;
        }
      }

      const notif = new Notification(title, options);
      console.log("[NOTIFICATION] shown using Notification constructor:", title);
      notif.onclick = () => {
        window.focus();
        notif.close();
      };
      return true;
    } catch (err) {
      console.error("[NOTIFICATION] failed to display native notification:", err);
      return false;
    }
  }, []);

  // Helper: Test Native Notification
  const triggerTestNotification = async () => {
    console.log("[NOTIFICATION] test button clicked");
    console.log("[NOTIFICATION] permission:", Notification.permission);
    console.log("[NOTIFICATION] visibility:", document.visibilityState);
    console.log("[NOTIFICATION] focused:", document.hasFocus());

    if (Notification.permission !== "granted") {
      await requestPermission();
    }
    
    await showNativeOSNotification("LECTRA Test", {
      body: "System notifications are working outside the browser window.",
      icon: "/favicon.ico",
      tag: `lectra-test-${Date.now()}`,
      requireInteraction: false,
    });
  };

  // Dispatch Native System Notification (Cross-App when tab is not focused/visible)
  const triggerSystemNotification = useCallback((event: StudentEvent) => {
    if (typeof window === "undefined") return;

    try {
      const isVisible = document.visibilityState === "visible";
      const isFocused = document.hasFocus();
      const isBackground = !isVisible || !isFocused;

      console.log(`[NOTIFICATION] incoming event: type=${event.type}, student=${event.student_name}, background=${isBackground} (visible=${isVisible}, focused=${isFocused})`);
      
      if (isBackground) {
        const reasonLabel = event.type === "AWAY"
          ? event.reason === "PAGE_HIDDEN" ? "switched tabs" : event.reason === "FULLSCREEN_EXITED" ? "exited Focus Mode" : "left window"
          : event.type === "VIEWING" ? "returned" : event.type.toLowerCase();
        document.title = `(${event.student_name} ${reasonLabel}) ${originalTitleRef.current}`;

        const now = Date.now();
        const last = lastSystemNotificationRef.current[event.student_id];
        if (last && last.type === event.type && last.reason === event.reason && (now - last.time < 3000)) {
          console.log(`[NOTIFICATION] deduplicated repeat event for ${event.student_name}`);
          return;
        }
        lastSystemNotificationRef.current[event.student_id] = {
          type: event.type,
          reason: event.reason,
          time: now
        };

        let title = "LECTRA";
        let body = `${event.student_name} changed activity`;

        if (event.type === "AWAY") {
          if (event.reason === "PAGE_HIDDEN") {
            title = "LECTRA";
            body = `${event.student_name} switched tabs`;
          } else if (event.reason === "FULLSCREEN_EXITED") {
            title = "LECTRA";
            body = `${event.student_name} exited Focus Mode`;
          } else if (event.reason === "WINDOW_BLURRED") {
            title = "LECTRA";
            body = `${event.student_name} left lecture window`;
          } else {
            title = "LECTRA";
            body = `${event.student_name} switched away`;
          }
        } else if (event.type === "DISCONNECTED") {
          title = "LECTRA";
          body = `${event.student_name} disconnected from the lecture`;
        } else if (event.type === "JOIN") {
          title = "LECTRA";
          body = `${event.student_name} joined the lecture`;
        } else if (event.type === "VIEWING" && event.durationStr) {
          title = "LECTRA";
          body = `${event.student_name} returned to lecture`;
        } else {
          return;
        }

        console.log(`[NOTIFICATION] attempting OS notification: "${title}: ${body}"`);
        showNativeOSNotification(title, {
          body,
          icon: "/favicon.ico",
          tag: `lectra-${lectureId}-${event.student_id}-${event.type}`,
          requireInteraction: false
        });
      } else {
        document.title = originalTitleRef.current;
      }
    } catch (err) {
      console.warn("Could not dispatch notification safely", err);
    }
  }, [lectureId, showNativeOSNotification]);

  useEffect(() => {
    const handleFocus = () => {
      if (typeof document !== "undefined") {
        document.title = originalTitleRef.current;
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, []);

  // Add Apple-style In-App Toast
  const triggerInAppToast = useCallback((event: StudentEvent) => {
    const alertId = `${event.student_id}-${Date.now()}-${Math.random()}`;
    const toastItem = { ...event, id: alertId };
    
    setToastAlerts(prev => [toastItem, ...prev].slice(0, 4));

    const duration = event.type === "AWAY" ? 5000 : event.type === "DISCONNECTED" ? 6000 : 3500;

    setTimeout(() => {
      setToastAlerts(prev =>
        prev.map(t => (t.id === alertId ? { ...t, isExiting: true } : t))
      );
      setTimeout(() => {
        setToastAlerts(prev => prev.filter(t => t.id !== alertId));
      }, 250);
    }, duration);
  }, []);

  const handleIncomingEvent = useCallback((event: StudentEvent) => {
    console.log(`[FACULTY] event: ${event.type} for ${event.student_name}`);
    triggerInAppToast(event);
    triggerSystemNotification(event);
    setNotifications(prev => [event, ...prev].slice(0, 15));
  }, [triggerInAppToast, triggerSystemNotification]);

  // Fetch initial and updated participants (isolated function using functional updates)
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

  // Fetch faculty token ONCE on load (isolated from participants & toasts)
  useEffect(() => {
    if (!lectureId || !facultyId) return;
    const normalizedLectureId = lectureId.toUpperCase();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    
    fetch(`${apiUrl}/api/lectures/${normalizedLectureId}/token?faculty_id=${facultyId}`)
      .then(res => res.json())
      .then(data => {
        if (data.token) setToken(data.token);
        else setError("Failed to get broadcast token.");
      })
      .catch(err => setError(err.message));
  }, [lectureId, facultyId]);

  // Realtime SSE & Polling Lifecycle
  useEffect(() => {
    if (!lectureId || sessionEnded) return;
    const normalizedLectureId = lectureId.toUpperCase();
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

    fetchParticipants();
    const pollInterval = setInterval(fetchParticipants, 3000);

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

        handleIncomingEvent(event);
        
        if (event.type === "LECTURE_ENDED" || event.type === "END") {
          setSessionEnded(true);
        }
      } catch (err) {
        console.error("[SSE] error parsing message", err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn("[SSE] EventSource error, will auto-reconnect", err);
    };

    return () => {
      eventSource.close();
      clearInterval(pollInterval);
    };
  }, [lectureId, sessionEnded, fetchParticipants, handleIncomingEvent]);

  // Execute End Lecture
  const handleConfirmEnd = async () => {
    if (isEnding) return;
    setIsEnding(true);
    
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const res = await fetch(`${apiUrl}/api/lectures/${lectureId.toUpperCase()}/end`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });
      
      if (res.ok) {
        const data = await res.json();
        setSummary(data.summary || { total_students: Object.keys(students).length, total_events: notifications.length });
        setSessionEnded(true);
      } else {
        alert("Failed to end lecture on server. Please try again.");
      }
    } catch (err) {
      console.error("[FACULTY] Error ending lecture:", err);
      alert("Network error ending lecture.");
    } finally {
      setIsEnding(false);
      setShowEndConfirm(false);
    }
  };

  if (error) return <div className="p-8 text-red-500">{error}</div>;
  if (!token && !sessionEnded) return <div className="p-8 dark:text-white">Loading dashboard...</div>;

  if (sessionEnded) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-[#0a0a0a] flex items-center justify-center p-6">
        <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8 text-center space-y-6 animate-toast-enter">
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
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.total_students ?? Object.keys(students).length}</p>
                <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wider">Students</p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-gray-900 dark:text-white">{summary.total_events ?? notifications.length}</p>
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
      {/* Toast Stack */}
      <ToastStack toasts={toastAlerts} />

      {/* Confirmation Modal for End Lecture */}
      {showEndConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4 animate-toast-enter">
          <div className="bg-white dark:bg-[#1c1c1e] max-w-sm w-full rounded-2xl p-6 shadow-2xl border border-gray-200 dark:border-gray-800 space-y-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">End this lecture?</h3>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              All students will be disconnected from the live broadcast and session metrics will be saved.
            </p>
            <div className="flex space-x-3 pt-2">
              <button
                type="button"
                onClick={() => setShowEndConfirm(false)}
                disabled={isEnding}
                className="flex-1 px-4 py-2.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium text-sm transition"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmEnd}
                disabled={isEnding}
                className="flex-1 px-4 py-2.5 bg-red-600 hover:bg-red-700 text-white rounded-xl font-medium text-sm transition flex items-center justify-center space-x-2"
              >
                {isEnding ? <Loader2 className="w-4 h-4 animate-spin" /> : <span>End Lecture</span>}
              </button>
            </div>
          </div>
        </div>
      )}

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

          {/* Permission Status Indicator & Test Button */}
          <div className="relative hidden sm:flex items-center space-x-3">
            {notificationPermission === "granted" ? (
              <div className="flex items-center space-x-1.5 px-3 py-1 bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800/40 text-emerald-700 dark:text-emerald-300 rounded-full text-xs font-medium">
                <Bell className="w-3.5 h-3.5" />
                <span>OS Alerts On</span>
              </div>
            ) : notificationPermission === "denied" ? (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowPermissionHelp(prev => !prev)}
                  className="flex items-center space-x-1.5 px-3 py-1 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800/40 text-amber-700 dark:text-amber-300 hover:bg-amber-100 dark:hover:bg-amber-900/40 rounded-full text-xs font-medium transition cursor-pointer"
                >
                  <BellOff className="w-3.5 h-3.5" />
                  <span>OS Alerts Blocked</span>
                  <span className="underline opacity-80 ml-1">Fix</span>
                </button>
                {showPermissionHelp && (
                  <div className="absolute left-0 top-full mt-2 w-72 p-3.5 bg-white dark:bg-[#1f1f1f] rounded-xl shadow-xl border border-gray-200 dark:border-gray-700 z-50 text-xs space-y-2 animate-toast-enter">
                    <p className="font-semibold text-gray-900 dark:text-white">
                      Notifications are blocked in your browser
                    </p>
                    <p className="text-gray-600 dark:text-gray-300 leading-relaxed">
                      To receive alerts outside LECTRA (like when presenting in VS Code), click the <strong>lock / tune icon</strong> in your browser address bar and set <strong>Notifications</strong> to <strong>Allow</strong>.
                    </p>
                    <button
                      type="button"
                      onClick={() => setShowPermissionHelp(false)}
                      className="w-full py-1 text-center bg-gray-100 hover:bg-gray-200 dark:bg-gray-800 dark:hover:bg-gray-700 rounded-lg text-gray-800 dark:text-gray-200 font-medium"
                    >
                      Got it
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <button
                type="button"
                onClick={requestPermission}
                className="flex items-center space-x-1.5 px-3 py-1 bg-blue-50 dark:bg-blue-950/40 border border-blue-200 dark:border-blue-800 text-blue-700 dark:text-blue-300 hover:bg-blue-100 rounded-full text-xs font-medium transition"
              >
                <Bell className="w-3.5 h-3.5" />
                <span>Enable OS Alerts</span>
              </button>
            )}

            <button
              type="button"
              onClick={triggerTestNotification}
              className="px-2.5 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition border border-gray-200 dark:border-gray-700"
            >
              Test OS Notification
            </button>

            <button
              type="button"
              onClick={() => {
                const pairUrl = `lectra://connect?lecture=${lectureId.toUpperCase()}&apiUrl=${encodeURIComponent(process.env.NEXT_PUBLIC_API_URL || 'https://lectra-xk3q.onrender.com')}`;
                window.location.href = pairUrl;
                navigator.clipboard.writeText(lectureId.toUpperCase()).then(() => {
                  alert(`Class Code ${lectureId.toUpperCase()} copied! If the desktop companion is installed, it will connect automatically. Otherwise, paste ${lectureId.toUpperCase()} into the LECTRA Companion app.`);
                }).catch(() => {
                  alert(`Class Code: ${lectureId.toUpperCase()}`);
                });
              }}
              className="px-2.5 py-1 text-xs font-medium text-blue-700 dark:text-blue-300 bg-blue-50 dark:bg-blue-950/40 hover:bg-blue-100 rounded-lg transition border border-blue-200 dark:border-blue-800"
            >
              Connect Desktop Alerts
            </button>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setShowEndConfirm(true)}
          className="px-4 py-2 bg-red-50 text-red-600 hover:bg-red-100 dark:bg-red-900/20 dark:text-red-400 dark:hover:bg-red-900/30 rounded-lg text-sm font-medium transition-colors"
        >
          End Lecture
        </button>
      </header>

      <main className="flex-1 p-6 max-w-7xl mx-auto w-full grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left Column: Broadcast Control with stable LiveKit Room */}
        <div className="lg:col-span-2 flex flex-col space-y-6">
          <LiveKitRoom
            video={false}
            audio={false}
            token={token}
            serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880"}
            connect={!!token}
            className="flex-1 flex flex-col"
            onDisconnected={() => console.log("LiveKitRoom disconnected")}
            onError={(err) => console.error("LiveKitRoom error:", err)}
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
              <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
                {notifications.map((n, idx) => (
                  <div key={idx} className="flex items-start space-x-3 text-sm">
                    <div className={`mt-0.5 w-2 h-2 rounded-full ${n.type === 'AWAY' ? 'bg-amber-500' : ['VIEWING', 'RECONNECTED'].includes(n.type) ? 'bg-emerald-500' : n.type === 'JOIN' ? 'bg-blue-500' : 'bg-gray-400'}`} />
                    <p className="text-gray-600 dark:text-gray-300 text-xs">
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
  const [shareState, setShareState] = useState<"IDLE" | "STARTING" | "SHARING" | "STOPPING">("IDLE");
  const [shareError, setShareError] = useState<string | null>(null);

  const videoElementRef = useRef<HTMLVideoElement | null>(null);

  // Attach local screen track to video preview
  useEffect(() => {
    if (screenTrack && videoElementRef.current) {
      screenTrack.attach(videoElementRef.current);
    }
    return () => {
      if (screenTrack) {
        screenTrack.detach();
      }
    };
  }, [screenTrack]);

  const startScreenShare = async () => {
    if (shareState !== "IDLE" || connectionState !== ConnectionState.Connected || !localParticipant) {
      console.warn("[FACULTY SCREEN] cannot start share: state=", shareState, "conn=", connectionState);
      return;
    }
    
    setShareState("STARTING");
    setShareError(null);
    console.log("[FACULTY SCREEN] share requested by faculty");

    try {
      console.log("[FACULTY SCREEN] calling setScreenShareEnabled(true)...");
      const publication = await localParticipant.setScreenShareEnabled(true, {
        audio: false,
        selfBrowserSurface: "include",
        surfaceSwitching: "include",
      });

      console.log("[FACULTY SCREEN] setScreenShareEnabled completed:", publication);
      
      // Look up the published screen-share track
      const screenPub = localParticipant.getTrackPublication(Track.Source.ScreenShare);
      const track = (screenPub?.track || publication?.track) as LocalVideoTrack | undefined;

      if (track) {
        console.log("[FACULTY SCREEN] track created and verified:", {
          trackSid: track.sid,
          source: track.source,
          kind: track.kind
        });
        setScreenTrack(track);
        setShareState("SHARING");

        // Handle native browser stop button
        track.on("ended", () => {
          console.log("[FACULTY SCREEN] native track ended event");
          stopScreenShare();
        });
      } else {
        console.log("[FACULTY SCREEN] screen share enabled, waiting for track publication...");
        setShareState("SHARING");
      }

      // Notify backend of LIVE status
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/lectures/${lectureId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "LIVE" })
      }).catch(console.error);

    } catch (e: any) {
      console.error("[FACULTY SCREEN] Could not start screen share:", e);
      setShareState("IDLE");
      if (e.name === "NotAllowedError") {
        setShareError("Screen sharing was cancelled or blocked by browser permission.");
      } else {
        setShareError(e.message || "Unable to start screen sharing. Please check permissions.");
      }
    }
  };

  const stopScreenShare = async () => {
    if (shareState === "STOPPING") return;
    setShareState("STOPPING");
    console.log("[FACULTY SCREEN] stopping screen share...");

    try {
      if (localParticipant) {
        await localParticipant.setScreenShareEnabled(false);
      }
      if (screenTrack) {
        screenTrack.stop();
        setScreenTrack(null);
      }
      
      fetch(`${process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000'}/api/lectures/${lectureId}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: "WAITING" })
      }).catch(console.error);
    } catch (err) {
      console.error("[FACULTY SCREEN] Error stopping screen share:", err);
    } finally {
      setShareState("IDLE");
    }
  };

  return (
    <div className="flex-1 bg-gray-900 rounded-2xl overflow-hidden relative flex items-center justify-center border border-gray-800 shadow-xl min-h-[420px]">
      {screenTrack ? (
        <>
          <video
            ref={videoElementRef}
            className="w-full h-full object-contain"
            autoPlay
            muted
            playsInline
          />
          <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex items-center space-x-4 bg-gray-900/85 backdrop-blur-md px-6 py-3 rounded-2xl border border-gray-700 shadow-2xl">
            <div className="flex items-center space-x-2 text-emerald-400 font-medium text-sm">
              <span className="relative flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
              <span>Broadcasting Live</span>
            </div>
            <div className="w-px h-6 bg-gray-700" />
            <button
              type="button"
              onClick={stopScreenShare}
              disabled={shareState === "STOPPING"}
              className="flex items-center space-x-2 text-red-400 hover:text-red-300 font-medium text-sm transition-colors cursor-pointer"
            >
              <StopCircle className="w-4 h-4" />
              <span>{shareState === "STOPPING" ? "Stopping..." : "Stop Share"}</span>
            </button>
          </div>
        </>
      ) : (
        <div className="text-center space-y-6 max-w-sm p-6">
          <div className="w-20 h-20 bg-gray-800 rounded-full flex items-center justify-center mx-auto">
            <MonitorUp className="w-10 h-10 text-gray-400" />
          </div>
          <div>
            <h3 className="text-xl font-medium text-white mb-2">Ready to Broadcast</h3>
            <div className="flex items-center justify-center space-x-2">
              <div className={`w-2.5 h-2.5 rounded-full ${connectionState === ConnectionState.Connected ? "bg-green-500" : connectionState === ConnectionState.Connecting ? "bg-yellow-500 animate-pulse" : "bg-red-500"}`}></div>
              <span className="text-sm font-medium text-gray-400">
                {connectionState === ConnectionState.Connected ? "LiveKit server connected" : 
                 connectionState === ConnectionState.Connecting ? "Connecting to LiveKit..." : 
                 `Connection: ${connectionState}`}
              </span>
            </div>
            {shareError && (
              <p className="mt-3 text-xs text-amber-400 bg-amber-950/40 border border-amber-800/40 p-2.5 rounded-xl">
                {shareError}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={startScreenShare}
            disabled={connectionState !== ConnectionState.Connected || shareState === "STARTING"}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:bg-gray-800 disabled:text-gray-500 text-white py-3.5 px-6 rounded-xl font-medium transition-colors shadow-lg shadow-blue-900/20 flex justify-center items-center space-x-2 cursor-pointer disabled:cursor-not-allowed"
          >
            {shareState === "STARTING" ? (
              <>
                <Loader2 className="w-5 h-5 animate-spin" />
                <span>Opening Screen Picker...</span>
              </>
            ) : (
              <span>Select Screen to Share</span>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
