// LECTRA Faculty Desktop Companion Overlay Runtime

type StudentEvent = {
  id: string;
  type: string;
  student_id: string;
  student_name: string;
  timestamp: string;
  reason?: string;
  durationStr?: string;
  isExiting?: boolean;
};

interface CompanionState {
  lectureId: string | null;
  apiUrl: string;
  connected: boolean;
  activeCount: number;
  showReturnAlerts: boolean;
  alerts: StudentEvent[];
}

const state: CompanionState = {
  lectureId: null,
  apiUrl: "https://lectra-xk3q.onrender.com",
  connected: false,
  activeCount: 0,
  showReturnAlerts: true,
  alerts: []
};

// Check pairing parameters from URL or localStorage
const urlParams = new URLSearchParams(window.location.search);
const pairedLecture = urlParams.get("lecture") || localStorage.getItem("lectra_lecture_id");
const customApiUrl = urlParams.get("apiUrl") || localStorage.getItem("lectra_api_url");

if (pairedLecture) {
  state.lectureId = pairedLecture.toUpperCase();
  localStorage.setItem("lectra_lecture_id", state.lectureId);
}
if (customApiUrl) {
  state.apiUrl = customApiUrl;
  localStorage.setItem("lectra_api_url", state.apiUrl);
}

// Deduplication reference
const lastAlertMap = new Map<string, { type: string; reason?: string; time: number }>();

function renderApp() {
  const app = document.getElementById("app");
  if (!app) return;

  if (!state.lectureId) {
    app.innerHTML = `
      <div class="companion-card pointer-interactive enter" style="text-align: center; max-width: 350px;">
        <div style="display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 8px;">
          <div style="width: 28px; height: 28px; border-radius: 8px; background: #2563eb; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 14px; color: #fff;">
            L
          </div>
          <span style="font-size: 14px; font-weight: 700; color: #fff;">LECTRA Companion</span>
        </div>
        <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 14px; line-height: 1.45;">
          Connect to your active lecture to receive floating focus alerts above VS Code, PowerPoint, and Terminal.
        </div>
        <div style="display: flex; gap: 8px;">
          <input 
            id="lectureInput" 
            type="text" 
            placeholder="Class Code (e.g. XPEK47)" 
            style="flex: 1; padding: 8px 12px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.18); background: rgba(0,0,0,0.6); color: #fff; font-size: 13px; text-transform: uppercase; outline: none; font-weight: 600; letter-spacing: 0.05em;"
          />
          <button 
            id="pairBtn"
            style="padding: 8px 16px; background: #2563eb; color: #fff; font-weight: 600; font-size: 12px; border: none; border-radius: 10px; cursor: pointer; transition: background 0.15s;"
          >
            Connect
          </button>
        </div>
      </div>
    `;

    document.getElementById("pairBtn")?.addEventListener("click", () => {
      const input = (document.getElementById("lectureInput") as HTMLInputElement)?.value.trim();
      if (input) {
        state.lectureId = input.toUpperCase();
        localStorage.setItem("lectra_lecture_id", state.lectureId);
        connectSSE();
      }
    });

    document.getElementById("lectureInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        document.getElementById("pairBtn")?.click();
      }
    });
    return;
  }

  // Active Pairing View
  let html = `
    <div class="companion-card pointer-interactive" style="padding: 8px 12px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 7px; height: 7px; border-radius: 9999px; background: ${state.connected ? '#10b981' : '#f59e0b'};"></span>
        <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: #e4e4e7;">LECTRA · ${state.lectureId}</span>
        <span style="font-size: 10px; color: ${state.connected ? '#34d399' : '#fbbf24'}; font-weight: 500;">
          ${state.connected ? 'Connected' : 'Reconnecting…'}
        </span>
      </div>
      <div style="display: flex; align-items: center; gap: 6px;">
        <button id="testAlertBtn" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #d4d4d8; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 6px; cursor: pointer;">
          Test Alert
        </button>
        <button id="unpairBtn" title="Disconnect" style="background: transparent; border: none; color: #71717a; font-size: 11px; padding: 2px 4px; cursor: pointer;">
          ✕
        </button>
      </div>
    </div>
  `;

  // Stack of active alerts (at most 3)
  state.alerts.forEach((alert) => {
    const isAway = alert.type === "AWAY";
    const isViewing = alert.type === "VIEWING";
    const isJoin = alert.type === "JOIN";
    const isEnded = alert.type === "LECTURE_ENDED";

    const badgeClass = isAway ? "badge-away" : isViewing ? "badge-viewing" : isJoin ? "badge-join" : "badge-disconnect";
    const icon = isAway ? "⚠" : isViewing ? "✓" : isJoin ? "●" : "✕";
    const title = isAway
      ? `${alert.student_name} switched tabs`
      : isViewing
      ? `${alert.student_name} returned`
      : isJoin
      ? `${alert.student_name} joined`
      : isEnded
      ? "Lecture Ended"
      : `${alert.student_name} disconnected`;

    const sub = isAway
      ? alert.reason === "PAGE_HIDDEN"
        ? "Away · Switched browser tab or minimized"
        : alert.reason === "FULLSCREEN_EXITED"
        ? "Away · Exited Focus Mode"
        : alert.reason === "WINDOW_BLURRED"
        ? "Away · Switched active window"
        : "Away from lecture broadcast"
      : isViewing
      ? alert.durationStr
        ? `Watching · Returned after ${alert.durationStr}`
        : "Watching · Active in lecture"
      : isJoin
      ? "Joined live session"
      : isEnded
      ? "Class session ended by instructor"
      : "Lost connection to broadcast";

    html += `
      <div class="companion-card pointer-interactive ${alert.isExiting ? 'exit' : 'enter'}" style="margin-bottom: 8px;">
        <div style="display: flex; align-items: flex-start; justify-content: space-between; margin-bottom: 3px;">
          <div style="display: flex; align-items: center; gap: 6px;">
            <span class="status-pill ${badgeClass}">
              <span>${icon}</span>
              <span>${alert.type}</span>
            </span>
            <span style="font-size: 12px; font-weight: 700; color: #f4f4f5;">${title}</span>
          </div>
          <span style="font-size: 10px; color: #71717a;">Just now</span>
        </div>
        <div style="font-size: 11px; color: #a1a1aa; padding-left: 2px;">
          ${sub}
        </div>
      </div>
    `;
  });

  app.innerHTML = html;

  document.getElementById("unpairBtn")?.addEventListener("click", () => {
    localStorage.removeItem("lectra_lecture_id");
    state.lectureId = null;
    state.alerts = [];
    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }
    renderApp();
  });

  document.getElementById("testAlertBtn")?.addEventListener("click", () => {
    pushAlert({
      id: `test-${Date.now()}`,
      type: "AWAY",
      student_id: "test-student-1",
      student_name: "Tirth",
      reason: "PAGE_HIDDEN",
      timestamp: new Date().toISOString()
    });
  });
}

function pushAlert(event: StudentEvent) {
  // If quiet return alerts are disabled
  if (event.type === "VIEWING" && !state.showReturnAlerts) {
    return;
  }

  // Deduplicate identical alerts within 3.5 seconds
  const now = Date.now();
  const last = lastAlertMap.get(event.student_id);
  if (last && last.type === event.type && last.reason === event.reason && (now - last.time < 3500)) {
    return;
  }
  lastAlertMap.set(event.student_id, {
    type: event.type,
    reason: event.reason,
    time: now
  });

  const alertId = `${event.student_id}-${Date.now()}-${Math.random()}`;
  const alertItem = { ...event, id: alertId };

  // Stack up to 3 alerts
  state.alerts = [alertItem, ...state.alerts].slice(0, 3);
  renderApp();

  const duration = event.type === "AWAY" ? 5000 : event.type === "DISCONNECTED" ? 6000 : 3500;

  setTimeout(() => {
    state.alerts = state.alerts.map((a) => (a.id === alertId ? { ...a, isExiting: true } : a));
    renderApp();
    setTimeout(() => {
      state.alerts = state.alerts.filter((a) => a.id !== alertId);
      renderApp();
    }, 200);
  }, duration);
}

let activeEventSource: EventSource | null = null;
let reconnectTimer: any = null;

function connectSSE() {
  if (!state.lectureId) return;
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const url = `${state.apiUrl}/api/lectures/${state.lectureId}/events`;
  console.log("[COMPANION_SSE] Connecting to:", url);

  activeEventSource = new EventSource(url);

  activeEventSource.onopen = () => {
    console.log("[COMPANION_SSE] Connected to lecture:", state.lectureId);
    state.connected = true;
    renderApp();
  };

  activeEventSource.onmessage = (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === "PING" || data.type === "STATUS_CHANGE") return;

      if (data.type === "LECTURE_ENDED" || data.type === "END") {
        console.log("[COMPANION_SSE] Lecture ended, resetting session.");
        pushAlert({
          id: `ended-${Date.now()}`,
          type: "LECTURE_ENDED",
          student_id: "system",
          student_name: "Lecture Ended",
          reason: "Instructor closed session",
          timestamp: new Date().toISOString()
        });
        state.connected = false;
        if (activeEventSource) {
          activeEventSource.close();
          activeEventSource = null;
        }
        renderApp();
        return;
      }

      console.log("[COMPANION_SSE] Received student event:", data);
      pushAlert({
        id: `${data.student_id}-${Date.now()}`,
        type: data.type,
        student_id: data.student_id,
        student_name: data.student_name || "Student",
        reason: data.reason,
        timestamp: data.timestamp
      });
    } catch (err) {
      console.error("[COMPANION_SSE] parse error:", err);
    }
  };

  activeEventSource.onerror = (err) => {
    console.warn("[COMPANION_SSE] Connection error, will auto-reconnect:", err);
    state.connected = false;
    renderApp();
  };

  renderApp();
}

// Initial mount
if (state.lectureId) {
  connectSSE();
} else {
  renderApp();
}
