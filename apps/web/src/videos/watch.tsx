import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../auth/api";
import { useAuth } from "../auth/auth-context";
import { formatBytes, type Video } from "./library";
import "./watch.css";

type Preload = "none" | "metadata" | "auto";
interface LogEntry { id: number; at: number; name: string; detail: string }
const readyStates = ["HAVE_NOTHING", "HAVE_METADATA", "HAVE_CURRENT_DATA", "HAVE_FUTURE_DATA", "HAVE_ENOUGH_DATA"];
const networkStates = ["NETWORK_EMPTY", "NETWORK_IDLE", "NETWORK_LOADING", "NETWORK_NO_SOURCE"];
const mediaEvents = ["loadstart", "loadedmetadata", "loadeddata", "canplay", "canplaythrough", "play", "playing", "pause", "waiting", "stalled", "suspend", "seeking", "seeked", "progress", "ended", "abort", "emptied", "error"] as const;
const mediaErrors: Record<number, string> = {
  1: "Playback was aborted.",
  2: "The connection dropped while loading the video. Retry to resume from where you were.",
  3: "This browser could not decode the video. Transcoding to a widely supported format comes in a later phase.",
  4: "This browser cannot play this file’s format or codec, or the video could not be loaded.",
};
const clock = (seconds: number) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "–:––";
const ranges = (list: TimeRanges) => Array.from({ length: list.length }, (_, index) => [list.start(index), list.end(index)] as const);

export function WatchPage() {
  const { id = "" } = useParams();
  const { reload } = useAuth();
  const [video, setVideo] = useState<Video | null>(null);
  const [error, setError] = useState("");
  const [playbackError, setPlaybackError] = useState("");
  const [preload, setPreload] = useState<Preload>("metadata");
  const [attempt, setAttempt] = useState(0);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [, setTick] = useState(0);
  const element = useRef<HTMLVideoElement>(null);
  const started = useRef(performance.now());
  const resumeAt = useRef(0);
  const nextId = useRef(0);

  useEffect(() => {
    let current = true;
    setVideo(null); setError("");
    api<{ video: Video }>(`/videos/${encodeURIComponent(id)}`)
      .then(result => { if (current) setVideo(result.video); })
      .catch(cause => { if (current) setError(cause instanceof ApiError && (cause.status === 404 || cause.status === 400) ? "This video does not exist in your library." : cause instanceof Error ? cause.message : "Could not load this video."); });
    return () => { current = false; };
  }, [id]);

  const playable = video?.status === "UPLOADED";
  useEffect(() => {
    const media = element.current;
    if (!media || !playable) return;
    started.current = performance.now(); setLog([]); setPlaybackError("");
    let lastWasProgress = false;
    const record = (event: Event) => {
      setTick(value => value + 1);
      const bufferedEnd = media.buffered.length ? media.buffered.end(media.buffered.length - 1) : 0;
      const detail = event.type === "seeking" ? `to ${clock(media.currentTime)}` : event.type === "loadedmetadata" ? `${clock(media.duration)} · ${media.videoWidth}×${media.videoHeight}` : event.type === "error" ? `code ${media.error?.code ?? "?"}` : event.type === "progress" ? `buffered to ${clock(bufferedEnd)}` : "";
      // Progress fires repeatedly while bytes arrive; collapse a run of them into one row.
      if (event.type === "progress" && lastWasProgress) setLog(entries => [{ ...entries[0], at: performance.now(), detail }, ...entries.slice(1)]);
      else setLog(entries => [{ id: ++nextId.current, at: performance.now(), name: event.type, detail }, ...entries].slice(0, 40));
      lastWasProgress = event.type === "progress";
      if (event.type === "loadedmetadata" && resumeAt.current) { media.currentTime = resumeAt.current; resumeAt.current = 0; }
      if (event.type === "error") {
        setPlaybackError(mediaErrors[media.error?.code ?? 4] ?? mediaErrors[4]);
        // A 401 on a media request is invisible to scripts; re-check the session so an expired one redirects to sign-in.
        void reload();
      }
    };
    const refresh = () => setTick(value => value + 1);
    for (const name of mediaEvents) media.addEventListener(name, record);
    media.addEventListener("timeupdate", refresh); media.addEventListener("durationchange", refresh); media.addEventListener("ratechange", refresh);
    return () => {
      for (const name of mediaEvents) media.removeEventListener(name, record);
      media.removeEventListener("timeupdate", refresh); media.removeEventListener("durationchange", refresh); media.removeEventListener("ratechange", refresh);
    };
  }, [playable, preload, attempt, reload]);

  const restart = useCallback((next?: Preload) => {
    resumeAt.current = element.current?.currentTime ?? 0;
    if (next) setPreload(next);
    setAttempt(value => value + 1);
  }, []);
  const seek = (fraction: number) => { const media = element.current; if (media && Number.isFinite(media.duration)) media.currentTime = media.duration * fraction; };

  const media = element.current;
  const duration = media && Number.isFinite(media.duration) ? media.duration : 0;
  const buffered = media && duration ? ranges(media.buffered) : [];
  const ahead = media ? buffered.find(([start, end]) => start <= media.currentTime && media.currentTime <= end)?.[1] ?? media.currentTime : 0;

  return <div className="watch-page">
    <header className="watch-topbar">
      <Link to="/" className="brand"><span className="brand-mark">▶</span>efiemipeg<span className="brand-dot">.</span></Link>
      <Link to="/#library" className="refresh">← Back to library</Link>
    </header>
    <main className="watch-content">
      {error && <div className="watch-message"><h1>We couldn’t open this video.</h1><p role="alert">{error}</p><Link to="/" className="primary-button">Return to your library</Link></div>}
      {!error && !video && <p className="library-notice" role="status">Loading video…</p>}
      {video && !playable && <div className="watch-message"><h1>{video.title}</h1><p role="status">This video isn’t ready to play yet. Finish or check its upload from your library.</p><Link to="/" className="primary-button">Return to your library</Link></div>}
      {video && playable && <>
        <div className="watch-heading">
          <div><span className="eyebrow">PROGRESSIVE PLAYBACK · HTTP RANGE REQUESTS</span><h1>{video.title}</h1><p>{video.originalName} · {formatBytes(video.sizeBytes)} · {video.mimeType}</p></div>
        </div>
        <div className="player-frame">
          <video key={`${preload}-${attempt}`} ref={element} controls playsInline preload={preload} src={`/api/videos/${video.id}/stream`} aria-label={`Play ${video.title}`} />
        </div>
        {playbackError && <div className="playback-error" role="alert"><p>{playbackError}</p><button className="refresh" onClick={() => restart()}>Retry playback</button></div>}
        <section className="playback-lab" aria-label="Playback lab">
          <div className="section-heading"><div><span className="eyebrow">WATCH THE BYTES ARRIVE</span><h2>Playback lab</h2></div><span className="environment">{readyStates[media?.readyState ?? 0]}</span></div>
          <div className="buffer-track" role="img" aria-label={`Buffered ranges: ${buffered.map(([start, end]) => `${clock(start)} to ${clock(end)}`).join(", ") || "none"}`}>
            {buffered.map(([start, end]) => <span key={start} className="buffer-range" style={{ left: `${start / duration * 100}%`, width: `${Math.max(0.4, (end - start) / duration * 100)}%` }} />)}
            {duration > 0 && <span className="buffer-head" style={{ left: `${(media?.currentTime ?? 0) / duration * 100}%` }} />}
          </div>
          <div className="seek-row">
            <span>Jump to</span>
            {[0, 0.25, 0.5, 0.75, 0.95].map(fraction => <button key={fraction} className="refresh" disabled={!duration} onClick={() => seek(fraction)}>{fraction * 100}%</button>)}
          </div>
          <dl className="lab-stats">
            <div><dt>Position</dt><dd>{clock(media?.currentTime ?? 0)} / {clock(duration)}</dd></div>
            <div><dt>Buffered ahead</dt><dd>{media ? `${Math.max(0, ahead - media.currentTime).toFixed(1)} s` : "–"}</dd></div>
            <div><dt>Buffered ranges</dt><dd>{buffered.length}</dd></div>
            <div><dt>Network state</dt><dd>{networkStates[media?.networkState ?? 0]}</dd></div>
          </dl>
          <div className="preload-row" role="group" aria-label="Preload strategy">
            <span>Preload</span>
            {(["none", "metadata", "auto"] as const).map(option => <button key={option} className={`refresh ${preload === option ? "selected" : ""}`} aria-pressed={preload === option} onClick={() => restart(option)}>{option}</button>)}
            <small>Changing it reloads the player so you can compare the first requests.</small>
          </div>
          <div className="lab-columns">
            <ol className="event-log" aria-label="Media events">
              {log.length ? log.map(entry => <li key={entry.id} className={`event-${entry.name}`}><time>{((entry.at - started.current) / 1000).toFixed(2)}s</time><strong>{entry.name}</strong><span>{entry.detail}</span></li>) : <li className="event-empty">Media events appear here as the player loads and plays.</li>}
            </ol>
            <aside className="devtools-guide">
              <h3>Inspect it in DevTools</h3>
              <ol>
                <li>Open <strong>Network</strong>, filter by <code>stream</code>, and reload.</li>
                <li>Click a request: the request carries <code>Range: bytes=…</code>; the response is <code>206 Partial Content</code> with <code>Content-Range</code>.</li>
                <li>Seek far ahead. The old request is canceled and a new one starts at a later byte offset.</li>
                <li>Set throttling to <strong>Slow 4G</strong> or <strong>3G</strong> and watch <code>waiting</code> and <code>stalled</code> events while the buffer bar catches up.</li>
              </ol>
            </aside>
          </div>
        </section>
      </>}
    </main>
  </div>;
}
