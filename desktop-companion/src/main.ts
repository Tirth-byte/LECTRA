// LECTRA Faculty Desktop Alert Companion Overlay Runtime

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
  alerts: StudentEvent[];
}

const state: CompanionState = {
  lectureId: null,
  apiUrl: "https://lectra-xk3q.onrender.com",
  connected: false,
  activeCount: 0,
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
      <div class="companion-card pointer-interactive enter" style="text-align: center;">
        <div style="font-size: 13px; font-weight: 700; color: #fff; margin-bottom: 6px;">
          LECTRA Alert Companion
        </div>
        <div style="font-size: 11px; color: #a1a1aa; margin-bottom: 12px; line-height: 1.4;">
          Pair with your active lecture to receive floating focus alerts over VS Code & apps.
        </div>
        <div style="display: flex; gap: 8px;">
          <input 
            id="lectureInput" 
            type="text" 
            placeholder="Class Code (e.g. ABC123)" 
            style="flex: 1; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.15); background: rgba(0,0,0,0.5); color: #fff; font-size: 12px; text-transform: uppercase; outline: none;"
          />
          <button 
            id="pairBtn"
            style="padding: 6px 14px; background: #2563eb; color: #fff; font-weight: 600; font-size: 11px; border: none; border-radius: 8px; cursor: pointer;"
          >
            Pair
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
    return;
  }

  // Active Pairing View
  let html = `
    <div class="companion-card pointer-interactive" style="padding: 8px 12px; margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
      <div style="display: flex; align-items: center; gap: 8px;">
        <span style="display: inline-block; width: 7px; height: 7px; border-radius: 9999px; background: ${state.connected ? '#10b981' : '#f59e0b'};"></span>
        <span style="font-size: 11px; font-weight: 700; letter-spacing: 0.05em; color: #e4e4e7;">${state.lectureId}</span>
      </div>
      <div style="display: flex; gap: 6px;">
        <button id="testAlertBtn" style="background: rgba(255,255,255,0.08); border: 1px solid rgba(255,255,255,0.12); color: #d4d4d8; font-size: 10px; font-weight: 600; padding: 3px 8px; border-radius: 6px; cursor: pointer;">
          Test
        </button>
        <button id="unpairBtn" style="background: transparent; border: none; color: #71717a; font-size: 10px; padding: 3px 4px; cursor: pointer;">
          ✕
        </button>
      </div>
    </div>
  `;

  // Stack of active alerts
  state.alerts.forEach((alert) => {
    const isAway = alert.type === "AWAY";
    const isViewing = alert.type === "VIEWING";
    const isJoin = alert.type === "JOIN";
    const isDisconnect = alert.type === "DISCONNECTED";

    const badgeClass = isAway ? "badge-away" : isViewing ? "badge-viewing" : isJoin ? "badge-join" : "badge-disconnect";
    const icon = isAway ? "⚠" : isViewing ? "✓" : isJoin ? "●" : "✕";
    const title = isAway
      ? `${alert.student_name} switched away`
      : isViewing
      ? `${alert.student_name} returned`
      : isJoin
      ? `${alert.student_name} joined`
      : `${alert.student_name} disconnected`;

    const sub = isAway
      ? alert.reason === "PAGE_HIDDEN"
        ? "Switched browser tab or minimized"
        : alert.reason === "FULLSCREEN_EXITED"
        ? "Exited Focus Mode"
        : alert.reason === "WINDOW_BLURRED"
        ? "Left lecture window"
        : "Switched away from lecture"
      : alert.durationStr
      ? `Returned after ${alert.durationStr}`
      : "Active in lecture broadcast";

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
          <span style="font-size: 10px; color: #71717a;">Now</span>
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
  // Deduplicate within 3.5s for same student & type & reason
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

  // Keep stack at most 3 items
  state.alerts = [alertItem, ...state.alerts].slice(0, 3);
  renderApp();

  const duration = event.type === "AWAY" ? 5000 : 3500;

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

function connectSSE() {
  if (!state.lectureId) return;
  if (activeEventSource) {
    activeEventSource.close();
  }

  const url = `${state.apiUrl}/api/lectures/${state.lectureId}/events`;
  console.log("[COMPANION_SSE] Connecting to", url);

  activeEventSource = new EventSource(url);

  activeEventSource.onopen = () => {
    console.log("[COMPANION_SSE] Connected to lecture", state.lectureId);
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
          type: "DISCONNECTED",
          student_id: "system",
          student_name: "Lecture Ended",
          reason: "Instructor closed session",
          timestamp: new Date().toISOString()
        });
        state.connected = false;
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
    console.warn("[COMPANION_SSE] Error/reconnecting:", err);
    state.connected = false;
    renderApp();
  };

  renderApp();
}

// Initialize
if (state.lectureId) {
  connectSSE();
} else {
  renderApp();
}
