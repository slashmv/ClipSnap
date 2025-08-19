import { useEffect, useRef, useState, useCallback } from "react";
import YouTube from "react-youtube";
import axios from "axios";

/* utils */
function toHMS(totalSeconds) {
  if (!Number.isFinite(totalSeconds)) return "00:00:00";
  const s = Math.max(0, Math.floor(totalSeconds));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
}
function extractYouTubeId(u) {
  if (!u) return "";
  try {
    const url = new URL(u.trim());
    if (url.hostname.includes("youtu.be")) return url.pathname.replace("/", "");
    if (url.hostname.includes("youtube.com")) {
      if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2];
      return url.searchParams.get("v") || "";
    }
    return "";
  } catch {
    return "";
  }
}
function splitHMSFloat(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = +(s - hh * 3600 - mm * 60).toFixed(2);
  return { hh, mm, ss };
}
const clampInt = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.floor(Number(n) || 0)));
const clampNum = (n, lo, hi) => Math.min(hi, Math.max(lo, Number(n) || 0));

/* MMSS helper for preview */
function mmss4(sec) {
  const total = Math.max(0, Math.floor(sec));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}${String(s).padStart(2, "0")}`;
}

function timeAgo(ts) {
  if (!ts) return "";
  const diff = Math.max(0, Date.now() / 1000 - ts);
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function stateBadge(state) {
  const color = {
    queued: "#555",
    working: "#555",
    downloading: "#1e90ff",
    clipping: "#a667f1",
    done: "green",
    error: "crimson",
  }[state] || "#555";
  return (
    <span style={{ color, fontWeight: 600, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      {state || "unknown"}
    </span>
  );
}

// --- Keybind helpers ---
function togglePlayRef(ytRef, setPlaying) {
  try {
    const isPlaying = ytRef.current?.getPlayerState?.() === 1;
    if (isPlaying) ytRef.current?.pauseVideo?.();
    else ytRef.current?.playVideo?.();
    setPlaying(!isPlaying);
  } catch {}
}

// Ignore most keys while the user is typing in an input/textarea/contenteditable
function isTypingIntoForm() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

export default function App() {
  const ytRef = useRef(null);
  const iframeNodeRef = useRef(null);        // holds the <iframe> DOM node
  const pollRef = useRef(null);              // player progress poll
  const jobsPollRef = useRef(null);          // backend jobs poll
  const rafRef = useRef(0);
  const focusCatcherRef = useRef(null);      // invisible focus target to yank focus back

  // url/load
  const [url, setUrl] = useState("");
  const [videoId, setVideoId] = useState("");
  const [playing, setPlaying] = useState(false);

  // timing
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [start, setStart] = useState(0);
  const [end, setEnd] = useState(0);

  // ui/files/batch
  const [status, setStatus] = useState("");
  const [clips, setClips] = useState([]);
  const [nextIndex, setNextIndex] = useState(1); // batch counter from backend
  const [folderName, setFolderName] = useState(""); // archive folder name

  // headless fallback (auto when embed fails)
  const [headless, setHeadless] = useState(false);
  const [meta, setMeta] = useState({
    title: "",
    uploader: "",
    thumbnail: "",
    duration: 0,
    chapters: [],
  });

  // ---- Backend Jobs / Log ----
  const [jobs, setJobs] = useState([]);         // latest /api/jobs list
  const [events, setEvents] = useState([]);     // rolling event feed
  const prevStatesRef = useRef({});             // job_id -> lastState
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Helper: set start and ALWAYS snap end to start+10s once per In set.
  const setStartAndSnap = useCallback((ns) => {
    const newStart = Math.max(0, Math.min(duration || 0, ns || 0));
    setStart(newStart);
    setEnd(() => {
      const proposed = newStart + 10;
      // clamp to duration if needed
      return Math.max(0, Math.min(duration || proposed, proposed));
    });
  }, [duration]);

  const reclaimFocus = () => {
    try { focusCatcherRef.current?.focus(); } catch {}
  };

  const scheduleSeek = (sec) => {
    const clamped = Math.max(0, Math.min(duration, sec));
    if (headless) { setCurrent(clamped); return; }
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => seek(clamped));
  };

  const handleLoad = () => {
    const id = extractYouTubeId(url);
    if (!id) { setStatus("Enter a valid YouTube URL."); return; }
    setVideoId(id);
    setHeadless(false);
    setStatus("");
    setPlaying(true);
    setDuration(0); setCurrent(0); setStart(0); setEnd(0);
  };

  const onPlayerReady = (e) => {
    ytRef.current = e.target;

    try {
      const iframe = e.target?.getIframe?.();
      if (iframe) {
        iframeNodeRef.current = iframe;
        iframe.setAttribute("tabindex", "-1");
        const onIframeFocus = () => requestAnimationFrame(reclaimFocus);
        iframe.addEventListener("focus", onIframeFocus);
        iframe._onIframeFocus = onIframeFocus;
      }
    } catch {}

    let tries = 0;
    const check = setInterval(async () => {
      if (headless) { clearInterval(check); return; }
      const d = ytRef.current?.getDuration?.() || 0;
      if (d > 0) {
        setDuration(d);
        setEnd(d);
        clearInterval(check);
      } else if (++tries > 40) {
        clearInterval(check);
        setStatus("Embedding blocked; switching to headless timestamp mode.");
        setHeadless(true);
        await probeUrl(url);
      }
    }, 200);

    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => {
      if (headless) return;
      const t = ytRef.current?.getCurrentTime?.() || 0;
      setCurrent(t);
      if (playing && end > start && t >= end - 0.02) {
        ytRef.current?.seekTo?.(start, true);
      }
    }, 150);
  };

  const onPlayerError = async (e) => {
    const code = e?.data;
    if (code === 101 || code === 150) {
      setStatus("Embedding disabled by uploader; switching to headless mode.");
    } else {
      setStatus(`YouTube embed error (${code}). Using headless mode.`);
    }
    setHeadless(true);
    await probeUrl(url);
  };

  const onStateChange = (e) => {
    if (e.data === 1) setPlaying(true);
    if (e.data === 2 || e.data === 0) setPlaying(false);
  };

  useEffect(() => () => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (jobsPollRef.current) clearInterval(jobsPollRef.current);
    if (rafRef.current) cancelAnimationFrame(rafRef.current);

    const iframe = iframeNodeRef.current;
    if (iframe && iframe._onIframeFocus) {
      try { iframe.removeEventListener("focus", iframe._onIframeFocus); } catch {}
      delete iframe._onIframeFocus;
    }
  }, []);

  useEffect(() => {
    const onBlur = () => { setTimeout(reclaimFocus, 0); };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, []);

  const seek = (sec) => {
    if (!duration) return;
    const clamped = Math.max(0, Math.min(duration, sec));
    ytRef.current?.seekTo?.(clamped, true);
    setCurrent(clamped);
  };

  async function probeUrl(rawUrl) {
    try {
      const id = extractYouTubeId(rawUrl);
      const watchUrl = `https://www.youtube.com/watch?v=${id}`;
      const { data } = await axios.post("/api/probe", { url: watchUrl });
      if (data?.ok) {
        setMeta({
          title: data.title || "",
          uploader: data.uploader || "",
          thumbnail: data.thumbnail || "",
          duration: data.duration || 0,
          chapters: data.chapters || [],
        });
        const d = data.duration || 0;
        setDuration(d);
        setEnd(d);
        return true;
      }
      setStatus(data?.error || "Failed to probe video.");
      return false;
    } catch (e) {
      setStatus(e?.response?.data?.error || e.message);
      return false;
    }
  }

  // files list
  const fetchClips = async () => {
    try { const { data } = await axios.get("/api/files"); if (data?.ok) setClips(data.items || []); }
    catch { setStatus("Failed to fetch files list"); }
  };
  useEffect(() => { fetchClips(); }, []);

  // batch counter
  const fetchBatch = async () => {
    try {
      const { data } = await axios.get("/api/batch/status");
      if (data?.ok) setNextIndex(data.counter);
    } catch { setStatus("Failed to fetch batch counter"); }
  };
  useEffect(() => { fetchBatch(); }, []);

  // Reset with optional folder archive
  const resetBatch = async (folder = "") => {
    try {
      const payload = folder ? { folder } : {};
      const { data } = await axios.post("/api/batch/reset", payload);
      if (data?.ok) {
        setNextIndex(data.counter);
        setClips([]);
        setStatus(
          data.folder
            ? `Batch reset. Archived clips in folder "${data.folder}".`
            : "Batch counter reset to 1. List cleared."
        );
        await fetchClips();
        setJobs([]);
        setEvents((evs) => [
          { t: Date.now(), msg: `Batch cleared${data.folder ? ` → archived to "${data.folder}"` : ""}.` },
          ...evs,
        ].slice(0, 200));
        prevStatesRef.current = {};
      }
    } catch {
      setStatus("Failed to reset batch counter");
    }
  };

  // create clip
  const createClip = async () => {
    if (!videoId) return setStatus("Load a valid YouTube URL first.");
    if (end <= start) return setStatus("End time must be greater than start time.");
    setStatus("Queued…");

    try {
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
      const { data } = await axios.post("/api/clip/queue", { url: watchUrl, start, end });
      if (!data?.ok) return setStatus(data?.error || "Failed to queue job.");
      const jobId = data.job_id;
      const idx = data.index;
      const filename = data.filename;
      setStatus(`Queued job ${jobId}…`);

      setEvents((evs) => [
        { t: Date.now(), msg: `Queued (#${idx}) ${filename} — id ${jobId}` },
        ...evs,
      ].slice(0, 200));

      const poll = setInterval(async () => {
        try {
          const r = await axios.get(`/api/jobs/${jobId}`);
          const job = r?.data?.job;
          if (!job) return;
          if (job.state === "done") {
            clearInterval(poll);
            setStatus(`Saved: ${job.filename}`);
            fetchClips();
            fetchBatch();
          }
          if (job.state === "error") {
            clearInterval(poll);
            setStatus(job.error || "Error while processing.");
          }
        } catch (e) {
            clearInterval(poll);
            setStatus("Job polling failed." + e.message);
        }
      }, 1000);
    } catch (err) {
      setStatus(err?.response?.data?.error || err.message);
    }
  };

  // HH/MM/SS inputs — when In changes, auto-set Out = In + 10s
  const updateStartFromParts = (h, m, s) => {
    const hh = clampInt(h, 0, 99999);
    const mm = clampInt(m, 0, 59);
    const ss = clampNum(s, 0, 59.99);
    let sec = hh * 3600 + mm * 60 + ss;
    sec = Math.max(0, Math.min(duration, sec));
    setStartAndSnap(sec);
    if (current < sec) scheduleSeek(sec);
  };
  const updateEndFromParts = (h, m, s) => {
    const hh = clampInt(h, 0, 99999);
    const mm = clampInt(m, 0, 59);
    const ss = clampNum(s, 0, 59.99);
    let sec = hh * 3600 + mm * 60 + ss;
    sec = Math.max(0, Math.min(duration, sec));
    setEnd(sec);
    if (current > sec) scheduleSeek(sec);
  };

  // ---- Jobs polling + event feed ----
  const fetchJobs = async () => {
    try {
      const { data } = await axios.get("/api/jobs");
      if (!data?.ok) return;
      const items = Array.isArray(data.items) ? data.items : [];
      setJobs(items);

      const prev = prevStatesRef.current || {};
      const now = {};
      const newEvents = [];
      for (const j of items) {
        now[j.id] = j.state;
        const before = prev[j.id];
        if (before && before !== j.state) {
          const msg = `Job #${j.index} ${j.filename || ""} → ${j.state}${j.state === "done" && j.url ? ` (${j.url})` : ""}`;
          newEvents.push({ t: Date.now(), msg });
        }
        if (!before && j.state !== "queued") {
          newEvents.push({ t: Date.now(), msg: `Job #${j.index} ${j.filename || ""} is ${j.state}` });
        }
      }
      if (newEvents.length) {
        setEvents((evs) => [...newEvents, ...evs].slice(0, 200));
      }
      prevStatesRef.current = now;
    } catch (e) {
      setEvents((evs) => [{ t: Date.now(), msg: "Failed to fetch /api/jobs" }, ...evs].slice(0, 200));
    }
  };

  useEffect(() => {
    const startPoll = () => {
      if (jobsPollRef.current) clearInterval(jobsPollRef.current);
      jobsPollRef.current = setInterval(fetchJobs, 1200);
    };
    if (autoRefresh) startPoll();
    return () => {
      if (jobsPollRef.current) clearInterval(jobsPollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh]);

  // ---- Global keybindings ----
  useEffect(() => {
    const onKeyDown = (e) => {
      const key = e.key;
      const ctrl = e.ctrlKey || e.metaKey;   // Ctrl on Win/Linux, Cmd on macOS
      const shift = e.shiftKey;

      if (isTypingIntoForm() && key !== "Escape" && !ctrl) return;

      if (key === " " || key === "Spacebar") {
        e.preventDefault();
        if (!headless) togglePlayRef(ytRef, setPlaying);
        return;
      }

      if (key === "ArrowLeft" || key === "ArrowRight") {
        e.preventDefault();
        const delta = shift ? 1 : 5;
        const dir = key === "ArrowLeft" ? -1 : 1;
        const target = Math.max(0, Math.min(duration, (current || 0) + dir * delta));
        scheduleSeek(target);
        return;
      }

      if (!ctrl && (key === "i" || key === "I")) {
        e.preventDefault();
        const ns = Math.max(0, Math.min(duration, current || 0));
        setStartAndSnap(ns);
        return;
      }
      if (!ctrl && (key === "o" || key === "O")) {
        e.preventDefault();
        setEnd(Math.max(0, Math.min(duration, current || 0)));
        return;
      }

      if (!ctrl && (key === "j" || key === "J")) {
        e.preventDefault();
        scheduleSeek(start || 0);
        return;
      }
      if (!ctrl && (key === "k" || key === "K")) {
        e.preventDefault();
        scheduleSeek(end || 0);
        return;
      }

      if (key === "Enter" && !ctrl) {
        if (!isTypingIntoForm()) {
          e.preventDefault();
          if (videoId && end > start) createClip();
        }
        return;
      }

      if (ctrl && (key === "b" || key === "B")) {
        e.preventDefault();
        resetBatch((folderName || "").trim());
        return;
      }

      if (ctrl && shift && (key === "s" || key === "S")) {
        e.preventDefault();
        const fn = (folderName || "").trim();
        resetBatch(fn);
        return;
      }

      if (!ctrl && (key === "r" || key === "R")) {
        e.preventDefault();
        setStart(0);
        setEnd(duration || 0);
        return;
      }

      if (key === "Escape") {
        e.preventDefault();
        if (!headless) {
          try { ytRef.current?.pauseVideo?.(); } catch {}
          setPlaying(false);
        }
        setStart(0);
        setEnd(duration || 0);
        scheduleSeek(0);
        return;
      }
    };

    window.addEventListener("keydown", onKeyDown, { passive: false });
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [headless, duration, current, start, end, folderName, videoId]);

  // ---- UI bits ----
  const barHeight = 10, hitHeight = 28;
  const pct = (x) => (duration ? (x / duration) * 100 : 0);
  const startPct = pct(start), endPct = pct(end), currPct = pct(current);
  const rangeProps = { type: "range", min: 0, max: Math.max(0.01, duration), step: 0.05 };
  const onRailClick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    scheduleSeek(p * duration);
  };

  const { hh: sHH, mm: sMM, ss: sSS } = splitHMSFloat(start);
  const { hh: eHH, mm: eMM, ss: eSS } = splitHMSFloat(end);

  const previewName = `(${nextIndex}) ${mmss4(start)}-${mmss4(end)}.mp4`;

  const counts = jobs.reduce((acc, j) => { acc[j.state] = (acc[j.state] || 0) + 1; return acc; }, {});

  return (
    <div style={{ maxWidth: 960, margin: "24px auto", padding: "16px", fontFamily: "Inter, Arial, sans-serif" }}>
      {/* Invisible focus target to keep document focused for global hotkeys */}
      <button
        ref={focusCatcherRef}
        aria-hidden="true"
        tabIndex={-1}
        style={{ position: "fixed", opacity: 0, width: 0, height: 0, pointerEvents: "none" }}
      />

      <h1>YouTube Clipper (Local)</h1>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "1fr auto" }}>
        <input placeholder="Paste YouTube URL" value={url} onChange={(e)=>setUrl(e.target.value)} style={{ padding: 8, fontSize: 16 }}/>
        <button onClick={handleLoad} style={{ padding: "8px 12px", fontSize: 16 }}>Load</button>
      </div>

      {videoId && (
        <div style={{ marginTop: 16 }}>
          {!headless && (
            <div onMouseDown={() => setTimeout(reclaimFocus, 0)}>
              <YouTube
                videoId={videoId}
                opts={{
                  width: "100%",
                  height: "480",
                  playerVars: {
                    origin: typeof window !== "undefined" ? window.location.origin : undefined,
                    modestbranding: 1,
                    rel: 0,
                    controls: 1,
                    playsinline: 1,
                    enablejsapi: 1,
                    disablekb: 1,
                  },
                  host: "https://www.youtube-nocookie.com",
                }}
                onReady={onPlayerReady}
                onError={onPlayerError}
                onStateChange={onStateChange}
              />
            </div>
          )}

          {headless && (
            <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8, border: "1px solid #eee", padding: 8, borderRadius: 6 }}>
              {meta.thumbnail && <img src={meta.thumbnail} alt="" style={{ width: 160, height: "auto", borderRadius: 6 }} />}
              <div>
                <div style={{ fontWeight: 600 }}>{meta.title || "Untitled"}</div>
                <div style={{ color: "#666", fontSize: 13 }}>{meta.uploader}</div>
                <div style={{ color: "#666", fontSize: 13 }}>Duration: {toHMS(meta.duration || duration)}</div>
                <a href={`https://www.youtube.com/watch?v=${videoId}`} target="_blank" rel="noreferrer">Open on YouTube</a>
              </div>
            </div>
          )}

          {/* timeline */}
          <div style={{ marginTop: 16 }}>
            <div
              style={{ position:"relative", width:"100%", height:barHeight, background:"#e7e7e7", borderRadius:6, userSelect:"none" }}
              onClick={onRailClick}
            >
              <div style={{ position:"absolute", left:`${startPct}%`, width:`${Math.max(0, endPct-startPct)}%`,
                height:barHeight, background:"rgba(0,0,0,0.18)", borderRadius:6, pointerEvents:"none" }}/>

              {/* Start handle */}
              <input
                {...rangeProps}
                value={start}
                onChange={(e) => setStart(clampNum(e.target.value, 0, duration))}
                onPointerUp={() => { if (!headless) { setStartAndSnap(start); if (current < start) scheduleSeek(start); } }}
                onMouseUp={() => { if (!headless) { setStartAndSnap(start); if (current < start) scheduleSeek(start); } }}
                style={{ position:"absolute", left:0, right:0, top:`-${(hitHeight-barHeight)/2}px`,
                  width:"100%", height:hitHeight, opacity:0, appearance:"none", background:"transparent", zIndex:2, cursor:"ew-resize" }}
              />

              {/* End handle */}
              <input
                {...rangeProps}
                value={end}
                onChange={(e) => setEnd(clampNum(e.target.value, 0, duration))}
                onPointerUp={() => { if (!headless && current > end) scheduleSeek(end); }}
                onMouseUp={() => { if (!headless && current > end) scheduleSeek(end); }}
                style={{ position:"absolute", left:0, right:0, top:`-${(hitHeight-barHeight)/2}px`,
                  width:"100%", height:hitHeight, opacity:0, appearance:"none", background:"transparent", zIndex:2, cursor:"ew-resize" }}
              />

              {/* Scrubber */}
              <input
                {...rangeProps}
                value={current}
                onChange={(e) => { const t = clampNum(e.target.value, 0, duration); setCurrent(t); scheduleSeek(t); }}
                style={{ position:"absolute", left:0, right:0, top:`-${(hitHeight-barHeight)/2}px`,
                  width:"100%", height:hitHeight, opacity:0, appearance:"none", background:"transparent", zIndex:3, cursor:"ew-resize" }}
              />

              <div style={{ position:"absolute", top:-4, left:`calc(${currPct}% - 1px)`, width:2, height:barHeight+8, background:"#333", borderRadius:2, pointerEvents:"none", zIndex:4 }}/>
            </div>

            {/* time boxes */}
            <div style={{ display:"grid", gridTemplateColumns:"1.4fr 1.4fr 1fr 1fr auto", gap:12, alignItems:"center", marginTop:12 }}>
              {/* In HH:MM:SS */}
              <div>
                <div style={{ fontSize:12, color:"#666", marginBottom:6 }}>In (HH:MM:SS)</div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <input type="number" min={0} step={1} value={splitHMSFloat(start).hh}
                    onChange={(e)=>updateStartFromParts(e.target.value, splitHMSFloat(start).mm, splitHMSFloat(start).ss)} style={{ width:64, padding:8, textAlign:"center" }}/>{":"}
                  <input type="number" min={0} max={59} step={1} value={splitHMSFloat(start).mm}
                    onChange={(e)=>updateStartFromParts(splitHMSFloat(start).hh, e.target.value, splitHMSFloat(start).ss)} style={{ width:64, padding:8, textAlign:"center" }}/>{":"}
                  <input type="number" min={0} max={59.99} step={0.01} value={splitHMSFloat(start).ss}
                    onChange={(e)=>updateStartFromParts(splitHMSFloat(start).hh, splitHMSFloat(start).mm, e.target.value)} style={{ width:64, padding:8, textAlign:"center" }}/>
                </div>
              </div>

              {/* Out HH:MM:SS */}
              <div>
                <div style={{ fontSize:12, color:"#666", marginBottom:6 }}>Out (HH:MM:SS)</div>
                <div style={{ display:"flex", alignItems:"center", gap:6 }}>
                  <input type="number" min={0} step={1} value={splitHMSFloat(end).hh}
                    onChange={(e)=>updateEndFromParts(e.target.value, splitHMSFloat(end).mm, splitHMSFloat(end).ss)} style={{ width:64, padding:8, textAlign:"center" }}/>{":"}
                  <input type="number" min={0} max={59} step={1} value={splitHMSFloat(end).mm}
                    onChange={(e)=>updateEndFromParts(splitHMSFloat(end).hh, e.target.value, splitHMSFloat(end).ss)} style={{ width:64, padding:8, textAlign:"center" }}/>{":"}
                  <input type="number" min={0} max={59.99} step={0.01} value={splitHMSFloat(end).ss}
                    onChange={(e)=>updateEndFromParts(splitHMSFloat(end).hh, splitHMSFloat(end).mm, e.target.value)} style={{ width:64, padding:8, textAlign:"center" }}/>
                </div>
              </div>

              <div>
                <div style={{ fontSize:12, color:"#666" }}>Now</div>
                <div style={{ padding:8, border:"1px solid #ddd", borderRadius:4 }}>{toHMS(current)}</div>
              </div>
              <div>
                <div style={{ fontSize:12, color:"#666" }}>Duration</div>
                <div style={{ padding:8, border:"1px solid #ddd", borderRadius:4 }}>{toHMS(duration)}</div>
              </div>

              <div style={{ display:"flex", flexDirection:"column", gap:8, alignItems:"flex-end" }}>
                <div style={{ fontSize:12, color:"#555" }}>Will save as: <b>{previewName}</b></div>
                <div style={{ display:"flex", gap:8 }}>
                  <button onClick={()=>{ setStartAndSnap(current); }}>Mark In (I)</button>
                  <button onClick={()=>{ setEnd(current); }}>Mark Out (O)</button>
                </div>
              </div>
            </div>

            <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:12 }}>
              {!headless && (
                <>
                  <button onClick={()=>{
                    const s = ytRef.current?.getPlayerState?.() === 1;
                    s ? ytRef.current?.pauseVideo?.() : ytRef.current?.playVideo?.();
                    setPlaying(!s);
                  }}>{playing ? "Pause (Space)" : "Play (Space)"}</button>

                  <button onClick={()=>scheduleSeek(start)}>Jump to In (J)</button>
                  <button onClick={()=>scheduleSeek(end)}>Jump to Out (K)</button>
                </>
              )}

              <button onClick={createClip} style={{ marginLeft: headless ? 0 : "auto" }}>Clip & Save (Enter)</button>

              {/* Archive + Reset */}
              <input
                type="text"
                placeholder="Folder name (optional)"
                value={folderName}
                onChange={(e)=>setFolderName(e.target.value)}
                style={{ padding: "6px 8px", fontSize: 14, minWidth: 160 }}
              />
              <button
                onClick={()=>resetBatch(folderName.trim())}
                title="Archive current clips into folder (if provided) and reset counter"
              >
                Clear Batch <br/>Save in Folder (Ctrl + B)
              </button>
            </div>
          </div>
        </div>
      )}

      <p style={{ marginTop:12, color: status.startsWith("Saved") ? "green" : "crimson" }}>{status}</p>

      <h2 style={{ marginTop:24 }}>Saved Clips</h2>
      <div style={{ display:"grid", gap:8 }}>
        {clips.length === 0 && <div>No clips yet.</div>}
        {clips.map((c)=>(
          <div key={c.file} style={{ display:"flex", gap:12, alignItems:"center", border:"1px solid #ddd", padding:8 }}>
            <a href={c.url} target="_blank" rel="noreferrer">{c.file}</a>
            <span style={{ color:"#666", fontSize:12 }}>{(c.bytes / (1024*1024)).toFixed(1)} MB</span>
          </div>
        ))}
      </div>

      {/* ---------------- Backend Log ---------------- */}
      <h2 style={{ marginTop:28, marginBottom:8 }}>Backend Log</h2>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 8 }}>
        <div style={{ fontSize: 14, color: "#555" }}>
          Summary:&nbsp;
          <b>{jobs.length}</b> total
          {Object.entries(counts).map(([k, v]) => (
            <span key={k} style={{ marginLeft: 10 }}>
              {stateBadge(k)}: <b>{v}</b>
            </span>
          ))}
        </div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          <label style={{ fontSize: 14, color: "#555" }}>
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e)=>setAutoRefresh(e.target.checked)}
              style={{ marginRight: 6 }}
            />
            Auto refresh
          </label>
          <button onClick={fetchJobs}>Refresh now</button>
          <button onClick={()=>setEvents([])} title="Clear event feed only">Clear events</button>
        </div>
      </div>

      {/* Jobs table */}
      <div style={{ overflowX: "auto", border: "1px solid #eee", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead style={{ background: "#fafafa" }}>
            <tr>
              <th style={th}>#</th>
              <th style={th}>Filename</th>
              <th style={th}>State</th>
              <th style={th}>In→Out</th>
              <th style={th}>Queued</th>
              <th style={th}>Result</th>
              <th style={th}>Error</th>
            </tr>
          </thead>
          <tbody>
            {jobs.length === 0 && (
              <tr>
                <td colSpan={7} style={{ padding: 12, color: "#666" }}>No jobs yet.</td>
              </tr>
            )}
            {jobs.map((j) => (
              <tr key={j.id} style={{ borderTop: "1px solid #f0f0f0" }}>
                <td style={tdMono}>#{j.index}</td>
                <td style={td}>
                  <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {j.filename || <span style={{ color: "#999" }}>(pending name)</span>}
                  </div>
                </td>
                <td style={td}>{stateBadge(j.state)}</td>
                <td style={tdMono}>
                  {toHMS(j.start || 0)} → {toHMS(j.end || 0)}
                </td>
                <td style={td}>
                  <div>{new Date((j.queued_at || 0) * 1000).toLocaleTimeString()}</div>
                  <div style={{ color: "#888", fontSize: 12 }}>{timeAgo(j.queued_at)}</div>
                </td>
                <td style={td}>
                  {j.state === "done" && j.url ? (
                    <a href={j.url} target="_blank" rel="noreferrer">Open clip</a>
                  ) : (
                    <span style={{ color: "#999" }}>—</span>
                  )}
                </td>
                <td style={{ ...td, color: j.state === "error" ? "crimson" : "#999" }}>
                  {j.state === "error" ? (j.error || "Unknown error") : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Event feed */}
      <div style={{ marginTop: 12, border: "1px dashed #ddd", borderRadius: 8, padding: 8 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Event feed</div>
        <div style={{
          maxHeight: 180, overflowY: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          background: "#0b0b0b", color: "#e7e7e7", padding: 8, borderRadius: 6
        }}>
          {events.length === 0 ? (
            <div style={{ color: "#aaa" }}>No events yet.</div>
          ) : (
            events.map((e, i) => (
              <div key={i} style={{ whiteSpace: "pre-wrap" }}>
                [{new Date(e.t).toLocaleTimeString()}] {e.msg}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// small cell styles
const th = { textAlign: "left", padding: "10px 12px", fontWeight: 600, color: "#444", borderBottom: "1px solid #eee" };
const td = { padding: "10px 12px", verticalAlign: "top" };
const tdMono = { ...td, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" };
