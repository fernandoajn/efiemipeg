export function uploadFile(url: string, headers: Record<string, string>, file: File, onProgress: (percent: number) => void, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error); else resolve();
    };
    if (signal.aborted) { reject(new DOMException("Upload canceled", "AbortError")); return; }
    xhr.upload.onprogress = event => {
      if (event.lengthComputable) onProgress(Math.min(100, Math.round(event.loaded / event.total * 100)));
    };
    xhr.onload = () => finish(xhr.status >= 200 && xhr.status < 300 ? undefined : new Error("Storage rejected the upload. The link may have expired; try uploading again."));
    xhr.onerror = () => finish(new Error("The upload connection failed. Try checking the upload, or choose the file again."));
    xhr.ontimeout = () => finish(new Error("The upload timed out. Check the upload before trying again."));
    xhr.onabort = () => finish(new DOMException("Upload canceled", "AbortError"));
    xhr.open("PUT", url);
    xhr.withCredentials = false;
    xhr.timeout = 3600000;
    for (const [key, value] of Object.entries(headers)) xhr.setRequestHeader(key, value);
    signal.addEventListener("abort", abort, { once: true });
    xhr.send(file);
  });
}
