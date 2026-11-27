/**
 * High-FPS header patching (120fps-method) and udta metadata tagging
 * (tiktok-quality / tiktok-lossless-upload).
 *
 * Uses structural MP4 box traversal instead of raw byte scanning so video
 * payload bytes inside `mdat` are never touched.
 */

import {
    getBoxHeaderSize,
    parseBoxes,
    updateBoxSize,
    updateChunkOffsets,
} from "./mp4-boxes.mjs";

function divideTimescaleAndDuration(bytes, view, box, isMvhd) {
    const hSize = getBoxHeaderSize(box);
    if (box.offset + hSize + 4 > box.end) return false;
    const version = bytes[box.offset + hSize];
    const base = box.offset + hSize + 4; // skip version(1) + flags(3)

    // Both mvhd and mdhd have identical layout for creation/modification/timescale/duration:
    // v0: creation(4) + modification(4) + timescale(4) + duration(4)
    // v1: creation(8) + modification(8) + timescale(4) + duration(8)
    let tsOffset;
    let durOffset;
    if (version === 0) {
        tsOffset = base + 8;
        durOffset = tsOffset + 4;
        if (durOffset + 4 > box.end) return false;
        const oldTs = view.getUint32(tsOffset, false);
        const oldDur = view.getUint32(durOffset, false);
        const newTs = Math.max(1, Math.floor(oldTs / isMvhd.divider));
        const newDur = Math.floor(oldDur / isMvhd.divider);
        view.setUint32(tsOffset, newTs, false);
        view.setUint32(durOffset, newDur, false);
        return true;
    } else if (version === 1) {
        tsOffset = base + 16;
        durOffset = tsOffset + 4;
        if (durOffset + 8 > box.end) return false;
        const oldTs = view.getUint32(tsOffset, false);
        const oldDur = view.getBigUint64(durOffset, false);
        const newTs = Math.max(1, Math.floor(oldTs / isMvhd.divider));
        const newDur = oldDur / BigInt(isMvhd.divider);
        view.setUint32(tsOffset, newTs, false);
        view.setBigUint64(durOffset, newDur, false);
        return true;
    }
    return false;
}

/**
 * Patches `mvhd` and all `mdhd` boxes in `moov` by dividing timescale and
 * duration by `divider` (2 for 60fps -> 30fps header, 4 for 120fps -> 30fps header).
 * In-place operation: does not change box sizes or chunk offsets.
 */
export function patchFpsHeaders(bytes, view, divider = 2) {
    if (!Number.isInteger(divider) || divider < 2) {
        return { mvhdPatched: 0, mdhdPatched: 0 };
    }

    const topBoxes = parseBoxes(bytes, view, 0, bytes.length);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    if (!moovBox) throw new Error("Moov box not found");

    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    let mvhdPatched = 0;
    let mdhdPatched = 0;
    const ctx = { divider };

    for (const box of moovChildren) {
        if (box.type === "mvhd") {
            if (divideTimescaleAndDuration(bytes, view, box, ctx)) {
                mvhdPatched++;
            }
        } else if (box.type === "trak") {
            const trakChildren = parseBoxes(
                bytes,
                view,
                box.offset + getBoxHeaderSize(box),
                box.end,
            );
            const mdiaBox = trakChildren.find((b) => b.type === "mdia");
            if (!mdiaBox) continue;
            const mdiaChildren = parseBoxes(
                bytes,
                view,
                mdiaBox.offset + getBoxHeaderSize(mdiaBox),
                mdiaBox.end,
            );
            const mdhdBox = mdiaChildren.find((b) => b.type === "mdhd");
            if (mdhdBox && divideTimescaleAndDuration(bytes, view, mdhdBox, ctx)) {
                mdhdPatched++;
            }
        }
    }

    return { mvhdPatched, mdhdPatched };
}

function makeBox(typeBytes, payload) {
    const out = new Uint8Array(8 + payload.length);
    const v = new DataView(out.buffer);
    v.setUint32(0, out.length, false);
    out.set(typeBytes, 4);
    out.set(payload, 8);
    return out;
}

function makeFullBox(typeBytes, version, flags, payload) {
    const inner = new Uint8Array(4 + payload.length);
    const v = new DataView(inner.buffer);
    v.setUint32(0, ((version & 0xff) << 24) | (flags & 0x00ffffff), false);
    inner.set(payload, 4);
    return makeBox(typeBytes, inner);
}

function concatUint8Arrays(arrays) {
    let total = 0;
    for (const a of arrays) total += a.length;
    const out = new Uint8Array(total);
    let pos = 0;
    for (const a of arrays) {
        out.set(a, pos);
        pos += a.length;
    }
    return out;
}

function buildIlstEntry(tagBytes, text) {
    const utf8 = new TextEncoder().encode(text);
    const dataPayload = new Uint8Array(8 + utf8.length);
    const dv = new DataView(dataPayload.buffer);
    dv.setUint32(0, 1, false); // UTF-8 type indicator
    dv.setUint32(4, 0, false);
    dataPayload.set(utf8, 8);
    const dataBox = makeBox(new Uint8Array([0x64, 0x61, 0x74, 0x61]), dataPayload); // "data"
    return makeBox(tagBytes, dataBox);
}

function buildUdtaBox(comment, encoder) {
    const entries = [];
    if (encoder) {
        // \xa9too
        entries.push(buildIlstEntry(new Uint8Array([0xa9, 0x74, 0x6f, 0x6f]), encoder));
    }
    if (comment) {
        // \xa9cmt
        entries.push(buildIlstEntry(new Uint8Array([0xa9, 0x63, 0x6d, 0x74]), comment));
    }
    if (entries.length === 0) return null;

    const hdlrPayload = new Uint8Array(25);
    // component_subtype = "mdir" at offset 4..8, manufacturer = "appl" at 8..12
    hdlrPayload.set([0x6d, 0x64, 0x69, 0x72], 4);
    hdlrPayload.set([0x61, 0x70, 0x70, 0x6c], 8);
    const hdlrBox = makeFullBox(new Uint8Array([0x68, 0x64, 0x6c, 0x72]), 0, 0, hdlrPayload);
    const ilstBox = makeBox(new Uint8Array([0x69, 0x6c, 0x73, 0x74]), concatUint8Arrays(entries));
    const metaBox = makeFullBox(
        new Uint8Array([0x6d, 0x65, 0x74, 0x61]),
        0,
        0,
        concatUint8Arrays([hdlrBox, ilstBox]),
    );
    return makeBox(new Uint8Array([0x75, 0x64, 0x74, 0x61]), metaBox);
}

/**
 * Replaces or appends a clean `udta` box inside `moov` with `©too` and `©cmt`.
 * Adjusts `moov` size and shifts `stco`/`co64` offsets if `moov` precedes `mdat`.
 */
export function applyUdtaMetadata(inputBytes, inputView, { comment, encoder }) {
    const newUdta = buildUdtaBox(comment, encoder);
    if (!newUdta) {
        return { newBuffer: inputBytes.buffer, newBytes: inputBytes, newView: inputView };
    }

    const fileSize = inputBytes.length;
    const topBoxes = parseBoxes(inputBytes, inputView, 0, fileSize);
    const moovBox = topBoxes.find((b) => b.type === "moov");
    const mdatBox = topBoxes.find((b) => b.type === "mdat");
    if (!moovBox) throw new Error("Moov box not found");

    const moovChildren = parseBoxes(
        inputBytes,
        inputView,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );
    const existingUdta = moovChildren.find((b) => b.type === "udta");

    const oldUdtaSize = existingUdta ? existingUdta.size : 0;
    const delta = newUdta.length - oldUdtaSize;
    const newSize = fileSize + delta;

    const newBuffer = new ArrayBuffer(newSize);
    const newBytes = new Uint8Array(newBuffer);
    const newView = new DataView(newBuffer);

    if (existingUdta) {
        newBytes.set(inputBytes.subarray(0, existingUdta.offset), 0);
        newBytes.set(newUdta, existingUdta.offset);
        newBytes.set(
            inputBytes.subarray(existingUdta.end, fileSize),
            existingUdta.offset + newUdta.length,
        );
    } else {
        newBytes.set(inputBytes.subarray(0, moovBox.end), 0);
        newBytes.set(newUdta, moovBox.end);
        newBytes.set(inputBytes.subarray(moovBox.end, fileSize), moovBox.end + newUdta.length);
    }

    updateBoxSize(newView, moovBox.offset, moovBox, delta);

    const moovBeforeMdat = Boolean(mdatBox && moovBox.offset < mdatBox.offset);
    if (moovBeforeMdat && delta !== 0) {
        updateChunkOffsets(
            newBytes,
            newView,
            moovBox.offset + getBoxHeaderSize(moovBox),
            moovBox.end + delta,
            delta,
        );
    }

    return { newBuffer, newBytes, newView };
}
