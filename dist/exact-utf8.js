const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Decode only byte sequences whose decoded text reproduces the exact input bytes. */
export function exactUtf8(bytes, label) {
    let text;
    try {
        text = decoder.decode(bytes);
    }
    catch {
        throw new Error(`${label} is not valid UTF-8`);
    }
    const encoded = new TextEncoder().encode(text);
    if (encoded.byteLength !== bytes.byteLength || !encoded.every((byte, index) => byte === bytes[index])) {
        throw new Error(`${label} does not round-trip as exact UTF-8`);
    }
    return text;
}
