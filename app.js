/**
 * Client-side UI controller for the combined TikTok Quality & FPS Bypass app.
 * Uses pure ISO-BMFF box manipulation by default (instant, zero re-encode),
 * and lazy-loads ffmpeg.wasm only when VFI or HEVC transcoding is selected.
 */

import { inspectMp4Metadata } from "./src/mp4-boxes.mjs";
import { runCombinedMp4Pipeline } from "./src/mp4-pipeline.mjs";

const dropZone = document.getElementById("dropZone");
const fileInput = document.getElementById("fileInput");
const fileListEl = document.getElementById("fileList");
const processBtn = document.getElementById("processBtn");
const clearBtn = document.getElementById("clearBtn");
const progressBox = document.getElementById("progressBox");
const progressLabel = document.getElementById("progressLabel");
const progressPercent = document.getElementById("progressPercent");
const progressBar = document.getElementById("progressBar");
const logConsole = document.getElementById("logConsole");
const resultCard = document.getElementById("resultCard");
const resultSummary = document.getElementById("resultSummary");
const statsTableBody = document.querySelector("#statsTable tbody");
const downloadActions = document.getElementById("downloadActions");

const optInflate = document.getElementById("optInflate");
const optMultiplier = document.getElementById("optMultiplier");
const multiplierVal = document.getElementById("multiplierVal");
const multiplierRow = document.getElementById("multiplierRow");
const optNormalize = document.getElementById("optNormalize");
const optFpsBypass = document.getElementById("optFpsBypass");
const optUdta = document.getElementById("optUdta");
const optFfmpegMode = document.getElementById("optFfmpegMode");

let queue = []; // { id, file, info, status, resultBlob, outputName, report }
let ffmpegInstance = null;

function formatBytes(bytes) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 2)} ${units[i]}`;
}

function log(message, type = "") {
    const line = document.createElement("div");
    line.className = `log-line ${type}`;
    line.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logConsole.appendChild(line);
    logConsole.scrollTop = logConsole.scrollHeight;
}

function setProgress(pct, label) {
    progressBox.classList.add("visible");
    progressBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    progressPercent.textContent = `${Math.round(pct)}%`;
    if (label) progressLabel.textContent = label;
}

optInflate.addEventListener("change", () => {
    multiplierRow.style.opacity = optInflate.checked ? "1" : "0.45";
    optMultiplier.disabled = !optInflate.checked;
});

optMultiplier.addEventListener("input", () => {
    multiplierVal.textContent = `${optMultiplier.value}x`;
});

// Drag & Drop
dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
});
dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
});
dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
});
fileInput.addEventListener("change", (e) => {
    if (e.target.files.length > 0) addFiles(e.target.files);
    fileInput.value = "";
});

async function addFiles(fileList) {
    const validExts = [".mp4", ".mov"];
    for (const file of fileList) {
        const lower = file.name.toLowerCase();
        if (!validExts.some((ext) => lower.endsWith(ext))) {
            log(`Skipped unsupported file: ${file.name} (MP4/MOV only)`, "warning");
            continue;
        }
        const item = {
            id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random()),
            file,
            info: null,
            status: "ready",
            resultBlob: null,
            outputName: "",
            report: null,
        };
        queue.push(item);

        try {
            const buf = await file.arrayBuffer();
            item.info = inspectMp4Metadata(new Uint8Array(buf), new DataView(buf));
            log(
                `Inspected ${file.name}: ${item.info.codec}, ${item.info.width || "?"}x${item.info.height || "?"}, ${item.info.fps ? item.info.fps.toFixed(1) + " fps" : "unknown fps"}`,
                "info",
            );
        } catch (err) {
            log(`Could not inspect ${file.name}: ${err.message}`, "warning");
        }
    }
    renderQueue();
    updateButtons();
}

function renderQueue() {
    fileListEl.innerHTML = "";
    for (const item of queue) {
        const el = document.createElement("div");
        el.className = "file-item";

        const chips = [`<span class="meta-chip">${formatBytes(item.file.size)}</span>`];
        if (item.info && item.info.valid) {
            chips.push(`<span class="meta-chip">Codec: ${item.info.codec}</span>`);
            if (item.info.width && item.info.height) {
                chips.push(`<span class="meta-chip">${item.info.width}×${item.info.height}</span>`);
            }
            if (item.info.fps) {
                chips.push(`<span class="meta-chip">${item.info.fps.toFixed(0)} FPS</span>`);
            }
            chips.push(
                `<span class="meta-chip">moov: ${item.info.moovBeforeMdat ? "front" : "end"}</span>`,
            );
        }

        el.innerHTML = `
            <div class="file-item-top">
                <span class="file-name">${item.file.name}</span>
                <span class="file-status ${item.status}">${item.status.toUpperCase()}</span>
            </div>
            <div class="file-meta">${chips.join("")}</div>
        `;
        fileListEl.appendChild(el);
    }
}

function updateButtons() {
    const hasFiles = queue.length > 0;
    processBtn.disabled = !hasFiles;
    clearBtn.disabled = !hasFiles;
}

clearBtn.addEventListener("click", () => {
    queue = [];
    renderQueue();
    updateButtons();
    resultCard.classList.remove("visible");
    progressBox.classList.remove("visible");
    logConsole.innerHTML = '<div class="log-line">Queue cleared.</div>';
});

async function loadFFmpegLazy() {
    if (ffmpegInstance) return ffmpegInstance;
    log("Lazy-loading ffmpeg.wasm (~30MB) for heavy video processing...", "info");

    const loadScript = (src) =>
        new Promise((resolve, reject) => {
            if (document.querySelector(`script[src="${src}"]`)) return resolve();
            const s = document.createElement("script");
            s.src = src;
            s.onload = resolve;
            s.onerror = () => reject(new Error(`Failed to load ${src}`));
            document.head.appendChild(s);
        });

    await loadScript("https://unpkg.com/@ffmpeg/ffmpeg@0.12.10/dist/umd/ffmpeg.js");
    await loadScript("https://unpkg.com/@ffmpeg/util@0.12.1/dist/umd/index.js");

    const { FFmpeg } = window.FFmpegWASM;
    const { toBlobURL } = window.FFmpegUtil;
    const ffmpeg = new FFmpeg();
    ffmpeg.on("progress", ({ progress }) => {
        setProgress(10 + Math.min(70, progress * 70), "Running FFmpeg.wasm...");
    });

    const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd";
    await ffmpeg.load({
        coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript"),
        wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm"),
    });
    ffmpegInstance = ffmpeg;
    log("FFmpeg.wasm loaded.", "success");
    return ffmpegInstance;
}

async function runFfmpegPreprocess(file, mode) {
    const ffmpeg = await loadFFmpegLazy();
    const { fetchFile } = window.FFmpegUtil;
    const ext = file.name.toLowerCase().endsWith(".mov") ? ".mov" : ".mp4";
    const inName = `in${ext}`;
    const outName = "pre.mp4";

    await ffmpeg.writeFile(inName, await fetchFile(file));

    let args;
    if (mode === "vfi60") {
        args = [
            "-y", "-i", inName,
            "-vf", "mpdecimate,minterpolate=fps=60:mi_mode=mci:me_mode=bilat:me=epzs:search_param=4:scd=none,scale=1080:-2",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "20",
            "-c:a", "copy", "-video_track_timescale", "90000", outName,
        ];
    } else {
        // hevc1080
        args = [
            "-y", "-i", inName,
            "-vf", "scale='min(1080,iw)':-2",
            "-c:v", "libx265", "-preset", "fast", "-crf", "18", "-tag:v", "hvc1",
            "-c:a", "copy", "-video_track_timescale", "90000", outName,
        ];
    }

    log(`Executing FFmpeg: ffmpeg ${args.join(" ")}`, "info");
    const ret = await ffmpeg.exec(args);
    if (ret !== 0) {
        throw new Error(`FFmpeg exited with code ${ret}`);
    }
    const data = await ffmpeg.readFile(outName);
    await ffmpeg.deleteFile(inName).catch(() => {});
    await ffmpeg.deleteFile(outName).catch(() => {});
    return data.slice().buffer;
}

function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function showResultSummary(lastItem) {
    const { report } = lastItem;
    const init = report.initialInfo;
    const fin = report.finalInfo;

    const rows = [
        ["File Size", formatBytes(report.originalSize), formatBytes(report.outputSize)],
        ["Codec", init.codec, fin.codec],
        [
            "Container (moov)",
            init.moovBeforeMdat ? "Front" : "End",
            fin.moovBeforeMdat ? "✅ Front (faststart)" : "End",
        ],
        [
            "Sample Table",
            `${init.sampleCount} samples`,
            report.inflated
                ? `✅ ${report.inflateStats.totalFrames} samples (${optMultiplier.value}x)`
                : "Unchanged",
        ],
        [
            "FPS Header Bypass",
            init.fps ? `${init.fps.toFixed(1)} FPS` : "Unknown",
            report.fpsDivider >= 2
                ? `✅ Patched ÷${report.fpsDivider} (${fin.fps ? fin.fps.toFixed(1) + " FPS hdr" : "patched"})`
                : "Off",
        ],
        [
            "udta Signature",
            "Original",
            report.udtaApplied ? "✅ Lavf59.27.100 + comment" : "Unchanged",
        ],
    ];

    statsTableBody.innerHTML = rows
        .map(
            ([k, orig, patched]) => `
        <tr>
            <td>${k}</td>
            <td>${orig}</td>
            <td class="good">${patched}</td>
        </tr>`,
        )
        .join("");

    resultSummary.textContent = `${queue.filter((q) => q.status === "done").length} file(s) ready`;
    downloadActions.innerHTML = "";

    for (const item of queue) {
        if (item.status !== "done" || !item.resultBlob) continue;
        const btn = document.createElement("button");
        btn.className = "btn btn-success";
        btn.textContent = `⬇ Download ${item.outputName}`;
        btn.addEventListener("click", () => triggerDownload(item.resultBlob, item.outputName));
        downloadActions.appendChild(btn);
    }

    resultCard.classList.add("visible");
}

processBtn.addEventListener("click", async () => {
    if (queue.length === 0) return;

    processBtn.disabled = true;
    clearBtn.disabled = true;
    resultCard.classList.remove("visible");

    const ffmpegMode = optFfmpegMode.value;
    const pipelineOpts = {
        normalize: optNormalize.checked,
        inflate: optInflate.checked,
        multiplier: Number.parseInt(optMultiplier.value, 10) || 10,
        fpsBypass: optFpsBypass.value,
        udtaTagging: optUdta.checked,
    };

    let lastDone = null;

    for (let i = 0; i < queue.length; i++) {
        const item = queue[i];
        item.status = "processing";
        renderQueue();

        try {
            setProgress((i / queue.length) * 100 + 5, `Processing ${item.file.name}...`);
            let arrayBuf;

            if (ffmpegMode !== "none") {
                arrayBuf = await runFfmpegPreprocess(item.file, ffmpegMode);
            } else {
                arrayBuf = await item.file.arrayBuffer();
            }

            setProgress((i / queue.length) * 100 + 60, `Patching MP4 boxes (${item.file.name})...`);
            const { buffer, report } = runCombinedMp4Pipeline(arrayBuf, pipelineOpts);

            const base = item.file.name.replace(/\.[^/.]+$/, "");
            item.outputName = `${base}_NoBlur_Patched.mp4`;
            item.resultBlob = new Blob([buffer], { type: "video/mp4" });
            item.report = report;
            item.status = "done";
            lastDone = item;

            log(
                `Done: ${item.outputName} (${formatBytes(report.outputSize)}, ${
                    report.inflated ? report.inflateStats.totalFrames + " samples, " : ""
                }${report.fpsDivider ? "FPS ÷" + report.fpsDivider : "FPS unchanged"})`,
                "success",
            );
        } catch (err) {
            item.status = "error";
            log(`Error on ${item.file.name}: ${err.message}`, "error");
        }
        renderQueue();
    }

    setProgress(100, "Complete!");
    if (lastDone) {
        showResultSummary(lastDone);
    }

    processBtn.disabled = false;
    clearBtn.disabled = false;
});
