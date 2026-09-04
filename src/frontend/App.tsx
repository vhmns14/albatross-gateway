import React, { useState, useEffect } from "react";
import {
  Activity,
  Shield,
  Cpu,
  Zap,
  Database,
  Key,
  RefreshCw,
  Play,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  Terminal,
  Sliders,
  ArrowRight,
  Lock,
  Clock,
  Coins,
  Server,
  Layers,
  Search,
  Filter,
  Trash2,
  Plus,
  ChevronRight,
  X,
  Code
} from "lucide-react";

interface OverviewMetrics {
  totalRequests: number;
  cacheHits: number;
  cacheHitRate: number;
  totalCostUsd: number;
  totalCostIdr: number;
  savedCostUsd: number;
  savedCostIdr: number;
  totalTokens: number;
  totalPiiBlocked: number;
  percentiles: {
    p50: number;
    p95: number;
    p99: number;
  };
  recentTraces: any[];
  providers: any[];
}

export function App() {
  const [activeTab, setActiveTab] = useState<
    "overview" | "traces" | "router" | "cache" | "keys" | "playground"
  >("overview");

  const [overview, setOverview] = useState<OverviewMetrics | null>(null);
  const [traces, setTraces] = useState<any[]>([]);
  const [selectedTrace, setSelectedTrace] = useState<any | null>(null);
  const [cacheData, setCacheData] = useState<any | null>(null);
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Playground state
  const [promptInput, setPromptInput] = useState(
    "Halo, NIK saya 3201234567890001 dan no HP 081234567890. Bisakah kamu jelaskan apa itu AI Gateway?"
  );
  const [playgroundModel, setPlaygroundModel] = useState("albatross-auto");
  const [isStreaming, setIsStreaming] = useState(true);
  const [playgroundOutput, setPlaygroundOutput] = useState("");
  const [playgroundMetadata, setPlaygroundMetadata] = useState<any | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);

  // New Key Modal state
  const [showKeyModal, setShowKeyModal] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeySpend, setNewKeySpend] = useState("50");
  const [newKeyRpm, setNewKeyRpm] = useState("300");
  const [createdSecret, setCreatedSecret] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Admin Mode state
  const [isAdmin, setIsAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState("");
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [adminInput, setAdminInput] = useState("");
  const [adminError, setAdminError] = useState("");

  // Cache test sandbox state
  const [cacheTestQuery, setCacheTestQuery] = useState("");
  const [cacheTestResult, setCacheTestResult] = useState<any | null>(null);
  const [thresholdInput, setThresholdInput] = useState("0.90");

  useEffect(() => {
    const saved = sessionStorage.getItem("albatross_admin_key");
    if (saved) {
      setAdminPassword(saved);
      setIsAdmin(true);
    }
  }, []);

  const handleVerifyAdmin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError("");
    try {
      const res = await fetch("/api/admin/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminInput }),
      });
      if (res.ok) {
        sessionStorage.setItem("albatross_admin_key", adminInput);
        setAdminPassword(adminInput);
        setIsAdmin(true);
        setShowAdminModal(false);
        setAdminInput("");
      } else {
        setAdminError("Invalid admin password. Default is set in .env");
      }
    } catch (err: any) {
      setAdminError("Verification failed.");
    }
  };

  const handleAdminLogout = () => {
    sessionStorage.removeItem("albatross_admin_key");
    setAdminPassword("");
    setIsAdmin(false);
  };

  const fetchOverview = async () => {
    try {
      const res = await fetch("/api/overview");
      if (res.ok) {
        const data = await res.json();
        setOverview(data);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchTraces = async () => {
    try {
      const res = await fetch("/api/traces");
      if (res.ok) {
        const data = await res.json();
        setTraces(data.traces || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchCache = async () => {
    try {
      const res = await fetch("/api/cache");
      if (res.ok) {
        const data = await res.json();
        setCacheData(data);
        setThresholdInput(data.threshold?.toString() || "0.90");
      }
    } catch (e) {
      console.error(e);
    }
  };

  const fetchKeys = async () => {
    try {
      const res = await fetch("/api/keys");
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    fetchOverview();
    const interval = setInterval(fetchOverview, 4000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (activeTab === "traces") fetchTraces();
    if (activeTab === "cache") fetchCache();
    if (activeTab === "keys") fetchKeys();
  }, [activeTab]);

  const viewTraceDetail = async (traceId: string) => {
    try {
      const res = await fetch(`/api/traces/${traceId}`);
      if (res.ok) {
        const data = await res.json();
        setSelectedTrace(data.trace);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleTripProvider = async (providerId: string) => {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    await fetch("/api/providers/simulate-trip", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
      body: JSON.stringify({ providerId }),
    });
    fetchOverview();
  };

  const handleResetProvider = async (providerId: string) => {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    await fetch("/api/providers/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
      body: JSON.stringify({ providerId }),
    });
    fetchOverview();
  };

  const handlePurgeCache = async () => {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    if (confirm("Are you sure you want to purge the entire semantic cache?")) {
      await fetch("/api/cache/purge", {
        method: "POST",
        headers: { "x-admin-key": adminPassword },
      });
      fetchCache();
      fetchOverview();
    }
  };

  const handleSaveThreshold = async () => {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    const val = parseFloat(thresholdInput);
    if (!isNaN(val)) {
      await fetch("/api/cache/threshold", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
        body: JSON.stringify({ threshold: val }),
      });
      fetchCache();
    }
  };

  const handleCreateKey = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    const res = await fetch("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-admin-key": adminPassword },
      body: JSON.stringify({
        name: newKeyName,
        spendLimitUsd: newKeySpend,
        rateLimitRpm: newKeyRpm,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      setCreatedSecret(data.key.rawSecret);
      fetchKeys();
    } else {
      const err = await res.json();
      alert(err.error || "Failed to generate key. Admin verification required.");
    }
  };

  const handleRevokeKey = async (keyId: string) => {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    if (confirm("Revoke this virtual API key? Applications using it will immediately receive 403.")) {
      await fetch(`/api/keys/${keyId}`, {
        method: "DELETE",
        headers: { "x-admin-key": adminPassword },
      });
      fetchKeys();
    }
  };

  // Playground prompt execution
  const runPlayground = async () => {
    setIsPlaying(true);
    setPlaygroundOutput("");
    setPlaygroundMetadata(null);

    const startTime = performance.now();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-albatross-root-master-key",
      };
      if (isAdmin && adminPassword) {
        headers["x-admin-key"] = adminPassword;
      }

      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: playgroundModel,
          messages: [{ role: "user", content: promptInput }],
          stream: isStreaming,
          max_tokens: 250, // strict 250 token cap on public playground
        }),
      });

      const traceId = response.headers.get("X-Albatross-Trace-Id");
      const cacheStatus = response.headers.get("X-Albatross-Cache") || "MISS";
      const cacheScore = response.headers.get("X-Albatross-Cache-Score");
      const provider = response.headers.get("X-Albatross-Provider") || "upstream";
      const latency = response.headers.get("X-Albatross-Latency-Ms");
      const cost = response.headers.get("X-Albatross-Cost-USD") || "0.0000";
      const piiRedacted = response.headers.get("X-Albatross-PII-Redacted") || "0";

      setPlaygroundMetadata({
        traceId,
        cacheStatus,
        cacheScore,
        provider,
        latency: latency ? parseInt(latency) : Math.round(performance.now() - startTime),
        cost,
        piiRedacted: parseInt(piiRedacted),
        status: response.status,
      });

      if (!isStreaming) {
        const data = await response.json();
        if (data.error) {
          setPlaygroundOutput(`Error: ${data.error.message}`);
        } else {
          setPlaygroundOutput(data.choices?.[0]?.message?.content || "");
        }
      } else {
        const reader = response.body?.getReader();
        const decoder = new TextDecoder("utf-8");
        let accumulated = "";

        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunkText = decoder.decode(value);
            const lines = chunkText.split("\n");

            for (const line of lines) {
              if (line.startsWith("data: ") && !line.includes("[DONE]")) {
                try {
                  const parsed = JSON.parse(line.substring(6));
                  const delta = parsed.choices?.[0]?.delta?.content || "";
                  accumulated += delta;
                  setPlaygroundOutput(accumulated);
                } catch (e) {
                  // ignore keep-alive chunks
                }
              }
            }
          }
        }
      }
    } catch (err: any) {
      setPlaygroundOutput(`Network Error: ${err.message}`);
    } finally {
      setIsPlaying(false);
      fetchOverview();
    }
  };

  return (
    <div className="min-h-screen bg-infra-950 text-infra-text flex flex-col selection:bg-zinc-800">
      {/* 1. Header Bar (Utilitarian & High Density) */}
      <header className="border-b border-infra-800 bg-infra-900/90 backdrop-blur sticky top-0 z-40 px-5 py-2.5 flex items-center justify-between">
        <div className="flex items-center space-x-6">
          <div className="flex items-center space-x-2.5">
            <div className="w-7 h-7 rounded bg-zinc-100 flex items-center justify-center text-zinc-950 font-bold text-sm shadow-sm">
              <Shield className="w-4 h-4 text-zinc-950" />
            </div>
            <div>
              <span className="font-semibold text-sm tracking-tight text-white flex items-center gap-2">
                ALBATROSS <span className="text-zinc-500 font-normal">/ AI Gateway</span>
              </span>
            </div>
          </div>

          <div className="h-4 w-px bg-infra-800" />

          {/* Navigation Links */}
          <nav className="flex items-center space-x-1">
            {[
              { id: "overview", label: "Overview", icon: Activity },
              { id: "traces", label: "Request Traces", icon: Layers },
              { id: "router", label: "Routing & Circuit", icon: Cpu },
              { id: "cache", label: "Semantic Cache", icon: Database },
              { id: "keys", label: "Virtual Keys", icon: Key },
              { id: "playground", label: "Debug Bench", icon: Terminal },
            ].map((tab) => {
              const Icon = tab.icon;
              const isActive = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id as any)}
                  className={`px-3 py-1.5 rounded text-xs font-medium transition-colors flex items-center gap-1.5 ${
                    isActive
                      ? "bg-infra-800 text-white shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200 hover:bg-infra-850"
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" />
                  <span>{tab.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center space-x-3">
          <div className="flex items-center space-x-2 bg-infra-850 border border-infra-800 px-2.5 py-1 rounded text-xs font-mono">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <span className="text-zinc-300">PROXY: :8788</span>
            <span className="text-zinc-600">|</span>
            <span className="text-zinc-400">P50: {overview?.percentiles.p50 || 0}ms</span>
          </div>

          {/* Admin Mode Badge & Button */}
          {isAdmin ? (
            <button
              onClick={handleAdminLogout}
              className="px-2.5 py-1 rounded text-xs font-mono flex items-center gap-1.5 border border-emerald-800/60 bg-emerald-950/40 text-emerald-300 hover:bg-emerald-900/50 transition"
              title="Click to Logout from Admin Mode"
            >
              <Lock className="w-3 h-3 text-emerald-400" />
              <span>ADMIN UNLOCKED</span>
            </button>
          ) : (
            <button
              onClick={() => setShowAdminModal(true)}
              className="px-2.5 py-1 rounded text-xs font-mono flex items-center gap-1.5 border border-infra-800 bg-infra-850 text-zinc-400 hover:text-white hover:border-zinc-700 transition"
              title="Click to Authenticate as Admin"
            >
              <Lock className="w-3 h-3 text-zinc-500" />
              <span>PUBLIC DEMO</span>
            </button>
          )}

          <button
            onClick={() => {
              fetchOverview();
              if (activeTab === "traces") fetchTraces();
              if (activeTab === "cache") fetchCache();
            }}
            className="p-1.5 rounded border border-infra-800 hover:bg-infra-800 text-zinc-400 hover:text-white transition"
            title="Refresh Metrics"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </header>

      {/* Main Content Area */}
      <main className="flex-1 p-6 max-w-7xl w-full mx-auto space-y-6">
        {/* =================================================================== */}
        {/* TAB 1: OVERVIEW & TELEMETRY                                         */}
        {/* =================================================================== */}
        {activeTab === "overview" && (
          <div className="space-y-6">
            {/* KPI Metric Cards */}
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3.5">
              <div className="bg-infra-900 border border-infra-800 rounded p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
                  <span>TOTAL REQUESTS</span>
                  <Activity className="w-3.5 h-3.5 text-zinc-500" />
                </div>
                <div className="mt-3">
                  <span className="text-2xl font-mono font-semibold text-white tracking-tight tabular-nums">
                    {overview?.totalRequests.toLocaleString() || 0}
                  </span>
                  <span className="text-xs text-zinc-500 ml-2 font-mono">
                    ({overview?.totalTokens.toLocaleString() || 0} tokens)
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500 flex items-center gap-1 font-mono">
                  <span className="text-emerald-400 font-medium">100%</span> pass-through monitored
                </div>
              </div>

              <div className="bg-infra-900 border border-infra-800 rounded p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
                  <span>CACHE HIT EFFICIENCY</span>
                  <Database className="w-3.5 h-3.5 text-cyan-500" />
                </div>
                <div className="mt-3">
                  <span className="text-2xl font-mono font-semibold text-cyan-400 tracking-tight tabular-nums">
                    {overview?.cacheHitRate || 0}%
                  </span>
                  <span className="text-xs text-zinc-500 ml-2 font-mono">
                    ({overview?.cacheHits || 0} hits)
                  </span>
                </div>
                <div className="mt-2 text-[11px] text-zinc-400 flex items-center gap-1 font-mono">
                  Saved <span className="text-white font-medium">${overview?.savedCostUsd}</span> (Rp {overview?.savedCostIdr.toLocaleString("id-ID")})
                </div>
              </div>

              <div className="bg-infra-900 border border-infra-800 rounded p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
                  <span>LATENCY PERCENTILES</span>
                  <Clock className="w-3.5 h-3.5 text-amber-500" />
                </div>
                <div className="mt-3 flex items-baseline space-x-3 font-mono">
                  <div>
                    <span className="text-xs text-zinc-500 block">P50</span>
                    <span className="text-xl font-semibold text-white tabular-nums">
                      {overview?.percentiles.p50 || 0}
                      <span className="text-xs font-normal text-zinc-500">ms</span>
                    </span>
                  </div>
                  <div className="border-l border-infra-800 pl-3">
                    <span className="text-xs text-zinc-500 block">P95</span>
                    <span className="text-xl font-semibold text-zinc-300 tabular-nums">
                      {overview?.percentiles.p95 || 0}
                      <span className="text-xs font-normal text-zinc-500">ms</span>
                    </span>
                  </div>
                  <div className="border-l border-infra-800 pl-3">
                    <span className="text-xs text-zinc-500 block">P99</span>
                    <span className="text-xl font-semibold text-zinc-400 tabular-nums">
                      {overview?.percentiles.p99 || 0}
                      <span className="text-xs font-normal text-zinc-500">ms</span>
                    </span>
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500 font-mono">
                  Overhead budget: &lt; 15ms target
                </div>
              </div>

              <div className="bg-infra-900 border border-infra-800 rounded p-4 flex flex-col justify-between">
                <div className="flex items-center justify-between text-zinc-400 text-xs font-medium">
                  <span>IN-FLIGHT PII MASKED</span>
                  <Shield className="w-3.5 h-3.5 text-emerald-500" />
                </div>
                <div className="mt-3">
                  <span className="text-2xl font-mono font-semibold text-emerald-400 tracking-tight tabular-nums">
                    {overview?.totalPiiBlocked || 0}
                  </span>
                  <span className="text-xs text-zinc-500 ml-2 font-mono">entities</span>
                </div>
                <div className="mt-2 text-[11px] text-zinc-500 font-mono">
                  NIK · Phone · Email · API Keys
                </div>
              </div>
            </div>

            {/* Provider Health & Circuit Breakers Grid */}
            <div className="bg-infra-900 border border-infra-800 rounded">
              <div className="px-4 py-3 border-b border-infra-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Cpu className="w-4 h-4 text-zinc-400" />
                  <span className="text-xs font-semibold text-white uppercase tracking-wider">
                    Upstream Provider Matrix & Circuit Breaker Status
                  </span>
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">
                  Automatic failover on 3 consecutive 429/5xx errors
                </span>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-4 divide-y md:divide-y-0 md:divide-x divide-infra-800">
                {(overview?.providers || []).map((prov) => {
                  const isUp = prov.state === "CLOSED";
                  const isDown = prov.state === "OPEN";
                  const isHalf = prov.state === "HALF_OPEN";

                  return (
                    <div key={prov.providerId} className="p-4 space-y-3">
                      <div className="flex items-start justify-between">
                        <div>
                          <div className="text-xs font-semibold text-zinc-200">{prov.name}</div>
                          <div className="text-[11px] font-mono text-zinc-500">{prov.providerId}</div>
                        </div>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-medium ${
                            isUp
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : isDown
                              ? "bg-red-500/10 text-red-400 border border-red-500/30"
                              : "bg-amber-500/10 text-amber-400 border border-amber-500/30"
                          }`}
                        >
                          <span
                            className={`w-1.5 h-1.5 rounded-full mr-1.5 ${
                              isUp ? "bg-emerald-500" : isDown ? "bg-red-500" : "bg-amber-500"
                            }`}
                          />
                          {prov.state === "CLOSED" ? "HEALTHY (UP)" : prov.state === "OPEN" ? "CIRCUIT OPEN" : "PROBING"}
                        </span>
                      </div>

                      <div className="space-y-1 text-xs font-mono text-zinc-400 pt-1 border-t border-infra-800">
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Errors:</span>
                          <span className={prov.consecutiveErrors > 0 ? "text-amber-400" : "text-zinc-400"}>
                            {prov.consecutiveErrors} / 3
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Total Calls:</span>
                          <span>{prov.totalRequests}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-zinc-500">Avg Latency:</span>
                          <span>{prov.avgLatencyMs}ms</span>
                        </div>
                      </div>

                      {/* Interactive Controls to Test Circuit Breaker Failover */}
                      <div className="pt-2 flex items-center space-x-2">
                        {isUp ? (
                          <button
                            onClick={() => handleTripProvider(prov.providerId)}
                            className="w-full text-center py-1 px-2 rounded bg-infra-850 hover:bg-red-950/40 hover:border-red-800 border border-infra-800 text-[11px] font-mono text-zinc-400 hover:text-red-300 transition"
                          >
                            Simulate Trip (429)
                          </button>
                        ) : (
                          <button
                            onClick={() => handleResetProvider(prov.providerId)}
                            className="w-full text-center py-1 px-2 rounded bg-emerald-950/40 border border-emerald-800/60 text-[11px] font-mono text-emerald-300 hover:bg-emerald-900/50 transition"
                          >
                            Reset Circuit
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live Telemetry Ticker */}
            <div className="bg-infra-900 border border-infra-800 rounded">
              <div className="px-4 py-3 border-b border-infra-800 flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Activity className="w-4 h-4 text-emerald-400" />
                  <span className="text-xs font-semibold text-white uppercase tracking-wider">
                    Recent Request Waterfall & Routing Activity
                  </span>
                </div>
                <button
                  onClick={() => setActiveTab("traces")}
                  className="text-xs text-zinc-400 hover:text-white flex items-center gap-1 font-mono transition"
                >
                  View All Traces <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="divide-y divide-infra-800 text-xs font-mono">
                {(overview?.recentTraces || []).length === 0 ? (
                  <div className="p-6 text-center text-zinc-500 font-mono text-xs">
                    No requests recorded yet. Send a test query via the <button onClick={() => setActiveTab("playground")} className="text-zinc-300 underline">Debug Bench</button>.
                  </div>
                ) : (
                  overview?.recentTraces.map((item: any) => (
                    <div
                      key={item.trace_id}
                      onClick={() => {
                        viewTraceDetail(item.trace_id);
                        setActiveTab("traces");
                      }}
                      className="px-4 py-2.5 flex items-center justify-between hover:bg-infra-850/60 cursor-pointer transition"
                    >
                      <div className="flex items-center space-x-3">
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            item.is_cache_hit
                              ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                              : item.status_code === 200
                              ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                              : "bg-red-500/10 text-red-400 border border-red-500/30"
                          }`}
                        >
                          {item.is_cache_hit ? "CACHE HIT" : item.status_code}
                        </span>
                        <span className="text-zinc-300 font-semibold">{item.trace_id}</span>
                      </div>
                      <div className="flex items-center space-x-6 text-zinc-400">
                        <span>{item.latency_ms}ms</span>
                        <span className="text-zinc-500">{new Date(item.created_at).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 2: REQUEST TRACES (WATERFALL & DETAIL)                           */}
        {/* =================================================================== */}
        {activeTab === "traces" && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
                  Audit Log & Request Traces
                </h2>
                <p className="text-xs text-zinc-400">
                  Inspect latency waterfall, PII redactions, token consumption, and routing decisions.
                </p>
              </div>
              <button
                onClick={fetchTraces}
                className="px-3 py-1.5 rounded border border-infra-800 bg-infra-900 text-xs font-mono text-zinc-300 hover:text-white flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            </div>

            <div className="bg-infra-900 border border-infra-800 rounded overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-infra-850/80 border-b border-infra-800 text-zinc-400">
                    <tr>
                      <th className="py-2.5 px-3">STATUS</th>
                      <th className="py-2.5 px-3">TRACE ID</th>
                      <th className="py-2.5 px-3">MODEL REQUESTED</th>
                      <th className="py-2.5 px-3">PROVIDER SERVED</th>
                      <th className="py-2.5 px-3">LATENCY</th>
                      <th className="py-2.5 px-3">TOKENS</th>
                      <th className="py-2.5 px-3">PII REDACTED</th>
                      <th className="py-2.5 px-3">COST (USD)</th>
                      <th className="py-2.5 px-3">TIME</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-infra-800 text-zinc-300">
                    {traces.length === 0 ? (
                      <tr>
                        <td colSpan={9} className="py-8 text-center text-zinc-500 font-mono">
                          No traces found.
                        </td>
                      </tr>
                    ) : (
                      traces.map((t) => (
                        <tr
                          key={t.traceId}
                          onClick={() => viewTraceDetail(t.traceId)}
                          className="hover:bg-infra-850 cursor-pointer transition"
                        >
                          <td className="py-2.5 px-3">
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] ${
                                t.isCacheHit
                                  ? "bg-cyan-500/10 text-cyan-400 border border-cyan-500/30"
                                  : t.statusCode === 200
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/30"
                                  : "bg-red-500/10 text-red-400 border border-red-500/30"
                              }`}
                            >
                              {t.isCacheHit ? "CACHE HIT" : t.statusCode}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 font-semibold text-white">{t.traceId}</td>
                          <td className="py-2.5 px-3 text-zinc-400">{t.modelRequested}</td>
                          <td className="py-2.5 px-3">
                            <span className="px-1.5 py-0.5 rounded bg-infra-800 text-zinc-300 text-[11px]">
                              {t.providerUsed}
                            </span>
                          </td>
                          <td className="py-2.5 px-3 tabular-nums text-zinc-300">{t.latencyMs}ms</td>
                          <td className="py-2.5 px-3 tabular-nums text-zinc-400">{t.totalTokens}</td>
                          <td className="py-2.5 px-3">
                            {t.piiRedactedCount > 0 ? (
                              <span className="text-amber-400 font-semibold">{t.piiRedactedCount} masked</span>
                            ) : (
                              <span className="text-zinc-600">0</span>
                            )}
                          </td>
                          <td className="py-2.5 px-3 tabular-nums text-zinc-400">${t.costUsd.toFixed(5)}</td>
                          <td className="py-2.5 px-3 text-zinc-500">
                            {new Date(t.createdAt).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Selected Trace Slide-Over / Modal */}
            {selectedTrace && (
              <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
                <div className="bg-infra-900 border border-infra-800 rounded-lg max-w-2xl w-full p-6 space-y-5 shadow-2xl">
                  <div className="flex items-center justify-between border-b border-infra-800 pb-3">
                    <div className="flex items-center space-x-3">
                      <Layers className="w-5 h-5 text-cyan-400" />
                      <div>
                        <h3 className="text-sm font-semibold text-white font-mono">
                          {selectedTrace.trace_id}
                        </h3>
                        <span className="text-xs text-zinc-500 font-mono">
                          {new Date(selectedTrace.created_at).toLocaleString()}
                        </span>
                      </div>
                    </div>
                    <button
                      onClick={() => setSelectedTrace(null)}
                      className="p-1 rounded text-zinc-400 hover:text-white hover:bg-infra-800"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Waterfall Timeline Bar */}
                  <div className="space-y-2">
                    <span className="text-xs font-semibold text-zinc-400 font-mono uppercase tracking-wider">
                      Request Waterfall (Total: {selectedTrace.latency_ms}ms)
                    </span>
                    <div className="space-y-1.5 font-mono text-xs">
                      <div className="flex items-center justify-between text-zinc-400">
                        <span>1. Auth & Rate Limit Check</span>
                        <span className="text-white">{selectedTrace.timing_breakdown?.authMs || 1}ms</span>
                      </div>
                      <div className="w-full bg-infra-800 rounded h-1.5 overflow-hidden">
                        <div className="bg-zinc-400 h-full w-[5%]" />
                      </div>

                      <div className="flex items-center justify-between text-zinc-400 pt-1">
                        <span>2. Guardrails & PII Sanitizer Scan</span>
                        <span className="text-emerald-400">{selectedTrace.timing_breakdown?.guardrailMs || 2}ms</span>
                      </div>
                      <div className="w-full bg-infra-800 rounded h-1.5 overflow-hidden">
                        <div className="bg-emerald-500 h-full w-[10%]" />
                      </div>

                      <div className="flex items-center justify-between text-zinc-400 pt-1">
                        <span>3. Semantic Cache Vector Proximity Lookup</span>
                        <span className="text-cyan-400">{selectedTrace.timing_breakdown?.cacheMs || 5}ms</span>
                      </div>
                      <div className="w-full bg-infra-800 rounded h-1.5 overflow-hidden">
                        <div className="bg-cyan-500 h-full w-[15%]" />
                      </div>

                      <div className="flex items-center justify-between text-zinc-400 pt-1">
                        <span>4. Upstream Provider Execution & Streaming</span>
                        <span className="text-amber-400">{selectedTrace.timing_breakdown?.upstreamMs || selectedTrace.latency_ms}ms</span>
                      </div>
                      <div className="w-full bg-infra-800 rounded h-1.5 overflow-hidden">
                        <div className="bg-amber-500 h-full w-[80%]" />
                      </div>
                    </div>
                  </div>

                  {/* Redacted PII Breakdown */}
                  <div className="bg-infra-850 p-3.5 rounded border border-infra-800 space-y-2 text-xs font-mono">
                    <span className="text-zinc-400 font-semibold block">PII & SAFETY AUDIT</span>
                    {selectedTrace.pii_redacted_count > 0 ? (
                      <div className="space-y-1">
                        <p className="text-emerald-400">
                          ✓ {selectedTrace.pii_redacted_count} sensitive entity masked in-flight before reaching external LLMs.
                        </p>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {selectedTrace.pii_types_detected?.map((e: any, idx: number) => (
                            <span key={idx} className="px-2 py-0.5 rounded bg-infra-800 text-zinc-300 text-[11px]">
                              {e.type}: {e.count}x
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-zinc-500">No sensitive PII detected in this prompt.</p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                    <div className="bg-infra-850 p-3 rounded border border-infra-800">
                      <span className="text-zinc-500 block">Served Provider</span>
                      <span className="text-white font-semibold">{selectedTrace.provider_used}</span>
                    </div>
                    <div className="bg-infra-850 p-3 rounded border border-infra-800">
                      <span className="text-zinc-500 block">Calculated Spend</span>
                      <span className="text-white font-semibold">${selectedTrace.cost_usd}</span>
                    </div>
                  </div>

                  <button
                    onClick={() => setSelectedTrace(null)}
                    className="w-full py-2 bg-infra-800 hover:bg-infra-700 text-xs font-mono font-medium rounded text-white transition"
                  >
                    Close Inspector
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 3: ROUTING & CIRCUIT BREAKERS                                   */}
        {/* =================================================================== */}
        {activeTab === "router" && (
          <div className="space-y-6">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
                Dynamic Routing Policy & Fault Tolerance DAG
              </h2>
              <p className="text-xs text-zinc-400">
                Albatross transparently reroutes failed upstream LLM queries without returning 5xx to clients.
              </p>
            </div>

            {/* Architecture DAG */}
            <div className="bg-infra-900 border border-infra-800 rounded p-6">
              <div className="text-xs font-mono font-semibold text-zinc-400 mb-6 flex items-center gap-2">
                <Layers className="w-4 h-4 text-cyan-400" />
                EXECUTION PIPELINE & FALLBACK TOPOLOGY
              </div>

              <div className="flex flex-col md:flex-row items-center justify-between gap-4 font-mono text-xs">
                {/* Node 1 */}
                <div className="bg-infra-850 border border-infra-700 p-3 rounded w-full md:w-44 text-center">
                  <span className="text-zinc-400 text-[10px] block">CLIENT INGRESS</span>
                  <span className="text-white font-bold">/v1/chat/completions</span>
                  <span className="text-zinc-500 text-[10px] block mt-1">Bearer sk-albatross-...</span>
                </div>

                <ArrowRight className="w-4 h-4 text-zinc-600 hidden md:block" />

                {/* Node 2 */}
                <div className="bg-infra-850 border border-infra-700 p-3 rounded w-full md:w-44 text-center">
                  <span className="text-emerald-400 text-[10px] block">MIDDLEWARE</span>
                  <span className="text-white font-bold">PII Redactor</span>
                  <span className="text-zinc-500 text-[10px] block mt-1">Regex + Luhn NIK</span>
                </div>

                <ArrowRight className="w-4 h-4 text-zinc-600 hidden md:block" />

                {/* Node 3 */}
                <div className="bg-infra-850 border border-infra-700 p-3 rounded w-full md:w-44 text-center">
                  <span className="text-cyan-400 text-[10px] block">CACHE LAYER</span>
                  <span className="text-white font-bold">Semantic Vector</span>
                  <span className="text-zinc-500 text-[10px] block mt-1">&ge; 0.90 Cosine Sim</span>
                </div>

                <ArrowRight className="w-4 h-4 text-zinc-600 hidden md:block" />

                {/* Multi-Tier Fallback Container */}
                <div className="bg-infra-850 border border-infra-700 p-3.5 rounded w-full md:w-60 space-y-2">
                  <span className="text-amber-400 text-[10px] block font-semibold">
                    FAILOVER CASCADE (CIRCUIT PROTECTED)
                  </span>
                  <div className="space-y-1.5 text-[11px]">
                    <div className="flex items-center justify-between p-1 bg-infra-800 rounded">
                      <span className="text-zinc-200">1. Groq LPU</span>
                      <span className="text-emerald-400 text-[10px]">Primary</span>
                    </div>
                    <div className="flex items-center justify-between p-1 bg-infra-800 rounded">
                      <span className="text-zinc-300">2. Gemini Flash</span>
                      <span className="text-amber-400 text-[10px]">Fallback 1</span>
                    </div>
                    <div className="flex items-center justify-between p-1 bg-infra-800 rounded">
                      <span className="text-zinc-400">3. OpenAI GPT-4o-mini</span>
                      <span className="text-zinc-500 text-[10px]">Fallback 2</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Circuit Breaker Rules Table */}
            <div className="bg-infra-900 border border-infra-800 rounded p-4 space-y-3 font-mono text-xs">
              <span className="text-xs font-semibold text-white uppercase tracking-wider block">
                Circuit Breaker Parameters
              </span>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-zinc-300">
                <div className="bg-infra-850 p-3 rounded border border-infra-800">
                  <span className="text-zinc-500 block text-[11px]">TRIP THRESHOLD</span>
                  <span className="text-white font-semibold">3 Consecutive Errors</span>
                  <p className="text-[11px] text-zinc-500 mt-1">Trips on HTTP 429, 500, 502, 504, or network timeout.</p>
                </div>
                <div className="bg-infra-850 p-3 rounded border border-infra-800">
                  <span className="text-zinc-500 block text-[11px]">COOLDOWN DURATION</span>
                  <span className="text-white font-semibold">30 Seconds</span>
                  <p className="text-[11px] text-zinc-500 mt-1">Blocks upstream traffic to give provider time to recover.</p>
                </div>
                <div className="bg-infra-850 p-3 rounded border border-infra-800">
                  <span className="text-zinc-500 block text-[11px]">HALF-OPEN PROBE</span>
                  <span className="text-white font-semibold">Single Canary Probe</span>
                  <p className="text-[11px] text-zinc-500 mt-1">If canary succeeds, resets breaker to CLOSED state.</p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 4: SEMANTIC CACHE EXPLORER                                      */}
        {/* =================================================================== */}
        {activeTab === "cache" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
                  Semantic Vector Cache Explorer
                </h2>
                <p className="text-xs text-zinc-400">
                  Sub-15ms cached responses based on vector cosine proximity. Zero LLM tokens consumed on hits.
                </p>
              </div>
              <button
                onClick={handlePurgeCache}
                className="px-3 py-1.5 rounded border border-red-900/60 bg-red-950/30 text-xs font-mono text-red-400 hover:bg-red-900/40 flex items-center gap-1.5 transition"
              >
                <Trash2 className="w-3.5 h-3.5" /> Purge Cache
              </button>
            </div>

            {/* Cache Configuration & Stats Strip */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
              <div className="bg-infra-900 border border-infra-800 rounded p-4">
                <span className="text-xs font-medium text-zinc-400">TOTAL CACHED EMBEDDINGS</span>
                <div className="mt-2 text-2xl font-mono font-semibold text-white">
                  {cacheData?.totalEntries || 0}
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">Dense L2-Normalized Vectors</span>
              </div>

              <div className="bg-infra-900 border border-infra-800 rounded p-4">
                <span className="text-xs font-medium text-zinc-400">TOTAL CACHE HITS</span>
                <div className="mt-2 text-2xl font-mono font-semibold text-cyan-400">
                  {cacheData?.totalHits || 0}
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">100% Token Cost Eliminated</span>
              </div>

              <div className="bg-infra-900 border border-infra-800 rounded p-4">
                <span className="text-xs font-medium text-zinc-400">SIMILARITY THRESHOLD</span>
                <div className="mt-2 flex items-center space-x-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.5"
                    max="1.0"
                    value={thresholdInput}
                    onChange={(e) => setThresholdInput(e.target.value)}
                    className="w-24 bg-infra-850 border border-infra-700 rounded px-2 py-1 text-sm font-mono text-white"
                  />
                  <button
                    onClick={handleSaveThreshold}
                    className="px-2.5 py-1 bg-infra-800 hover:bg-infra-700 rounded text-xs font-mono text-white"
                  >
                    Set
                  </button>
                </div>
                <span className="text-[11px] text-zinc-500 font-mono">Default: 0.90 (Cosine &ge; 0.90)</span>
              </div>
            </div>

            {/* Top Cached Prompts Table */}
            <div className="bg-infra-900 border border-infra-800 rounded">
              <div className="px-4 py-3 border-b border-infra-800">
                <span className="text-xs font-semibold text-white uppercase tracking-wider">
                  Top Cached Queries & Cluster Frequency
                </span>
              </div>
              <div className="divide-y divide-infra-800 text-xs font-mono">
                {(cacheData?.topQueries || []).length === 0 ? (
                  <div className="p-6 text-center text-zinc-500 font-mono text-xs">
                    No cached prompts yet. Send repeated prompts in the Debug Bench to observe caching.
                  </div>
                ) : (
                  cacheData?.topQueries.map((q: any) => (
                    <div key={q.id} className="p-3.5 flex items-center justify-between hover:bg-infra-850/60">
                      <div className="space-y-1 max-w-xl">
                        <span className="text-white font-medium block truncate">"{q.prompt_raw}"</span>
                        <span className="text-zinc-500 text-[11px]">Model: {q.model}</span>
                      </div>
                      <div className="text-right">
                        <span className="px-2 py-0.5 rounded bg-cyan-500/10 text-cyan-400 font-semibold border border-cyan-500/20">
                          {q.hit_count} hits
                        </span>
                        <span className="text-zinc-500 text-[10px] block mt-1">
                          Last: {new Date(q.last_hit_at).toLocaleTimeString()}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 5: VIRTUAL KEYS & BUDGET MANAGEMENT                             */}
        {/* =================================================================== */}
        {activeTab === "keys" && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
                  Virtual API Keys & Spend Allocation
                </h2>
                <p className="text-xs text-zinc-400">
                  Provision isolated virtual keys with strict monthly spend limits and RPM rate limiting.
                </p>
              </div>
              <button
                onClick={() => {
                  if (!isAdmin) {
                    setShowAdminModal(true);
                  } else {
                    setShowKeyModal(true);
                  }
                }}
                className={`px-3 py-1.5 rounded font-medium text-xs flex items-center gap-1.5 transition ${
                  isAdmin
                    ? "bg-white text-zinc-950 hover:bg-zinc-200"
                    : "bg-infra-850 text-zinc-400 hover:text-white border border-infra-800"
                }`}
              >
                {isAdmin ? <Plus className="w-3.5 h-3.5" /> : <Lock className="w-3.5 h-3.5" />}
                <span>{isAdmin ? "Create Key" : "Unlock Admin to Create Key"}</span>
              </button>
            </div>

            {/* Virtual Keys Table */}
            <div className="bg-infra-900 border border-infra-800 rounded overflow-hidden">
              <table className="w-full text-left text-xs font-mono">
                <thead className="bg-infra-850/80 border-b border-infra-800 text-zinc-400">
                  <tr>
                    <th className="py-2.5 px-3">KEY NAME</th>
                    <th className="py-2.5 px-3">PREFIX</th>
                    <th className="py-2.5 px-3">SPEND / LIMIT (USD)</th>
                    <th className="py-2.5 px-3">RATE LIMIT</th>
                    <th className="py-2.5 px-3">STATUS</th>
                    <th className="py-2.5 px-3">ACTION</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-infra-800 text-zinc-300">
                  {keys.map((k) => (
                    <tr key={k.id} className="hover:bg-infra-850/60">
                      <td className="py-2.5 px-3 font-semibold text-white">{k.name}</td>
                      <td className="py-2.5 px-3 text-zinc-400 font-mono">
                        {!isAdmin && k.prefix.includes("root") ? "sk-albatross-root-****" : k.prefix}
                      </td>
                      <td className="py-2.5 px-3">
                        <div className="space-y-1">
                          <div className="flex justify-between text-[11px]">
                            <span>${k.currentSpendUsd.toFixed(2)}</span>
                            <span className="text-zinc-500">${k.spendLimitUsd.toFixed(2)}</span>
                          </div>
                          <div className="w-36 bg-infra-800 h-1.5 rounded overflow-hidden">
                            <div
                              className="bg-emerald-500 h-full"
                              style={{
                                width: `${Math.min(100, (k.currentSpendUsd / k.spendLimitUsd) * 100)}%`,
                              }}
                            />
                          </div>
                        </div>
                      </td>
                      <td className="py-2.5 px-3 text-zinc-400">{k.rateLimitRpm} RPM</td>
                      <td className="py-2.5 px-3">
                        {k.isActive ? (
                          <span className="px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px]">
                            ACTIVE
                          </span>
                        ) : (
                          <span className="px-1.5 py-0.5 rounded bg-red-500/10 text-red-400 border border-red-500/30 text-[10px]">
                            REVOKED
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        {isAdmin && k.isActive ? (
                          <button
                            onClick={() => handleRevokeKey(k.id)}
                            className="text-red-400 hover:text-red-300 text-[11px]"
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="text-zinc-600 text-[10px]">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Code Snippets for Developers */}
            <div className="bg-infra-900 border border-infra-800 rounded p-4 space-y-3 font-mono text-xs">
              <span className="text-xs font-semibold text-white uppercase tracking-wider block">
                Drop-in SDK Integration Snippets
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-1.5">
                  <span className="text-zinc-400 text-[11px]">Python (OpenAI SDK Drop-in)</span>
                  <pre className="p-3 rounded bg-infra-950 border border-infra-800 text-zinc-300 text-[11px] overflow-x-auto">
{`from openai import OpenAI

client = OpenAI(
    base_url="https://albatross-gateway.style.dev/v1",
    api_key="sk-albatross-your-key-here"  # Generated by Administrator
)

response = client.chat.completions.create(
    model="albatross-auto",
    messages=[{"role": "user", "content": "Halo!"}]
)`}
                  </pre>
                </div>

                <div className="space-y-1.5">
                  <span className="text-zinc-400 text-[11px]">cURL Terminal</span>
                  <pre className="p-3 rounded bg-infra-950 border border-infra-800 text-zinc-300 text-[11px] overflow-x-auto">
{`curl -X POST https://albatross-gateway.style.dev/v1/chat/completions \\
  -H "Authorization: Bearer sk-albatross-your-key-here" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "albatross-auto",
    "messages": [{"role": "user", "content": "Halo!"}],
    "stream": true
  }'`}
                  </pre>
                </div>
              </div>
            </div>

            {/* Create Key Modal */}
            {showKeyModal && (
              <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4 backdrop-blur-sm">
                <div className="bg-infra-900 border border-infra-800 rounded-lg max-w-md w-full p-6 space-y-4">
                  <div className="flex items-center justify-between border-b border-infra-800 pb-3">
                    <h3 className="text-sm font-semibold text-white">Generate Virtual API Key</h3>
                    <button
                      onClick={() => {
                        setShowKeyModal(false);
                        setCreatedSecret(null);
                      }}
                      className="p-1 rounded text-zinc-400 hover:text-white"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  {!createdSecret ? (
                    <form onSubmit={handleCreateKey} className="space-y-3 text-xs font-mono">
                      <div>
                        <label className="block text-zinc-400 mb-1">Key Name / App Description</label>
                        <input
                          type="text"
                          required
                          value={newKeyName}
                          onChange={(e) => setNewKeyName(e.target.value)}
                          placeholder="e.g. Mobile App Backend"
                          className="w-full bg-infra-850 border border-infra-700 rounded p-2 text-white focus:outline-none focus:border-zinc-500"
                        />
                      </div>

                      <div className="grid grid-cols-2 gap-3">
                        <div>
                          <label className="block text-zinc-400 mb-1">Spend Limit ($ USD)</label>
                          <input
                            type="number"
                            required
                            value={newKeySpend}
                            onChange={(e) => setNewKeySpend(e.target.value)}
                            className="w-full bg-infra-850 border border-infra-700 rounded p-2 text-white"
                          />
                        </div>
                        <div>
                          <label className="block text-zinc-400 mb-1">Rate Limit (RPM)</label>
                          <input
                            type="number"
                            required
                            value={newKeyRpm}
                            onChange={(e) => setNewKeyRpm(e.target.value)}
                            className="w-full bg-infra-850 border border-infra-700 rounded p-2 text-white"
                          />
                        </div>
                      </div>

                      <button
                        type="submit"
                        className="w-full py-2 bg-white text-zinc-950 font-medium rounded hover:bg-zinc-200 transition mt-2"
                      >
                        Generate Key
                      </button>
                    </form>
                  ) : (
                    <div className="space-y-3 text-xs font-mono">
                      <div className="p-3 bg-emerald-950/40 border border-emerald-800/60 rounded text-emerald-300">
                        ✓ Key created successfully! Copy this key now. It will never be displayed again.
                      </div>
                      <div className="p-2.5 bg-infra-950 border border-infra-800 rounded flex items-center justify-between text-zinc-200">
                        <span className="truncate pr-2">{createdSecret}</span>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText(createdSecret);
                            setCopiedKey(true);
                            setTimeout(() => setCopiedKey(false), 2000);
                          }}
                          className="p-1.5 rounded bg-infra-800 hover:bg-infra-700 text-white"
                        >
                          {copiedKey ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                        </button>
                      </div>
                      <button
                        onClick={() => {
                          setShowKeyModal(false);
                          setCreatedSecret(null);
                        }}
                        className="w-full py-2 bg-infra-800 rounded text-white"
                      >
                        Done
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* =================================================================== */}
        {/* TAB 6: INTERACTIVE DEBUG BENCH / PLAYGROUND                         */}
        {/* =================================================================== */}
        {activeTab === "playground" && (
          <div className="space-y-4">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-wider text-white">
                Live Gateway Debug Bench & PII Simulator
              </h2>
              <p className="text-xs text-zinc-400">
                Dispatch live prompts through Albatross. Observe real-time SSE streaming, in-flight PII redaction, and semantic cache hits.
              </p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Input Column */}
              <div className="bg-infra-900 border border-infra-800 rounded p-4 space-y-3 font-mono text-xs flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-zinc-400 font-semibold uppercase">PROMPT INPUT</span>
                    <button
                      onClick={() =>
                        setPromptInput(
                          "Saya mau cek status rekening dengan NIK 3201234567890001 dan no telp 081234567890, tolong dibantu."
                        )
                      }
                      className="text-[11px] text-emerald-400 hover:underline flex items-center gap-1"
                    >
                      <Shield className="w-3 h-3" /> Insert Sample Indonesian PII
                    </button>
                  </div>

                  <textarea
                    rows={7}
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    className="w-full bg-infra-950 border border-infra-700 rounded p-3 text-zinc-200 focus:outline-none focus:border-zinc-500 font-mono text-xs leading-relaxed"
                  />

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label className="block text-zinc-400 text-[11px] mb-1">TARGET MODEL</label>
                      <select
                        value={playgroundModel}
                        onChange={(e) => setPlaygroundModel(e.target.value)}
                        className="w-full bg-infra-850 border border-infra-700 rounded p-2 text-white"
                      >
                        <option value="albatross-auto">albatross-auto (Frontier Fallback)</option>
                        <option value="claude-opus-5">claude-opus-5 (JustWoker)</option>
                        <option value="llama-3.3-70b-versatile">llama-3.3-70b (Groq)</option>
                        <option value="gemini-2.0-flash">gemini-2.0-flash (Google)</option>
                        <option value="gpt-4o-mini">gpt-4o-mini (OpenAI)</option>
                      </select>
                    </div>

                    <div>
                      <label className="block text-zinc-400 text-[11px] mb-1">STREAMING (SSE)</label>
                      <button
                        onClick={() => setIsStreaming(!isStreaming)}
                        className={`w-full py-2 px-3 rounded border text-xs text-left font-mono flex items-center justify-between ${
                          isStreaming
                            ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                            : "border-infra-700 bg-infra-850 text-zinc-400"
                        }`}
                      >
                        <span>{isStreaming ? "Enabled (SSE)" : "Disabled (JSON)"}</span>
                        <span className={`w-2 h-2 rounded-full ${isStreaming ? "bg-emerald-400" : "bg-zinc-600"}`} />
                      </button>
                    </div>
                  </div>
                </div>

                <button
                  disabled={isPlaying || !promptInput}
                  onClick={runPlayground}
                  className="w-full py-2.5 rounded bg-white hover:bg-zinc-200 text-zinc-950 font-semibold text-xs flex items-center justify-center gap-2 transition disabled:opacity-50 mt-4"
                >
                  {isPlaying ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Streaming Response...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Execute Through Gateway</span>
                    </>
                  )}
                </button>
              </div>

              {/* Output & Telemetry Column */}
              <div className="bg-infra-900 border border-infra-800 rounded p-4 space-y-3 font-mono text-xs flex flex-col justify-between">
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-infra-800 pb-2">
                    <span className="text-zinc-400 font-semibold uppercase">RESPONSE INSPECTOR</span>
                    {playgroundMetadata && (
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                          playgroundMetadata.cacheStatus === "HIT"
                            ? "bg-cyan-500/20 text-cyan-300 border border-cyan-500/40"
                            : "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40"
                        }`}
                      >
                        {playgroundMetadata.cacheStatus === "HIT" ? "CACHE HIT (0ms UPSTREAM)" : "PROXIED (CACHE MISS)"}
                      </span>
                    )}
                  </div>

                  {/* Metadata Chips */}
                  {playgroundMetadata && (
                    <div className="grid grid-cols-3 gap-2 text-[11px]">
                      <div className="p-2 rounded bg-infra-850 border border-infra-800">
                        <span className="text-zinc-500 block text-[10px]">LATENCY</span>
                        <span className="text-white font-bold">{playgroundMetadata.latency}ms</span>
                      </div>
                      <div className="p-2 rounded bg-infra-850 border border-infra-800">
                        <span className="text-zinc-500 block text-[10px]">PII REDACTED</span>
                        <span className="text-emerald-400 font-bold">{playgroundMetadata.piiRedacted} entity</span>
                      </div>
                      <div className="p-2 rounded bg-infra-850 border border-infra-800">
                        <span className="text-zinc-500 block text-[10px]">COST</span>
                        <span className="text-white font-bold">${playgroundMetadata.cost}</span>
                      </div>
                    </div>
                  )}

                  {/* Text Output Box */}
                  <div className="bg-infra-950 border border-infra-800 rounded p-3 min-h-[160px] text-zinc-300 whitespace-pre-wrap leading-relaxed">
                    {playgroundOutput ? (
                      playgroundOutput
                    ) : (
                      <span className="text-zinc-600">
                        Output will stream here in real time with headers and metadata.
                      </span>
                    )}
                  </div>
                </div>

                {playgroundMetadata && (
                  <div className="text-[10px] text-zinc-500 border-t border-infra-800 pt-2 flex justify-between">
                    <span>Trace: {playgroundMetadata.traceId}</span>
                    <span>Provider: {playgroundMetadata.provider}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </main>

      {/* Admin Authentication Modal */}
      {showAdminModal && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm">
          <div className="bg-infra-900 border border-infra-800 rounded-lg max-w-md w-full p-6 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-infra-800 pb-3">
              <div className="flex items-center space-x-2.5">
                <Lock className="w-4 h-4 text-emerald-400" />
                <h3 className="text-sm font-semibold text-white font-mono">Unlock Administrator Mode</h3>
              </div>
              <button
                onClick={() => {
                  setShowAdminModal(false);
                  setAdminError("");
                  setAdminInput("");
                }}
                className="p-1 rounded text-zinc-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <p className="text-xs text-zinc-400 font-mono leading-relaxed">
              Virtual API key generation and system controls are restricted to administrators to prevent public abuse of upstream LLM quotas.
            </p>

            <form onSubmit={handleVerifyAdmin} className="space-y-3 font-mono text-xs">
              <div>
                <label className="block text-zinc-400 mb-1">Admin Password</label>
                <input
                  type="password"
                  required
                  autoFocus
                  value={adminInput}
                  onChange={(e) => setAdminInput(e.target.value)}
                  placeholder="Enter administrator password..."
                  className="w-full bg-infra-950 border border-infra-700 rounded p-2.5 text-white focus:outline-none focus:border-zinc-500"
                />
              </div>

              {adminError && (
                <div className="p-2 rounded bg-red-950/40 border border-red-800/60 text-red-300 text-[11px]">
                  {adminError}
                </div>
              )}

              <button
                type="submit"
                className="w-full py-2 bg-white text-zinc-950 font-semibold rounded hover:bg-zinc-200 transition"
              >
                Authenticate & Unlock
              </button>
            </form>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-infra-800 py-3 px-6 text-xs text-zinc-500 font-mono flex items-center justify-between">
        <div>Albatross AI Gateway · Enterprise LLM Middleware & Observability</div>
        <div className="flex items-center space-x-4">
          <span>Bun Native Runtime</span>
          <span>SQLite WAL</span>
          <span>Sub-15ms Overhead</span>
        </div>
      </footer>
    </div>
  );
}
