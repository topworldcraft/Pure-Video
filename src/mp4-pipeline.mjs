/**
 * Combined client-side MP4 bypass pipeline:
 * 1. Container normalization (NoBlur: moov faststart + ftyp isom/iso4)
 * 2. Sample table inflation (NoBlur + tiktok-quality: 2x-15x dummy samples)
 * 3. High-FPS header bypass (120fps-method: mvhd/mdhd timescale & duration divider)
 * 4. Optional udta metadata tagging (tiktok-lossless-upload / tiktok-quality)
 */

import { inspectMp4Metadata } from "./mp4-boxes.mjs";
import { applyUdtaMetadata, patchFpsHeaders } from "./mp4-fps.mjs";
import { inflateSampleTableVideo } from "./mp4-inflate.mjs";
import { normalizeContainer } from "./mp4-normalize.mjs";

export function resolveFpsDivider(fpsMode, detectedFps) {
    if (fpsMode === "2" || fpsMode === "60") return 2;
    if (fpsMode === "4" || fpsMode === "120") return 4;
    if (fpsMode === "auto" && detectedFps) {
        if (detectedFps >= 100) return 4;
        if (detectedFps >= 50) return 2;
    }
    return 0;
}

export function runCombinedMp4Pipeline(arrayBuffer, options = {}) {
    const {
        normalize = true,
        inflate = true,
        multiplier = 10,
        fpsBypass = "auto", // "off" | "auto" | "60" | "120"
        udtaTagging = true,
        encoderTag = "Lavf59.27.100",
        commentTag = "NoBlur+120FPS",
    } = options;

    let bytes = new Uint8Array(arrayBuffer);
    let view = new DataView(arrayBuffer);
    const initialInfo = inspectMp4Metadata(bytes, view);

    if (!initialInfo.valid) {
        throw new Error("Invalid or fragmented MP4/MOV (missing moov or mdat box).");
    }

    const report = {
        originalSize: bytes.length,
        initialInfo,
        normalized: false,
        inflated: false,
        inflateStats: null,
        fpsDivider: 0,
        fpsStats: null,
        udtaApplied: false,
    };

    // 1. Normalize container (moov before mdat, ftyp isom/iso4)
    if (normalize) {
        const norm = normalizeContainer(bytes, view);
        if (!norm.valid) {
            throw new Error("Container normalization failed: invalid MP4 structure.");
        }
        bytes = norm.newBytes;
        view = norm.newView;
        report.normalized = norm.changed;
    }

    // 2. Sample table inflation
    if (inflate && multiplier >= 2) {
        const inf = inflateSampleTableVideo(bytes, view, multiplier);
        bytes = inf.newBytes;
        view = inf.newView;
        report.inflated = true;
        report.inflateStats = inf.stats;
    }

    // 3. High-FPS timescale/duration bypass (120fps-method)
    const divider = resolveFpsDivider(fpsBypass, initialInfo.fps);
    if (divider >= 2) {
        const fpsRes = patchFpsHeaders(bytes, view, divider);
        report.fpsDivider = divider;
        report.fpsStats = fpsRes;
    }

    // 4. Optional udta metadata tagging
    if (udtaTagging && (commentTag || encoderTag)) {
        const udtaRes = applyUdtaMetadata(bytes, view, {
            comment: commentTag,
            encoder: encoderTag,
        });
        bytes = udtaRes.newBytes;
        view = udtaRes.newView;
        report.udtaApplied = true;
    }

    report.outputSize = bytes.length;
    report.finalInfo = inspectMp4Metadata(bytes, view);

    return {
        buffer: bytes.buffer,
        bytes,
        report,
    };
}
