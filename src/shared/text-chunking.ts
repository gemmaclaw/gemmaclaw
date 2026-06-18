export function avoidTrailingHighSurrogateBreak(text: string, start: number, end: number): number {
  if (end <= start || end >= text.length) {
    return end;
  }
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
  if (!splitsSurrogatePair) {
    return end;
  }
  const adjusted = end - 1;
  return adjusted > start ? adjusted : end + 1;
}

export function chunkTextByBreakResolver(
  text: string,
  limit: number,
  resolveBreakIndex: (window: string) => number,
): string[] {
  if (!text) {
    return [];
  }
  if (limit <= 0 || text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit);
    const candidateBreak = resolveBreakIndex(window);
    const rawBreakIdx =
      Number.isFinite(candidateBreak) && candidateBreak > 0 && candidateBreak <= limit
        ? candidateBreak
        : limit;
    // Clamp to a surrogate-safe boundary so we never emit a lone surrogate.
    const breakIdx = avoidTrailingHighSurrogateBreak(remaining, 0, rawBreakIdx);
    const rawChunk = remaining.slice(0, breakIdx);
    const chunk = rawChunk.trimEnd();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }
    const brokeOnSeparator = breakIdx < remaining.length && /\s/.test(remaining[breakIdx]);
    const nextStart = Math.min(remaining.length, breakIdx + (brokeOnSeparator ? 1 : 0));
    remaining = remaining.slice(nextStart).trimStart();
  }
  if (remaining.length) {
    chunks.push(remaining);
  }
  return chunks;
}
