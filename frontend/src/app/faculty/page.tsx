"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2, Bell, CheckCircle2 } from "lucide-react";

export default function FacultyStart() {
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<string>("default");
  const router = useRouter();

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationPermission(Notification.permission);
    }
  }, []);

  const requestNotificationAccess = async () => {
    if (typeof window !== "undefined" && "Notification" in window) {
      try {
        const result = await Notification.requestPermission();
        setNotificationPermission(result);
      } catch (err) {
        console.error("Error requesting notification permission:", err);
      }
    }
  };

  const handleStart = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;

    setLoading(true);
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const res = await fetch(`${apiUrl}/api/lectures`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (res.ok) {
        const data = await res.json();
        const facultyId = data.faculty_id || "test-faculty";
        router.push(`/faculty/room?lectureId=${data.id}&facultyId=${facultyId}`);
      } else {
        console.error("Failed to start lecture");
      }
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#0a0a0a] p-6">
      <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8 space-y-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">Start a Lecture</h1>
          <p className="text-gray-500 dark:text-gray-400">
            Enter a topic to generate a join code for your students.
          </p>
        </div>

        {notificationPermission === "default" && typeof window !== "undefined" && "Notification" in window && (
          <div className="p-4 bg-blue-50/70 dark:bg-blue-950/30 border border-blue-200/60 dark:border-blue-800/40 rounded-xl space-y-2.5">
            <div className="flex items-center space-x-2.5 text-blue-900 dark:text-blue-200 font-medium text-sm">
              <Bell className="w-4 h-4 text-blue-600 dark:text-blue-400 shrink-0" />
              <span>Enable Cross-App Alerts</span>
            </div>
            <p className="text-xs text-blue-700/80 dark:text-blue-300/70 leading-relaxed">
              Receive instant student focus alerts even when presenting in VS Code, PowerPoint, or Terminal.
            </p>
            <button
              type="button"
              onClick={requestNotificationAccess}
              className="text-xs font-semibold px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors shadow-sm"
            >
              Enable Alerts
            </button>
          </div>
        )}

        {notificationPermission === "granted" && (
          <div className="flex items-center space-x-2 px-3.5 py-2 bg-emerald-50/70 dark:bg-emerald-950/30 border border-emerald-200/60 dark:border-emerald-800/40 rounded-xl text-xs text-emerald-800 dark:text-emerald-300 font-medium">
            <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
            <span>Cross-app lecture alerts active</span>
          </div>
        )}

        <form onSubmit={handleStart} className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="title" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Lecture Topic
            </label>
            <input
              id="title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Advanced Data Structures"
              className="w-full px-4 py-3 bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all dark:text-white"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading || !title.trim()}
            className="w-full flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <span>Start Lecture</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
