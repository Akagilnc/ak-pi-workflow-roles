const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
/** Decode only byte sequences whose decoded text reproduces the exact input bytes. */
export function exactUtf8(bytes, label) {
    let text;
    try {
        text = decoder.decode(bytes);
    }
    catch (error) {
        throw new Error(`${label} is not valid UTF-8`, { cause: error });
    }
    return text;
}
