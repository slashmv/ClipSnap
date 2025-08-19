import json
import re
import shutil
import subprocess
import time
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
from yt_dlp import YoutubeDL
import threading, queue, uuid, os
from typing import Dict, Any

JOBS: Dict[str, Dict[str, Any]] = {}        # job_id -> record
JOBS_LOCK = threading.Lock()
JOB_QUEUE: "queue.Queue[str]" = queue.Queue()
WORKER_STARTED = False

APP_TIMEZONE = "Asia/Kolkata"  # IST
BASE_DIR = Path(__file__).resolve().parent
CLIPS_DIR = BASE_DIR / "clips"
TMP_DIR = BASE_DIR / "tmp"
STATE_FILE = BASE_DIR / "batch_state.json"  # {"counter": int, "last_reset": float (epoch seconds)}
BATCH_LOCK = threading.Lock()

CLIPS_DIR.mkdir(exist_ok=True)
TMP_DIR.mkdir(exist_ok=True)

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})


# ---------------------- Batch state helpers ----------------------
def reserve_batch_index() -> int:
    """Reserve and persist the next batch counter (FIFO numbering)."""
    with BATCH_LOCK:
        st = read_state()
        idx = int(st.get("counter", 1))
        st["counter"] = idx + 1
        write_state(st)
        return idx

def _default_state():
    # Start at 1; default last_reset = 0 so existing files show up until first reset
    return {"counter": 1, "last_reset": 0.0}


def read_state():
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            return _default_state()
        # Hardening: ensure keys exist and are of right type
        counter = int(data.get("counter", 1))
        last_reset = float(data.get("last_reset", 0.0))
        if counter < 1:
            counter = 1
        if last_reset < 0:
            last_reset = 0.0
        return {"counter": counter, "last_reset": last_reset}
    except Exception:
        return _default_state()


def write_state(state: dict):
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")


def increment_counter():
    """
    Find the highest number from existing clips filenames in CLIPS_DIR and
    increment it by 1. If no clips found, start at 1.
    """
    max_num = 0
    for p in CLIPS_DIR.iterdir():
        if p.is_file():
            # Match patterns like "(5) 0123-0456.mp4"
            m = re.match(r"\((\d+)\)", p.name)
            if m:
                try:
                    num = int(m.group(1))
                    if num > max_num:
                        max_num = num
                except ValueError:
                    pass

    next_num = max_num + 1
    return next_num


def reset_batch():
    st = read_state()
    st["counter"] = 1
    st["last_reset"] = time.time()
    write_state(st)
    return st


def is_vertical_video(url: str) -> bool:
    """
    Peek the YouTube formats (no download) and infer orientation from the
    highest-area video format. Returns True if portrait (height > width).
    """
    try:
        with YoutubeDL({"quiet": True, "noplaylist": True}) as ydl:
            info = ydl.extract_info(url, download=False)
        fmts = [f for f in info.get("formats", []) if f.get("vcodec") and f["vcodec"] != "none"]
        if not fmts:
            return False
        best = max(fmts, key=lambda f: (f.get("width") or 0) * (f.get("height") or 0))
        w = int(best.get("width") or 0)
        h = int(best.get("height") or 0)
        return h > w and h > 0 and w > 0
    except Exception:
        return False  # fall back to landscape cap if we can't tell


def probe_dimensions(path: Path) -> tuple[int, int]:
    """Return (width, height) using ffprobe; (0,0) on failure."""
    try:
        proc = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "stream=width,height", "-of", "csv=p=0:s=x", str(path)],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False
        )
        out = (proc.stdout or "").strip()
        if "x" in out:
            w, h = out.split("x")
            return int(w), int(h)
    except Exception:
        pass
    return (0, 0)
# ---------------------- Utilities ----------------------
def detect_gpu_encoder():
    """
    Returns (encoder_name, extra_input_args, extra_output_args)
    Tries NVENC, then QuickSync, VideoToolbox (macOS), AMF (AMD), VAAPI (Linux),
    and falls back to libx264 if nothing exists.
    """
    try:
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-encoders"],
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, check=False
        ).stdout
    except Exception:
        out = ""

    # Prefer NVENC with high quality settings
    if "h264_nvenc" in out:
        return ("h264_nvenc", 
                ["-hwaccel", "cuda"], 
                ["-preset", "p7", "-rc", "vbr", "-cq", "16", "-qmin", "16", "-qmax", "18", "-b:v", "8M"])
    # Intel QuickSync with quality settings
    if "h264_qsv" in out:
        return ("h264_qsv", 
                ["-hwaccel", "qsv"], 
                ["-global_quality", "18", "-b:v", "8M"])
    # AMD AMF with quality settings
    if "h264_amf" in out:
        return ("h264_amf", 
                ["-hwaccel", "d3d11va"], 
                ["-quality", "quality", "-rc", "vbr_peak", "-b:v", "8M"])
    # macOS VideoToolbox
    if "h264_videotoolbox" in out:
        return ("h264_videotoolbox", 
                [], 
                ["-b:v", "8M", "-q:v", "60"])
    # VAAPI (Linux)
    if "h264_vaapi" in out:
        return ("h264_vaapi", 
                ["-hwaccel", "vaapi", "-vaapi_device", "/dev/dri/renderD128"], 
                ["-vf", "format=nv12,hwupload", "-rc_mode", "2", "-b:v", "8M"])

    # Fallback CPU with high quality
    return ("libx264", [], ["-preset", "slower", "-crf", "16"])


GPU_ENCODER, GPU_IN_ARGS, GPU_OUT_ARGS = detect_gpu_encoder()
print(f"[FFmpeg] Using encoder: {GPU_ENCODER}")


def mmss_from_seconds(sec: float) -> str:
    """Return MMSS string with zero-padding, clamped to >=0."""
    s = max(0, int(sec))
    m = s // 60
    r = s % 60
    return f"{m:02d}{r:02d}"


def download_best_video(url: str) -> Path:
    """
    Download best available quality (capped later when clipping) and cache it in TMP_DIR
    as <video_id>.mp4. If already present, reuse without downloading.
    """
    # First: probe to get the canonical video id (and portrait hint)
    portrait = is_vertical_video(url)
    max_h = 1920 if portrait else 1080

    # Get info (no download) just to resolve video_id
    with YoutubeDL({"noplaylist": True, "quiet": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    video_id = info["id"]
    cached_mp4 = TMP_DIR / f"{video_id}.mp4"
    if cached_mp4.exists():
        print(f"[YT-DLP] Cache hit for {video_id}: {cached_mp4}")
        return cached_mp4

    # Prefer DASH (separate) up to cap; fallbacks maintain MP4-friendly merges
    fmt = (
        f"bestvideo[protocol^=http_dash_segments][height<={max_h}][fps<=60]"
        f"+bestaudio[ext=m4a]/"
        f"bestvideo[protocol^=http_dash_segments][height<={max_h}][fps<=60]"
        f"+bestaudio/"
        f"bestvideo[ext=mp4][vcodec*=avc1][height<={max_h}][fps<=60]"
        f"+bestaudio[ext=m4a]/"
        f"bestvideo[ext=mp4][height<={max_h}][fps<=60]+bestaudio/"
        f"best[height<={max_h}]/"
        f"(bv*+ba/b)[protocol^=m3u8]"
    )

    download_opts = {
        "outtmpl": str(TMP_DIR / f"{video_id}.%(ext)s"),
        "format": fmt,
        "noplaylist": True,
        "quiet": False,
        "verbose": True,
        "overwrites": True,
        "merge_output_format": "mp4",
        "postprocessors": [{"key": "FFmpegVideoConvertor", "preferedformat": "mp4"}],
        "retries": 10,
        "fragment_retries": 10,
        "concurrent_fragment_downloads": 5,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            ),
            "Accept": "*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.youtube.com",
            "Referer": "https://www.youtube.com/",
        },
        "format_sort": ["ext:mp4:m4a", "vcodec:avc1", "acodec:mp4a", "codec:h264", "res", "fps"],
    }

    with YoutubeDL(download_opts) as ydl:
        info_dl = ydl.extract_info(url, download=True)

    # Normalize final path to <id>.mp4 in TMP_DIR
    # (yt-dlp should already have produced mp4; still, resolve safely)
    # Prefer 'requested_downloads[0]["filepath"]' if present then rename if needed
    if "requested_downloads" in info_dl and info_dl["requested_downloads"]:
        produced_path = Path(info_dl["requested_downloads"][0]["filepath"])
    else:
        produced_path = TMP_DIR / f"{info_dl['id']}.{info_dl.get('ext', 'mp4')}"

    if produced_path != cached_mp4:
        try:
            if produced_path.exists():
                produced_path.replace(cached_mp4)
        except Exception:
            shutil.copy2(produced_path, cached_mp4)

    w, h = probe_dimensions(cached_mp4)
    print(f"[YT-DLP] Cached file {cached_mp4.name} dimensions: {w}x{h}")
    if not portrait and h < 720:
        print("[WARN] Landscape download <720p; source likely limited.")

    return cached_mp4


def ffmpeg_clip(input_path: Path, start: float, end: float, output_path: Path) -> None:
    """
    Cut segment and encode using GPU if available (falls back to libx264).
    Output: MP4 (H.264 + AAC 320k), with orientation-aware caps:
      - landscape: max 1920x1080
      - portrait:  max 1080x1920
    Never upscale.
    """
    duration = max(0.0, end - start)
    if duration <= 0:
        raise ValueError("End time must be greater than start time.")

    w, h = probe_dimensions(input_path)
    portrait = (h > w and h > 0 and w > 0)

    # Choose cap based on orientation but maintain quality
    if portrait:
        # width ≤1080, height ≤1920, keep AR, no upscale
        scale_filter = "scale='min(1080,iw)':'min(1920,ih)':force_original_aspect_ratio=decrease:flags=lanczos"
    else:
        # width ≤1920, height ≤1080
        scale_filter = "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease:flags=lanczos"

    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-y",
        *GPU_IN_ARGS,
        "-ss", str(start),
        "-i", str(input_path),
        "-t", str(duration),
        "-vf", scale_filter,
        "-c:v", GPU_ENCODER,
        *GPU_OUT_ARGS,
        "-profile:v", "high",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "320k",
        "-movflags", "+faststart",
        str(output_path),
    ]
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg failed: {proc.stderr[:4000]}")


def _job_update(job_id: str, **fields):
    with JOBS_LOCK:
        if job_id in JOBS:
            JOBS[job_id].update(fields)

def _run_job(job_id: str):
    job = JOBS[job_id]
    url = job.get("url") or job.get("url_src")
    start = job["start"]; end = job["end"]

    try:
        _job_update(job_id, state="downloading")
        src_path = download_best_video(url)

        # Use the pre-reserved index/filename (insertion order)
        idx = job.get("index")
        filename = job.get("filename") or f"({idx}) {mmss_from_seconds(start)}-{mmss_from_seconds(end)}.mp4"
        out_path = CLIPS_DIR / filename

        _job_update(job_id, state="clipping", filename=filename)
        ffmpeg_clip(src_path, start, end, out_path)

        _job_update(job_id, state="done", ok=True, url=f"/clips/{filename}")
    except Exception as e:
        _job_update(job_id, state="error", ok=False, error=str(e))


def _worker_loop():
    while True:
        job_id = JOB_QUEUE.get()  # blocks
        try:
            _job_update(job_id, state="working")
            _run_job(job_id)
        finally:
            JOB_QUEUE.task_done()

def _ensure_worker_started():
    global WORKER_STARTED
    if WORKER_STARTED:
        return
    # Avoid double-start under Flask reloader
    if os.environ.get("WERKZEUG_RUN_MAIN") == "true" or not app.debug:
        t = threading.Thread(target=_worker_loop, name="clip-worker", daemon=True)
        t.start()
        WORKER_STARTED = True

@app.before_request
def _boot_worker():
    _ensure_worker_started()

# ---------------------- Routes ----------------------
@app.route("/api/batch/status", methods=["GET"])
def api_batch_status():
    st = read_state()
    return jsonify({"ok": True, "counter": int(st["counter"]), "last_reset": float(st["last_reset"])})

@app.route("/api/clip/queue", methods=["POST"])
def api_clip_queue():
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("url") or "").strip()
    try:
        start = float(data.get("start", 0))
        end = float(data.get("end", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid start/end"}), 400
    if not url:
        return jsonify({"ok": False, "error": "Missing url"}), 400
    if end <= start:
        return jsonify({"ok": False, "error": "end must be greater than start"}), 400

    # Reserve the clip number now (in insertion order)
    idx = reserve_batch_index()
    filename = f"({idx}) {mmss_from_seconds(start)}-{mmss_from_seconds(end)}.mp4"

    job_id = uuid.uuid4().hex[:12]
    with JOBS_LOCK:
        JOBS[job_id] = {
            "id": job_id,
            "ok": None,
            "state": "queued",
            "url_src": url,
            "url": url,
            "start": start,
            "end": end,
            "queued_at": time.time(),
            "index": idx,             # <- fixed numbering
            "filename": filename,     # <- fixed name
            "error": None,
        }
    JOB_QUEUE.put(job_id)
    return jsonify({"ok": True, "job_id": job_id, "index": idx, "filename": filename})

@app.route("/api/jobs/<job_id>", methods=["GET"])
def api_job_status(job_id):
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            return jsonify({"ok": False, "error": "job not found"}), 404
        return jsonify({"ok": True, "job": job})

@app.route("/api/jobs", methods=["GET"])
def api_jobs_list():
    with JOBS_LOCK:
        # newest first
        items = sorted(JOBS.values(), key=lambda j: j.get("queued_at", 0), reverse=True)
        return jsonify({"ok": True, "items": items})


@app.route("/api/clip", methods=["POST"])
def api_clip():
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("url") or "").strip()
    try:
        start = float(data.get("start", 0))
        end = float(data.get("end", 0))
    except (TypeError, ValueError):
        return jsonify({"ok": False, "error": "Invalid start/end"}), 400
    if not url:
        return jsonify({"ok": False, "error": "Missing url"}), 400
    if end <= start:
        return jsonify({"ok": False, "error": "end must be greater than start"}), 400

    try:
        src_path = download_best_video(url)
        idx = reserve_batch_index()
        filename = f"({idx}) {mmss_from_seconds(start)}-{mmss_from_seconds(end)}.mp4"
        out_path = CLIPS_DIR / filename
        ffmpeg_clip(src_path, start, end, out_path)
        return jsonify({"ok": True, "file": filename, "url": f"/clips/{filename}"}), 200
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500


@app.route("/api/files", methods=["GET"])
def api_files():
    """
    List saved clips for the CURRENT BATCH (i.e., files whose mtime >= last_reset).
    Sorted newest first.
    """
    st = read_state()
    last_reset = st["last_reset"]

    files = []
    for p in CLIPS_DIR.iterdir():
        if p.is_file():
            try:
                mtime = p.stat().st_mtime
            except FileNotFoundError:
                continue
            if mtime >= last_reset:
                files.append(p)

    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    items = [{"file": p.name, "url": f"/clips/{p.name}", "bytes": p.stat().st_size} for p in files]
    return jsonify({"ok": True, "items": items})




@app.route("/api/batch/reset", methods=["POST"])
def api_batch_reset():
    """
    Reset the batch: counter -> 1 and last_reset -> now.
    Optionally moves current batch clips into a subfolder if "folder" provided.
    """
    data = request.get_json(force=True, silent=True) or {}
    folder_name = (data.get("folder") or "").strip()

    st = read_state()
    last_reset = st["last_reset"]

    # Archive files before reset
    archived = []
    if folder_name:
        archive_dir = CLIPS_DIR / folder_name
        archive_dir.mkdir(exist_ok=True)

        for p in CLIPS_DIR.iterdir():
            if p.is_file():
                try:
                    if p.stat().st_mtime >= last_reset:
                        new_path = archive_dir / p.name
                        p.replace(new_path)  # move
                        archived.append(p.name)
                except FileNotFoundError:
                    continue

    # Reset state and clear tmp
    st = reset_batch()
    removed = 0
    for p in TMP_DIR.iterdir():
        try:
            if p.is_file():
                p.unlink(missing_ok=True); removed += 1
            elif p.is_dir():
                shutil.rmtree(p, ignore_errors=True); removed += 1
        except Exception:
            pass

    return jsonify({
        "ok": True,
        "counter": st["counter"],
        "tmp_deleted": removed,
        "archived": archived,
        "folder": folder_name
    })


@app.route("/api/probe", methods=["POST"])
def api_probe():
    data = request.get_json(force=True, silent=True) or {}
    url = (data.get("url") or "").strip()
    if not url:
        return jsonify({"ok": False, "error": "Missing url"}), 400
    try:
        with YoutubeDL({"quiet": True, "noplaylist": True}) as ydl:
            info = ydl.extract_info(url, download=False)

        thumb = ""
        thumbs = info.get("thumbnails") or []
        if thumbs:
            thumb = max(thumbs, key=lambda t: (t.get("width", 0) * t.get("height", 0))).get("url", "")

        fmts = [f for f in (info.get("formats") or []) if f.get("vcodec") and f["vcodec"] != "none"]
        is_vertical = False
        if fmts:
            best = max(fmts, key=lambda f: (f.get("width") or 0) * (f.get("height") or 0))
            w = int(best.get("width") or 0); h = int(best.get("height") or 0)
            is_vertical = (h > w and h > 0 and w > 0)

        return jsonify({
            "ok": True,
            "id": info.get("id") or "",
            "title": info.get("title") or "",
            "uploader": info.get("uploader") or info.get("channel") or "",
            "duration": float(info.get("duration") or 0),
            "thumbnail": thumb,
            "is_vertical": is_vertical,
            "chapters": info.get("chapters") or [],
        })
    except Exception as e:
        return jsonify({"ok": False, "error": str(e)}), 500
    

@app.route("/clips/<path:filename>", methods=["GET"])
def serve_clip(filename):
    return send_from_directory(CLIPS_DIR, filename, as_attachment=False)


if __name__ == "__main__":
    # For local dev only
    app.run(host="127.0.0.1", port=5000, debug=True)
