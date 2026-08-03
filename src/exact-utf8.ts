const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode only byte sequences whose decoded text reproduces the exact input bytes. */
export function exactUtf8(bytes: Uint8Array, label: string): string {
  let text: string;
  try { text = decoder.decode(bytes); }
  catch (error) { throw new Error(`${label} is not valid UTF-8`, { cause: error }); }
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength !== bytes.byteLength || !encoded.every((byte, index) => byte === bytes[index])) {
    throw new Error(`${label} does not round-trip as exact UTF-8`, { cause: { name: "ExactUtf8RoundTripFailure", label, byteLength: bytes.byteLength } });
  }
  return text;
}
