/**
 * ISO-BMFF (MP4 / MOV) low-level box parser and inspection helpers.
 * Pure client-side ArrayBuffer/DataView implementation.
 */

export function parseBoxes(bytes, view, startOffset, endOffset) {
    const boxes = [];
    let offset = startOffset;
    while (offset + 8 <= endOffset) {
        const rawSize = view.getUint32(offset, false);
        let size;
        let is64Bit = false;

        if (rawSize === 0) {
            size = endOffset - offset;
        } else if (rawSize === 1) {
            is64Bit = true;
            if (offset + 16 > endOffset) break;
            const hi = view.getUint32(offset + 8, false);
            const lo = view.getUint32(offset + 12, false);
            const sizeBig = (BigInt(hi) << 32n) + BigInt(lo);
            if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) break;
            size = Number(sizeBig);
        } else {
            size = rawSize;
        }

        if (size < 8 || offset + size > endOffset) break;

        const type = String.fromCharCode(
            bytes[offset + 4],
            bytes[offset + 5],
            bytes[offset + 6],
            bytes[offset + 7],
        );
        boxes.push({ offset, size, type, end: offset + size, is64Bit });
        offset += size;
    }
    return boxes;
}

export function getBoxHeaderSize(box) {
    return box.is64Bit ? 16 : 8;
}

const HANDLER_VIDEO = [0x76, 0x69, 0x64, 0x65]; // "vide"

function bytesEqualAt(bytes, offset, pattern) {
    for (let i = 0; i < pattern.length; i++) {
        if (bytes[offset + i] !== pattern[i]) return false;
    }
    return true;
}

export function findHandlerType(bytes, hdlrBox) {
    const start = hdlrBox.offset + getBoxHeaderSize(hdlrBox);
    const end = hdlrBox.end;
    for (let i = start; i + 4 <= end; i++) {
        if (bytesEqualAt(bytes, i, HANDLER_VIDEO)) return "vide";
    }
    return null;
}

export function detectCodecFromStbl(bytes, stblBox) {
    const children = parseBoxes(
        bytes,
        new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        stblBox.offset + getBoxHeaderSize(stblBox),
        stblBox.end,
    );
    const stsdBox = children.find((b) => b.type === "stsd");
    if (!stsdBox) return "unknown";
    const contentStart = stsdBox.offset + getBoxHeaderSize(stsdBox);
    if (contentStart + 16 > stsdBox.end) return "unknown";
    return String.fromCharCode(
        bytes[contentStart + 12],
        bytes[contentStart + 13],
        bytes[contentStart + 14],
        bytes[contentStart + 15],
    );
}

export function detectVideoCodecFromMoov(bytes, view, moovBox) {
    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");
        if (!mdiaBox) continue;

        const mdiaChildren = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const hdlrBox = mdiaChildren.find((b) => b.type === "hdlr");
        if (hdlrBox && findHandlerType(bytes, hdlrBox) !== "vide") continue;

        const minfBox = mdiaChildren.find((b) => b.type === "minf");
        if (!minfBox) continue;

        const minfChildren = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfChildren.find((b) => b.type === "stbl");
        if (!stblBox) continue;

        return detectCodecFromStbl(bytes, stblBox);
    }

    return "unknown";
}

export function inspectMp4Metadata(bytes, view) {
    const topBoxes = parseBoxes(bytes, view, 0, bytes.length);
    const ftypBox = topBoxes.find((b) => b.type === "ftyp");
    const moovBox = topBoxes.find((b) => b.type === "moov");
    const mdatBox = topBoxes.find((b) => b.type === "mdat");

    const info = {
        valid: Boolean(moovBox && mdatBox),
        moovBeforeMdat: Boolean(moovBox && mdatBox && moovBox.offset < mdatBox.offset),
        majorBrand: null,
        codec: "unknown",
        width: null,
        height: null,
        fps: null,
        durationSec: null,
        sampleCount: 0,
        hasCo64: false,
    };

    if (ftypBox && ftypBox.size >= 12) {
        const off = ftypBox.offset + getBoxHeaderSize(ftypBox);
        info.majorBrand = String.fromCharCode(
            bytes[off],
            bytes[off + 1],
            bytes[off + 2],
            bytes[off + 3],
        );
    }

    if (!moovBox) return info;

    const moovChildren = parseBoxes(
        bytes,
        view,
        moovBox.offset + getBoxHeaderSize(moovBox),
        moovBox.end,
    );

    for (const trak of moovChildren.filter((b) => b.type === "trak")) {
        const trakChildren = parseBoxes(
            bytes,
            view,
            trak.offset + getBoxHeaderSize(trak),
            trak.end,
        );
        const tkhdBox = trakChildren.find((b) => b.type === "tkhd");
        const mdiaBox = trakChildren.find((b) => b.type === "mdia");
        if (!mdiaBox) continue;

        const mdiaChildren = parseBoxes(
            bytes,
            view,
            mdiaBox.offset + getBoxHeaderSize(mdiaBox),
            mdiaBox.end,
        );
        const hdlrBox = mdiaChildren.find((b) => b.type === "hdlr");
        if (!hdlrBox || findHandlerType(bytes, hdlrBox) !== "vide") continue;

        // Dimensions from tkhd
        if (tkhdBox) {
            const hSize = getBoxHeaderSize(tkhdBox);
            const version = bytes[tkhdBox.offset + hSize];
            const wOffset = tkhdBox.offset + hSize + (version === 1 ? 88 : 76);
            if (wOffset + 8 <= tkhdBox.end) {
                info.width = view.getUint32(wOffset, false) >>> 16;
                info.height = view.getUint32(wOffset + 4, false) >>> 16;
            }
        }

        // Timescale & duration from mdhd
        let timescale = 0;
        let duration = 0;
        const mdhdBox = mdiaChildren.find((b) => b.type === "mdhd");
        if (mdhdBox) {
            const hSize = getBoxHeaderSize(mdhdBox);
            const version = bytes[mdhdBox.offset + hSize];
            const base = mdhdBox.offset + hSize + 4;
            if (version === 0 && base + 16 <= mdhdBox.end) {
                timescale = view.getUint32(base + 8, false);
                duration = view.getUint32(base + 12, false);
            } else if (version === 1 && base + 28 <= mdhdBox.end) {
                timescale = view.getUint32(base + 16, false);
                duration = Number(view.getBigUint64(base + 20, false));
            }
            if (timescale > 0) {
                info.durationSec = duration / timescale;
            }
        }

        const minfBox = mdiaChildren.find((b) => b.type === "minf");
        if (!minfBox) break;
        const minfChildren = parseBoxes(
            bytes,
            view,
            minfBox.offset + getBoxHeaderSize(minfBox),
            minfBox.end,
        );
        const stblBox = minfChildren.find((b) => b.type === "stbl");
        if (!stblBox) break;

        info.codec = detectCodecFromStbl(bytes, stblBox);

        const stblChildren = parseBoxes(
            bytes,
            view,
            stblBox.offset + getBoxHeaderSize(stblBox),
            stblBox.end,
        );
        info.hasCo64 = stblChildren.some((b) => b.type === "co64");

        const sttsBox = stblChildren.find((b) => b.type === "stts");
        if (sttsBox && sttsBox.offset + 16 <= sttsBox.end) {
            const entryCount = view.getUint32(sttsBox.offset + 12, false);
            let sampleCount = 0;
            let totalTicks = 0;
            for (let i = 0; i < entryCount; i++) {
                const pos = sttsBox.offset + 16 + i * 8;
                if (pos + 8 > sttsBox.end) break;
                const count = view.getUint32(pos, false);
                const delta = view.getUint32(pos + 4, false);
                sampleCount += count;
                totalTicks += count * delta;
            }
            info.sampleCount = sampleCount;
            if (timescale > 0 && totalTicks > 0 && sampleCount > 0) {
                info.fps = (sampleCount * timescale) / totalTicks;
            }
        }
        break;
    }

    return info;
}

export function updateBoxSize(view, offset, box, addedBytes) {
    if (box.is64Bit) {
        view.setBigUint64(offset + 8, BigInt(box.size + addedBytes), false);
    } else {
        view.setUint32(offset, box.size + addedBytes, false);
    }
}

export function updateChunkOffsets(newBytes, newView, boxStart, boxEnd, delta) {
    const containerTypes = new Set(["moov", "trak", "mdia", "minf", "stbl"]);
    for (const box of parseBoxes(newBytes, newView, boxStart, boxEnd)) {
        if (box.type === "stco") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 4;
                newView.setUint32(
                    pos,
                    newView.getUint32(pos, false) + delta,
                    false,
                );
            }
        } else if (box.type === "co64") {
            const headerSize = getBoxHeaderSize(box);
            const count = newView.getUint32(box.offset + headerSize + 4, false);
            for (let i = 0; i < count; i++) {
                const pos = box.offset + headerSize + 8 + i * 8;
                newView.setBigUint64(
                    pos,
                    newView.getBigUint64(pos, false) + BigInt(delta),
                    false,
                );
            }
        } else if (containerTypes.has(box.type)) {
            updateChunkOffsets(
                newBytes,
                newView,
                box.offset + getBoxHeaderSize(box),
                box.end,
                delta,
            );
        }
    }
}
