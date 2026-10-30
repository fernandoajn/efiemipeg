import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../auth/api";
import { uploadFile } from "./upload";
import "./library.css";

type Status = "UPLOADING" | "VERIFYING" | "UPLOADED" | "FAILED" | "CANCELED";
export interface Video {
  id: string; title: string; originalName: string; mimeType: string; sizeBytes: number;
  status: Status; error: string | null; createdAt: string; uploadedAt: string | null; uploadExpiresAt: string;
}
interface Page { videos: Video[]; nextCursor: string | null }
interface UploadOptions { maxVideoBytes: number; formats: string[] }
interface Initialized { video: Video; upload: { url: string; headers: Record<string, string>; expiresAt: string } }
const labels: Record<Status, string> = { UPLOADING: "Awaiting verification", VERIFYING: "Verifying", UPLOADED: "Uploaded", FAILED: "Upload failed", CANCELED: "Canceled" };
const mimeByExtension: Record<string, string> = { mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm" };
export function formatBytes(bytes: number) {
  const unit = bytes >= 1024 ** 3 ? "GiB" : bytes >= 1024 ** 2 ? "MiB" : "KiB";
  return `${(bytes / (unit === "GiB" ? 1024 ** 3 : unit === "MiB" ? 1024 ** 2 : 1024)).toFixed(1)} ${unit}`;
}

export function Library({ onBusy }: { onBusy: (busy: boolean) => void }) {
  const [videos, setVideos] = useState<Video[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [options, setOptions] = useState<UploadOptions | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploadError, setUploadError] = useState("");
  const [phase, setPhase] = useState<"idle" | "initializing" | "uploading" | "verifying">("idle");
  const [progress, setProgress] = useState(0);
  const [message, setMessage] = useState("");
  const [checking, setChecking] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const active = useRef<{ abort: AbortController; id?: string } | null>(null);
  const mounted = useRef(true);
  const listVersion = useRef(0);
  const busy = phase !== "idle";

  const upsert = useCallback((video: Video) => {
    setVideos(current => [video, ...current.filter(item => item.id !== video.id)].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
  }, []);

  const load = useCallback(async (next?: string) => {
    const version = ++listVersion.current;
    setLoading(true); setError("");
    try {
      const page = await api<Page>(`/videos${next ? `?cursor=${encodeURIComponent(next)}` : ""}`);
      if (!mounted.current || version !== listVersion.current) return;
      setVideos(current => next ? [...current, ...page.videos.filter(video => !current.some(item => item.id === video.id))] : page.videos);
      setCursor(page.nextCursor);
    } catch (cause) {
      if (mounted.current && version === listVersion.current) setError(cause instanceof Error ? cause.message : "Could not load your library.");
    } finally { if (mounted.current && version === listVersion.current) setLoading(false); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    void api<UploadOptions>("/videos/upload-options").then(result => { if (mounted.current) setOptions(result); }).catch(() => { if (mounted.current) setUploadError("Upload settings are unavailable. Refresh this page to try again."); });
    return () => { mounted.current = false; listVersion.current++; active.current?.abort.abort(); };
  }, [load]);

  useEffect(() => { onBusy(busy); return () => onBusy(false); }, [busy, onBusy]);
  useEffect(() => {
    if (!busy) return;
    const preventExit = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", preventExit);
    return () => window.removeEventListener("beforeunload", preventExit);
  }, [busy]);

  function choose(candidate?: File) {
    if (!candidate || busy) return;
    const mimeType = mimeByExtension[candidate.name.split(".").pop()?.toLowerCase() ?? ""];
    setMessage(""); setUploadError("");
    if (!options || !mimeType || !options.formats.includes(mimeType)) { setUploadError("Choose an MP4, MOV, or WebM video."); return; }
    if (!candidate.size || candidate.size > options.maxVideoBytes) { setUploadError(`Choose a non-empty video up to ${formatBytes(options.maxVideoBytes)}.`); return; }
    setFile(candidate); setTitle(candidate.name.replace(/\.[^.]+$/, "").slice(0, 160)); setProgress(0);
  }

  async function verify(id: string) {
    const result = await api<{ video: Video }>(`/videos/${id}/complete`, {}, 75000);
    if (mounted.current) upsert(result.video);
    return result;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!file || busy || !options) return;
    const job = { abort: new AbortController(), id: undefined as string | undefined };
    active.current = job; setPhase("initializing"); setUploadError(""); setMessage(""); setProgress(0);
    try {
      const initialized = await api<Initialized>("/videos/uploads", {
        title: title.trim(), originalName: file.name,
        mimeType: mimeByExtension[file.name.split(".").pop()?.toLowerCase() ?? ""], sizeBytes: file.size,
      });
      job.id = initialized.video.id;
      if (job.abort.signal.aborted) {
        await api(`/videos/${job.id}/cancel`, {});
        throw new DOMException("Upload canceled", "AbortError");
      }
      upsert(initialized.video); setPhase("uploading");
      await uploadFile(initialized.upload.url, initialized.upload.headers, file, percent => { if (mounted.current) setProgress(percent); }, job.abort.signal);
      if (!mounted.current) return;
      setPhase("verifying");
      await verify(job.id);
      if (mounted.current) { setMessage("Your video is uploaded and verified."); setFile(null); setTitle(""); if (input.current) input.current.value = ""; }
    } catch (cause) {
      const canceled = cause instanceof DOMException && cause.name === "AbortError";
      if (canceled && job.id) {
        try { const result = await api<{ video: Video }>(`/videos/${job.id}/cancel`, {}); if (mounted.current) upsert(result.video); }
        catch { if (mounted.current) setUploadError("The transfer stopped, but the server could not confirm cancellation. Refresh the library to check its status."); }
      }
      if (mounted.current) {
        if (canceled) setMessage("Upload stopped.");
        else setUploadError(cause instanceof Error ? cause.message : "The upload failed. Please try again.");
        if (job.id) { try { const result = await api<{ video: Video }>(`/videos/${job.id}`); if (mounted.current) upsert(result.video); } catch { /* Keep the last known status. */ } }
      }
    } finally {
      if (active.current === job) active.current = null;
      if (mounted.current) setPhase("idle");
    }
  }

  async function check(id: string) {
    setChecking(id); setError("");
    try { await verify(id); }
    catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Verification failed.");
      try { const result = await api<{ video: Video }>(`/videos/${id}`); if (mounted.current) upsert(result.video); } catch { /* Preserve last state. */ }
    } finally { if (mounted.current) setChecking(null); }
  }

  return <section id="library" className="video-library" aria-label="Your video library">
    <form className="upload-panel" onSubmit={event => void submit(event)}>
      <div className="section-heading"><div><span className="eyebrow">ADD A FIRST FRAME</span><h2>Upload a video</h2></div><span className="environment">Private originals</span></div>
      <input ref={input} id="video-file" className="file-input" type="file" accept=".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm" disabled={busy || !options} onChange={event => choose(event.target.files?.[0])} aria-label="Choose video" />
      <div className={`drop-zone ${dragging ? "dragging" : ""}`} onDragOver={event => { event.preventDefault(); if (!busy) setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={event => { event.preventDefault(); setDragging(false); choose(event.dataTransfer.files[0]); }}>
        <span className="upload-icon" aria-hidden="true">↑</span><div><h3>{file ? file.name : "Your next video belongs here."}</h3><p>{file ? `${formatBytes(file.size)} · Ready to upload` : `Drop a file here, or choose one below. MP4, MOV, WebM${options ? ` · up to ${formatBytes(options.maxVideoBytes)}` : ""}.`}</p></div>
        <button className="refresh" type="button" disabled={busy || !options} onClick={() => input.current?.click()}>{file ? "Change file" : "Choose video"}</button>
      </div>
      {file && <div className="upload-details"><label className="form-field">Video title<input value={title} onChange={event => setTitle(event.target.value)} required maxLength={160} disabled={busy} /></label><button type="submit" className="primary-button" disabled={busy || !title.trim()}>{busy ? "Uploading…" : "Upload video"}<span aria-hidden="true">↑</span></button></div>}
      {busy && <div className="upload-progress"><div><strong>{phase === "initializing" ? "Preparing your upload…" : phase === "verifying" ? "Verifying your original…" : `Uploading · ${progress}%`}</strong>{phase !== "verifying" && <button type="button" className="text-button" onClick={() => active.current?.abort.abort()}>Cancel upload</button>}</div><progress max={100} value={phase === "verifying" ? 100 : progress} aria-label="Video upload progress" /><p>{phase === "verifying" ? "The transfer is complete. Checking the file before adding it to your library." : "Keep this page open until the upload finishes."}</p></div>}
      {uploadError && <p role="alert" className="auth-error">{uploadError}</p>}{message && <p role="status" className="upload-success">{message}</p>}
    </form>
    <div className="section-heading library-heading"><div><span className="eyebrow">YOUR PERSONAL COLLECTION</span><h2>Your videos</h2></div><button className="refresh" disabled={loading || busy || !!checking} onClick={() => void load()}>Refresh library</button></div>
    {error && <p className="auth-error" role="alert">{error}</p>}
    {loading && !videos.length && <p className="library-notice" role="status">Loading your library…</p>}
    {!loading && !error && !videos.length && <div className="library-empty"><div className="empty-play" aria-hidden="true">▶</div><h2>Every collection starts<br />with a first frame.</h2><p>Choose your first video above. Only you can see the originals in your library.</p></div>}
    <div className="video-grid">{videos.map(video => <article className="video-card" key={video.id}>
      <div className={`video-art status-${video.status.toLowerCase()}`}><span className="video-format">{video.originalName.split(".").pop()?.toUpperCase()}</span>{video.status === "UPLOADED" ? <Link className="video-play" to={`/videos/${video.id}`} aria-label={`Watch ${video.title}`}>▶</Link> : <span className="video-file-icon" aria-hidden="true">▤</span>}<span className={`video-status ${video.status.toLowerCase()}`}>{labels[video.status]}</span></div>
      <div className="video-info"><h3 title={video.title}>{video.title}</h3><p className="video-filename" title={video.originalName}>{video.originalName}</p><div className="video-meta"><span>{formatBytes(video.sizeBytes)}</span><span>{new Date(video.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}</span></div>
      {video.error && <p className="video-error">{video.error}</p>}
      {video.status === "UPLOADED" ? <Link className="refresh watch-link" to={`/videos/${video.id}`}>▶ Watch</Link> : (video.status === "UPLOADING" || video.status === "VERIFYING") ? <button className="refresh check-upload" disabled={busy || !!checking} onClick={() => void check(video.id)}>{checking === video.id ? "Checking…" : "Check upload"}</button> : <p className="video-note">Choose the file above to upload again.</p>}
      </div>
    </article>)}</div>
    {cursor && <button className="refresh load-more" disabled={loading || busy || !!checking} onClick={() => void load(cursor)}>{loading ? "Loading…" : "Load more videos"}</button>}
  </section>;
}
