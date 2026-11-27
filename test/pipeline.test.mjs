import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { inspectMp4Metadata, parseBoxes, getBoxHeaderSize } from "../src/mp4-boxes.mjs";
import { runCombinedMp4Pipeline } from "../src/mp4-pipeline.mjs";

const FIXTURES_DIR =
    "C:\\Users\\User\\.gemini\\antigravity\\brain\\96d1eb87-9ddf-4d30-a0a9-1649fa67c907\\scratch\\repos\\NoBlur\\NoBlur-main\\test\\fixtures";

function loadFixture(name) {
    const buf = fs.readFileSync(path.join(FIXTURES_DIR, name));
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function assertValidBoxTree(bytes, view, start, end) {
    const boxes = parseBoxes(bytes, view, start, end);
    assert.ok(boxes.length > 0, "Expected at least one box");
    let total = 0;
    for (const b of boxes) {
        total += b.size;
        if (["moov", "trak", "mdia", "minf", "stbl", "edts"].includes(b.type)) {
            assertValidBoxTree(bytes, view, b.offset + getBoxHeaderSize(b), b.end);
        }
    }
    assert.equal(total, end - start, "Box sizes must sum cleanly to container span");
}

for (const fixture of [
    "h264_faststart.mp4",
    "h264_mdat_first.mp4",
    "h264_co64.mp4",
    "hevc_faststart.mp4",
    "h264_faststart.mov",
]) {
    test(`combined pipeline handles ${fixture}`, () => {
        const ab = loadFixture(fixture);
        const { buffer, bytes, report } = runCombinedMp4Pipeline(ab, {
            normalize: true,
            inflate: true,
            multiplier: 10,
            fpsBypass: "60", // force ÷2 to test mvhd/mdhd patching on all fixtures
            udtaTagging: true,
        });

        const view = new DataView(buffer);
        const topBoxes = parseBoxes(bytes, view, 0, bytes.length);
        const ftyp = topBoxes.find((b) => b.type === "ftyp");
        const moov = topBoxes.find((b) => b.type === "moov");
        const mdat = topBoxes.find((b) => b.type === "mdat");

        assert.ok(ftyp, "ftyp exists");
        assert.ok(moov, "moov exists");
        assert.ok(mdat, "mdat exists");
        assert.ok(moov.offset < mdat.offset, "moov must be before mdat (faststart)");

        // Verify moov internal box tree integrity
        assertValidBoxTree(bytes, view, moov.offset + getBoxHeaderSize(moov), moov.end);

        // Verify sample table inflation
        assert.equal(report.inflated, true);
        assert.equal(
            report.inflateStats.totalFrames,
            report.inflateStats.realFrames * 10,
        );

        // Verify FPS header bypass patched mvhd & mdhd
        assert.equal(report.fpsDivider, 2);
        assert.ok(report.fpsStats.mvhdPatched >= 1, "mvhd patched");
        assert.ok(report.fpsStats.mdhdPatched >= 1, "mdhd patched");

        // Verify re-inspection succeeds
        const finalInfo = inspectMp4Metadata(bytes, view);
        assert.equal(finalInfo.valid, true);
        assert.equal(finalInfo.moovBeforeMdat, true);
        assert.equal(finalInfo.sampleCount, report.inflateStats.totalFrames);
    });
}
