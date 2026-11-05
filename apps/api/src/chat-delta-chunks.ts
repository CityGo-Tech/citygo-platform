// Keep downstream v1 SSE frames below the 256 KiB client decoder limit even
// when a provider returns a complete answer as one delta. Preserve UTF-16 text.
export function* chatDeltaChunks(text: string): Generator<string> {
  const maximumUnits = 16 * 1024;
  for (let start = 0; start < text.length;) {
    let end = Math.min(start + maximumUnits, text.length);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    )
      end--;
    yield text.slice(start, end);
    start = end;
  }
}
