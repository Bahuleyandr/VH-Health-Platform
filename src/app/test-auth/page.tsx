// src/app/test-auth/page.tsx
"use client";

import { useState } from "react";
import { API_BASE_URL, API_ENDPOINTS, getHeaders } from "@/lib/api-config";

type TestResult = {
  test: string;
  success: boolean;
  details: unknown;
  timestamp: Date;
};

type LoginResponse = { data?: { token?: string } };
function isLoginResponse(x: unknown): x is LoginResponse {
  return typeof x === "object" && x !== null && "data" in x;
}

export default function TestAuthPage() {
  const [results, setResults] = useState<TestResult[]>([]);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("admin123");
  const [token, setToken] = useState("");

  const addResult = (test: string, success: boolean, details: unknown) => {
    setResults((prev) => [
      ...prev,
      { test, success, details, timestamp: new Date() },
    ]);
  };

  const testLogin = async () => {
    try {
      const response = await fetch(
        `${API_BASE_URL}${API_ENDPOINTS.auth.admin.login}`,
        {
          method: "POST",
          headers: getHeaders(),
          body: JSON.stringify({ username, password }),
        },
      );

      const data: unknown = await response.json();

      // Expecting { data: { token: string }, ... }
      const tokenCandidate =
        isLoginResponse(data) && typeof data.data?.token === "string"
          ? data.data.token
          : null;

      if (response.ok && tokenCandidate) {
        setToken(tokenCandidate);
        addResult("Admin Login", true, data);
      } else {
        addResult("Admin Login", false, data);
      }
    } catch (error: unknown) {
      addResult(
        "Admin Login",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const testProfile = async () => {
    if (!token) {
      addResult("Get Profile", false, "No token available");
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}${API_ENDPOINTS.auth.admin.profile}`,
        {
          headers: getHeaders(token),
        },
      );

      const data: unknown = await response.json();
      addResult("Get Profile", response.ok, data);
    } catch (error: unknown) {
      addResult(
        "Get Profile",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  const testDashboard = async () => {
    if (!token) {
      addResult("Dashboard API", false, "No token available");
      return;
    }

    try {
      const response = await fetch(
        `${API_BASE_URL}${API_ENDPOINTS.admin.dashboard}`,
        {
          headers: getHeaders(token),
        },
      );

      const data: unknown = await response.json();
      addResult("Dashboard API", response.ok, data);
    } catch (error: unknown) {
      addResult(
        "Dashboard API",
        false,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Auth Testing Page</h1>

      <div className="bg-white p-6 rounded-lg shadow mb-6">
        <h2 className="text-lg font-semibold mb-4">Test Credentials</h2>
        <div className="grid grid-cols-2 gap-4 mb-4">
          <input
            type="text"
            placeholder="Username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            className="px-3 py-2 border rounded"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="px-3 py-2 border rounded"
          />
        </div>

        <div className="space-x-2">
          <button
            onClick={testLogin}
            className="bg-blue-500 text-white px-4 py-2 rounded"
          >
            Test Login
          </button>
          <button
            onClick={testProfile}
            className="bg-green-500 text-white px-4 py-2 rounded"
          >
            Test Profile
          </button>
          <button
            onClick={testDashboard}
            className="bg-purple-500 text-white px-4 py-2 rounded"
          >
            Test Dashboard
          </button>
          <button
            onClick={() => setResults([])}
            className="bg-gray-500 text-white px-4 py-2 rounded"
          >
            Clear Results
          </button>
        </div>

        {token && (
          <div className="mt-4 p-3 bg-green-50 rounded">
            <p className="text-sm font-medium">Token received:</p>
            <p className="text-xs font-mono break-all">
              {token.substring(0, 50)}...
            </p>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {results.map((result, index) => (
          <div
            key={index}
            className={`p-4 rounded-lg ${
              result.success
                ? "bg-green-50 border-green-200"
                : "bg-red-50 border-red-200"
            } border`}
          >
            <div className="mb-2 flex items-start justify-between">
              <h3 className="font-semibold">
                {result.success ? "✅" : "❌"} {result.test}
              </h3>
              <span className="text-xs text-gray-500">
                {result.timestamp.toLocaleTimeString()}
              </span>
            </div>
            <pre className="text-xs overflow-auto bg-white p-2 rounded">
              {(() => {
                try {
                  return JSON.stringify(result.details, null, 2);
                } catch {
                  return String(result.details);
                }
              })()}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}
