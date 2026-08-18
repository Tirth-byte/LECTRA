"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { useSearchParams } from "next/navigation";
import { 
  LiveKitRoom, 
  VideoTrack, 
  useTracks,
  useConnectionState,
  RoomAudioRenderer
} from "@livekit/components-react";
import { Track, ConnectionState } from "livekit-client";
import { Maximize, ShieldAlert, MonitorPlay } from "lucide-react";

import { Suspense } from "react";

function StudentViewerContent() {
  const searchParams = useSearchParams();
  const lectureId = searchParams.get("lectureId") as string;
  const token = searchParams.get("token");
  const studentId = searchParams.get("studentId");

  const [isFullscreen, setIsFullscreen] = useState(false);
  const actualStateRef = useRef<"VIEWING" | "AWAY" | null>(null);
  
  const reportPresence = useCallback(async (eventType: "VIEWING" | "AWAY" | "LEAVE", reason?: string) => {
    if (!lectureId || !studentId) return;
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      await fetch(`${apiUrl}/api/lectures/${lectureId}/presence?student_id=${studentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: eventType, reason: reason })
      });
    } catch (e) {
      console.error("Failed to report presence", e);
    }
  }, [lectureId, studentId]);

  const calculatePresence = useCallback(() => {
    const visible = document.visibilityState === "visible";
    const focused = document.hasFocus();
    const fullscreen = !!document.fullscreenElement;

    if (!visible) return { state: "AWAY" as const, reason: "PAGE_HIDDEN" };
    if (!focused) return { state: "AWAY" as const, reason: "WINDOW_BLURRED" };
    if (!fullscreen) return { state: "AWAY" as const, reason: "FULLSCREEN_EXITED" };
    
    return { state: "VIEWING" as const, reason: undefined };
  }, []);

  const updatePresence = useCallback(() => {
    const { state, reason } = calculatePresence();
    if (actualStateRef.current !== state) {
      actualStateRef.current = state;
      reportPresence(state, reason);
    }
  }, [calculatePresence, reportPresence]);

  const [sessionStatus, setSessionStatus] = useState("WAITING");

  useEffect(() => {
    // SSE for status updates
    const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const eventSource = new EventSource(`${apiUrl}/api/lectures/${lectureId}/events`);
    
    eventSource.onmessage = (e) => {
      const data = JSON.parse(e.data);
      if (data.type === "STATUS_CHANGE") {
        setSessionStatus(data.status);
      } else if (data.type === "END") {
        setSessionStatus("ENDED");
      }
    };

    const handleVisibilityChange = updatePresence;
    
    const handleBlur = () => {
      setTimeout(updatePresence, 200);
    };

    const handleFocus = updatePresence;

    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      updatePresence();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("fullscreenchange", handleFullscreenChange);

    // Initial check (delay a bit)
    setTimeout(updatePresence, 500);

    // Heartbeat
    const heartbeatInterval = setInterval(() => {
      const state = actualStateRef.current || "AWAY";
      if (!lectureId || !studentId) return;
      fetch(`${apiUrl}/api/lectures/${lectureId}/heartbeat?student_id=${studentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state })
      }).catch(() => {});
    }, 3000);

    return () => {
      eventSource.close();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      clearInterval(heartbeatInterval);
      
      fetch(`${apiUrl}/api/lectures/${lectureId}/presence?student_id=${studentId}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "LEAVE" }),
        keepalive: true
      }).catch(() => {});
    };
  }, [updatePresence, lectureId, studentId]);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable full-screen mode: ${err.message}`);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  if (!token) return <div className="p-8 text-white">Missing authentication token.</div>;

  if (sessionStatus === "ENDED") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500 h-screen w-full bg-black text-white">
        <ShieldAlert className="w-16 h-16 opacity-50 text-red-500" />
        <p className="text-2xl font-bold">The lecture has ended</p>
        <a href="/student" className="px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition">Return to Home</a>
      </div>
    );
  }

  if (!isFullscreen) {
    return (
      <div className="min-h-screen bg-black flex flex-col items-center justify-center text-white p-6 text-center space-y-6">
        <ShieldAlert className="w-16 h-16 text-amber-500" />
        <h1 className="text-2xl font-bold">Focus Mode is Enabled</h1>
        <p className="text-gray-400 max-w-md">
          This lecture requires Focus Mode. You must enter fullscreen to join the live broadcast. Lectra will notify the instructor if you leave the lecture view.
        </p>
        <button 
          onClick={toggleFullscreen}
          className="px-6 py-3 bg-amber-600 hover:bg-amber-500 text-white font-medium rounded-xl transition-colors flex items-center space-x-2"
        >
          <Maximize className="w-5 h-5" />
          <span>Enter Fullscreen to Join</span>
        </button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black flex flex-col text-white">
      <main className="flex-1 relative">
        <LiveKitRoom
          video={false}
          audio={false}
          token={token}
          serverUrl={process.env.NEXT_PUBLIC_LIVEKIT_URL || "ws://localhost:7880"}
          connect={true}
          className="w-full h-full flex flex-col items-center justify-center bg-black"
          onDisconnected={() => console.error("LiveKitRoom disconnected")}
          onError={(error) => console.error("LiveKitRoom error:", error)}
        >
          <ScreenViewer status={sessionStatus} />
          <RoomAudioRenderer />
        </LiveKitRoom>
      </main>
    </div>
  );
}

export default function StudentViewer() {
  return (
    <Suspense fallback={<div className="p-8 text-white min-h-screen bg-black">Loading viewer...</div>}>
      <StudentViewerContent />
    </Suspense>
  );
}

function ScreenViewer({ status }: { status: string }) {
  const tracks = useTracks([Track.Source.ScreenShare, Track.Source.ScreenShareAudio]);
  const videoTrack = tracks.find((t) => t.publication.kind === "video");
  const connectionState = useConnectionState();

  if (connectionState === ConnectionState.Disconnected) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500 h-full w-full">
        <ShieldAlert className="w-16 h-16 opacity-50" />
        <p className="text-lg text-amber-500">Disconnected from server.</p>
      </div>
    );
  }

  if (connectionState === ConnectionState.Connecting || connectionState === ConnectionState.Reconnecting) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500 h-full w-full">
        <MonitorPlay className="w-16 h-16 opacity-50" />
        <p className="text-lg text-amber-500">LiveKit status: {connectionState}...</p>
      </div>
    );
  }

  if (status === "WAITING") {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500">
        <MonitorPlay className="w-16 h-16 opacity-50" />
        <p className="text-lg animate-pulse">Waiting for lecturer to start broadcasting...</p>
      </div>
    );
  }

  if (!videoTrack) {
    return (
      <div className="flex flex-col items-center justify-center space-y-4 text-gray-500">
        <MonitorPlay className="w-16 h-16 opacity-50" />
        <p className="text-lg animate-pulse">Waiting for stream track...</p>
      </div>
    );
  }

  return (
    <div className="w-full h-full p-2 lg:p-4">
      <div className="w-full h-full bg-[#111] rounded-2xl overflow-hidden border border-gray-800 relative shadow-2xl">
        <VideoTrack trackRef={videoTrack} className="w-full h-full object-contain" />
      </div>
    </div>
  );
}
