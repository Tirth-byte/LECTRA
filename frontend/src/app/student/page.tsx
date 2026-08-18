"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Loader2 } from "lucide-react";

export default function StudentJoin() {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();

  const handleJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!code.trim() || !name.trim()) return;

    setLoading(true);
    setError("");
    
    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
      const res = await fetch(`${apiUrl}/api/lectures/${code.toUpperCase()}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      
      if (res.ok) {
        const data = await res.json();
        // Pass token and studentId via URL or session storage. 
        // For MVP, we pass via URL params.
        router.push(`/student/room?lectureId=${data.lecture_id}&token=${data.token}&studentId=${data.student_id}`);
      } else {
        const err = await res.json();
        setError(err.detail || "Failed to join class");
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-[#0a0a0a] p-6">
      <div className="max-w-md w-full bg-white dark:bg-[#1a1a1a] rounded-2xl shadow-sm border border-gray-200 dark:border-gray-800 p-8">
        <h1 className="text-2xl font-semibold text-gray-900 dark:text-white mb-2">Join a Lecture</h1>
        <p className="text-gray-500 dark:text-gray-400 mb-8">
          Enter your class code and name to follow the live broadcast.
        </p>

        {error && (
          <div className="mb-6 p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 text-sm rounded-xl">
            {error}
          </div>
        )}

        <form onSubmit={handleJoin} className="space-y-6">
          <div className="space-y-4">
            <div className="space-y-2">
              <label htmlFor="code" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Class Code
              </label>
              <input
                id="code"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="e.g. ABCD-1234"
                className="w-full px-4 py-3 bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all uppercase tracking-wider dark:text-white"
                required
              />
            </div>
            
            <div className="space-y-2">
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                Your Name
              </label>
              <input
                id="name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="First and Last Name"
                className="w-full px-4 py-3 bg-gray-50 dark:bg-[#2a2a2a] border border-gray-200 dark:border-gray-700 rounded-xl focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none transition-all dark:text-white"
                required
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading || !code.trim() || !name.trim()}
            className="w-full flex items-center justify-center space-x-2 bg-blue-600 hover:bg-blue-700 text-white py-3 rounded-xl font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? (
              <Loader2 className="w-5 h-5 animate-spin" />
            ) : (
              <>
                <span>Join Lecture</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
