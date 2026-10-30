import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";

type Service = "postgres" | "redis" | "minio";
type Health = {
  status: "ok" | "error";
  timestamp: string;
  services: Record<Service, { status: "up" | "down"; latencyMs: number }>;
};

const services: {
  id: Service;
  name: string;
  role: string;
  symbol: string;
  description: string;
}[] = [
  {
    id: "postgres",
    name: "PostgreSQL",
    role: "DATABASE",
    symbol: "DB",
    description:
      "The home for accounts, video metadata, and playback progress.",
  },
  {
    id: "minio",
    name: "MinIO",
    role: "OBJECT STORAGE",
    symbol: "S3",
    description:
      "Private, S3-compatible storage for original videos and streaming segments.",
  },
  {
    id: "redis",
    name: "Redis",
    role: "CACHE & FUTURE QUEUES",
    symbol: "↯",
    description:
      "A fast data layer, ready for background processing in a later phase.",
  },
];

function isHealth(value: unknown): value is Health {
  if (!value || typeof value !== "object") return false;
  const health = value as Health;
  return (
    (health.status === "ok" || health.status === "error") &&
    typeof health.timestamp === "string" &&
    Number.isFinite(Date.parse(health.timestamp)) &&
    services.every(({ id }) => {
      const service = health.services?.[id];
      return (
        service &&
        (service.status === "up" || service.status === "down") &&
        typeof service.latencyMs === "number" &&
        Number.isFinite(service.latencyMs)
      );
    })
  );
}

export function Foundation() {
  const [health, setHealth] = useState<Health | null>(null);
  const [loading, setLoading] = useState(true);
  const [unreachable, setUnreachable] = useState(false);
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    const timeout = window.setTimeout(() => controller.abort("timeout"), 8000);
    try {
      const response = await fetch("/api/health/ready", {
        signal: controller.signal,
        cache: "no-store",
      });
      if (response.status !== 200 && response.status !== 503)
        throw new Error("Unexpected API response");
      const result: unknown = await response.json();
      if (!isHealth(result)) throw new Error("Invalid health response");
      if (request.current !== controller) return;
      setHealth(result);
      setUnreachable(false);
    } catch {
      if (request.current !== controller) return;
      setHealth(null);
      setUnreachable(true);
    } finally {
      window.clearTimeout(timeout);
      if (request.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      window.clearInterval(timer);
      const active = request.current;
      request.current = null;
      active?.abort();
    };
  }, [refresh]);

  const online = health?.status === "ok";
  const status = loading
    ? "Checking connections"
    : unreachable
      ? "API unavailable"
      : online
        ? "All systems connected"
        : "A service needs attention";

  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="#overview" className="brand" aria-label="efiemipeg overview">
          <span className="brand-mark">▶</span> efiemipeg
          <span className="brand-dot">.</span>
        </a>
        <div className="workspace-label">PERSONAL STREAMING LAB</div>
        <nav aria-label="Main navigation">
          <Link className="nav-link" to="/">
            ← My account
          </Link>
          <a className="nav-link" href="#overview">
            <span>▦</span> Overview <span className="nav-count">01</span>
          </a>
          <a className="nav-link" href="#infrastructure">
            <span>◈</span> Infrastructure
          </a>
          <a className="nav-link" href="#journey">
            <span>↗</span> What comes next
          </a>
        </nav>
        <div className="sidebar-note">
          <span className="small-dot" /> LOCAL WORKSPACE
          <p>
            A little closer to understanding
            <br />
            what happens when you press play.
          </p>
        </div>
        <div className="sidebar-footer">
          <span className="avatar">e</span>
          <div>
            Development environment<small>Phase 01 · Foundation</small>
          </div>
        </div>
      </aside>

      <main id="overview">
        <header className="topbar">
          <div>
            Workspace <span>/</span> <strong>Overview</strong>
          </div>
          <span className="environment">
            <span className="small-dot" /> Development
          </span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">BUILDING FROM THE FIRST FRAME</div>
              <h1>
                Your streaming journey
                <br />
                starts here<span>.</span>
              </h1>
              <p>
                A personal video platform, built to understand what’s under the
                hood.
              </p>
            </div>
            <span className="phase-label">
              PHASE <b>01</b>
              <span>Project foundation</span>
            </span>
          </div>

          <section className="hero" aria-labelledby="foundation-title">
            <div className="hero-copy">
              <span className="hero-tag">THE FOUNDATION</span>
              <h2 id="foundation-title">
                Great playback starts
                <br />
                behind the scenes.
              </h2>
              <p>
                Your application and infrastructure come together here. Check
                the connections that will power your video library.
              </p>
              <a href="#infrastructure" className="hero-link">
                Explore the infrastructure <span>↗</span>
              </a>
            </div>
            <div className="stream-graphic" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="orbit orbit-three" />
              <div className="play-core">▶</div>
              <span className="graphic-chip chip-one">01 / STORE</span>
              <span className="graphic-chip chip-two">02 / PROCESS</span>
              <span className="graphic-chip chip-three">03 / STREAM</span>
              <div className="graphic-caption">
                FROM A FILE TO A FIRST FRAME
              </div>
            </div>
          </section>

          <section
            id="infrastructure"
            className="infrastructure"
            aria-labelledby="infrastructure-title"
          >
            <div className="section-heading">
              <div>
                <span className="eyebrow">CONNECTED SERVICES</span>
                <h2 id="infrastructure-title">The engine room</h2>
              </div>
              <button
                className="refresh"
                onClick={() => void refresh()}
                disabled={loading}
              >
                <span aria-hidden="true">↻</span>{" "}
                {loading ? "Checking…" : "Refresh status"}
              </button>
            </div>
            <div
              className={`status-bar ${unreachable || health?.status === "error" ? "status-warning" : ""}`}
              role="status"
            >
              <span
                className={`status-dot ${online && !loading ? "up" : ""}`}
              />
              <strong>{status}</strong>
              <span className="status-time">
                {health
                  ? `Checked ${new Date(health.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`
                  : "Waiting for a live API response"}{" "}
                · refreshes every 15s
              </span>
            </div>
            {unreachable && (
              <p className="connection-help">
                Start the API with <code>npm run dev</code>. If the services are
                stopped, run <code>npm run infra:up</code> first.
              </p>
            )}
            <div className="service-grid">
              {services.map((service) => {
                const result = health?.services[service.id];
                return (
                  <article className="service-card" key={service.id}>
                    <div className="service-top">
                      <span className={`service-icon ${service.id}`}>
                        {service.symbol}
                      </span>
                      <span
                        className={`service-state ${result?.status === "up" ? "connected" : ""}`}
                      >
                        <span className="small-dot" />
                        {result
                          ? result.status === "up"
                            ? "Connected"
                            : "Unavailable"
                          : "Unknown"}
                      </span>
                    </div>
                    <span className="service-role">{service.role}</span>
                    <h3>{service.name}</h3>
                    <p>{service.description}</p>
                    <div className="service-foot">
                      <span>
                        {service.id === "postgres"
                          ? "Prisma · SELECT 1"
                          : service.id === "minio"
                            ? "S3 · Private bucket check"
                            : "Redis · PING"}
                      </span>
                      <span>{result ? `${result.latencyMs} ms` : "—"}</span>
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="app-strip">
              <div>
                <span className="app-symbol">⚛</span>
                <strong>React</strong>
                <span>Browser application</span>
              </div>
              <span className="connection-line" aria-hidden="true">
                ← HTTP →
              </span>
              <div>
                <span className="api-symbol">N</span>
                <strong>NestJS</strong>
                <span>Application API</span>
              </div>
              <a href="/api/health/ready" target="_blank" rel="noreferrer">
                View health response ↗
              </a>
            </div>
          </section>

          <section
            id="journey"
            className="journey"
            aria-labelledby="journey-title"
          >
            <div>
              <span className="eyebrow">ONE STEP AT A TIME</span>
              <h2 id="journey-title">
                First the foundation.
                <br />
                Then the first frame.
              </h2>
              <p>
                The services are the starting point. These features will be
                built in the next stages of the project.
              </p>
            </div>
            <ol className="roadmap">
              <li>
                <span className="step-number">01</span>
                <div>
                  <h3>Uploads & your library</h3>
                  <p>
                    Upload videos and organize your personal collection.
                  </p>
                </div>
                <span className="future-tag">UPCOMING</span>
              </li>
              <li>
                <span className="step-number">02</span>
                <div>
                  <h3>Processing & delivery</h3>
                  <p>
                    Transcode files, create HLS segments, and explore buffering.
                  </p>
                </div>
              </li>
              <li>
                <span className="step-number">03</span>
                <div>
                  <h3>A better press of play</h3>
                  <p>
                    Adaptive quality, seeking, and picking up where you left
                    off.
                  </p>
                </div>
              </li>
            </ol>
          </section>
          <footer className="footer">
            <span>
              efiemipeg{" "}
              <span className="muted">/ a personal streaming experiment</span>
            </span>
            <span>Built to learn. Ready to grow.</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
