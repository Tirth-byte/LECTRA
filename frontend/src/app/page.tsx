import Link from "next/link";
import { MonitorPlay, Users } from "lucide-react";

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center justify-center bg-gray-50 dark:bg-[#0a0a0a] p-6">
      <div className="max-w-2xl w-full space-y-12 text-center">
        <div className="space-y-4">
          <h1 className="text-4xl md:text-5xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
            Lectra
          </h1>
          <p className="text-lg text-gray-600 dark:text-gray-400 max-w-lg mx-auto">
            A premium classroom screen-broadcasting platform. Designed for faculty to teach and students to follow effortlessly.
          </p>
        </div>

        <div className="grid md:grid-cols-2 gap-6">
          <Link 
            href="/faculty"
            className="group relative flex flex-col items-center p-8 bg-white dark:bg-[#1a1a1a] rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200"
          >
            <div className="h-12 w-12 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <MonitorPlay className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-medium text-gray-900 dark:text-gray-100 mb-2">Faculty</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
              Start a new lecture, broadcast your screen, and monitor student presence.
            </p>
          </Link>

          <Link 
            href="/student"
            className="group relative flex flex-col items-center p-8 bg-white dark:bg-[#1a1a1a] rounded-2xl border border-gray-200 dark:border-gray-800 shadow-sm hover:shadow-md transition-all duration-200"
          >
            <div className="h-12 w-12 bg-emerald-100 dark:bg-emerald-900/30 text-emerald-600 dark:text-emerald-400 rounded-full flex items-center justify-center mb-4 group-hover:scale-110 transition-transform">
              <Users className="w-6 h-6" />
            </div>
            <h2 className="text-xl font-medium text-gray-900 dark:text-gray-100 mb-2">Student</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400 text-center">
              Join an active lecture with a class code to follow along live.
            </p>
          </Link>
        </div>
      </div>
    </main>
  );
}
