/** Optional display metadata only: no evaluation or shell execution. Nested previews are bounded UTF-8 text only. */
export interface CommandPreview { decodedInput: string; decodedEncoding: 'utf-8' | 'utf-16le'; decodedScope: 'wrapper-body'; decodedParts?: DecodedPart[] }
export interface DecodedPart { expression: string; text?: string; status: 'decoded' | 'skipped'; reason?: string }
/** Decode explicit literals only, at most 8 fragments and 16 KiB total, one nested layer. */
function nestedParts(source: string): DecodedPart[] {
  const parts: DecodedPart[] = [];
  let budget = 16384;
  const pattern = /(?:\[Convert\]::FromBase64String\(\s*(['"])([A-Za-z0-9+/=]*)\1\s*\)|Buffer\.from\(\s*(['"])([A-Za-z0-9+/=]*)\3\s*,\s*['"]base64['"]\s*\))/gi;
  for (const match of source.matchAll(pattern)) {
    if (parts.length === 8) { parts.push({expression: '', status: 'skipped', reason: 'Fragment limit reached'}); break; }
    const expression = match[0];
    const payload = match[2] ?? match[4];
    try {
      if (!payload || payload.length % 4 || payload.length > 22000) throw Error('Invalid or oversized Base64');
      const bytes = Buffer.from(payload, 'base64');
      if (bytes.toString('base64') !== payload) throw Error('Invalid Base64');
      if (bytes.length > budget) throw Error('Preview size limit reached');
      const text = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) throw Error('Binary or unsupported text encoding');
      budget -= bytes.length;
      parts.push({expression, status: 'decoded', text});
    } catch (error) { parts.push({expression, status: 'skipped', reason: (error as Error).message}); }
  }
  return parts;
}
export function decodeCommandPreview(input: unknown, sensitive = false): CommandPreview | null {
  try {
    if (sensitive || typeof input !== 'string' || input.length > 65536) return null;
    const source = input.trim();
    let payload: string | undefined;
    let encoding: 'utf-8' | 'utf-16le' = 'utf-8';
    // Restrict to complete wrappers so a decoded fragment cannot hide other commands.
    const powershell = /^(?:powershell|pwsh)(?:\.exe)?\s+(?:(?:-NoProfile|-NonInteractive|-NoLogo)\s+)*-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})$/i.exec(source);
    const node = /^node(?:\.exe)?\s+-e\s+"eval\(Buffer\.from\('([A-Za-z0-9+/]+={0,2})','base64'\)\.toString\(\)\)"$/.exec(source);
    const scriptblock = /^&\s*\(\[scriptblock\]::Create\(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('([A-Za-z0-9+/]+={0,2})'\)\)\)\)$/i.exec(source);
    if (powershell) { payload = powershell[1]; encoding = 'utf-16le'; }
    else payload = node?.[1] ?? scriptblock?.[1];
    if (!payload || payload.length % 4 !== 0) return null;
    const bytes = Buffer.from(payload, 'base64');
    if (bytes.toString('base64') !== payload || bytes.length > 16384 || (encoding === 'utf-16le' && bytes.length % 2)) return null;
    const decodedInput = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (!decodedInput || decodedInput.length > 8192 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(decodedInput)) return null;
    const decodedParts = nestedParts(decodedInput);
    return { decodedInput, decodedEncoding: encoding, decodedScope: 'wrapper-body', ...(decodedParts.length ? {decodedParts} : {}) };
  } catch { return null; }
}
/** Legacy read-time compatibility; leaves stored records and their dedupe hashes untouched. */
export function withCommandPreview(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const value = record as Record<string, unknown>;
  if (typeof value.input !== 'string' || value.input === '[sensitive input]') return record;
  if (typeof value.decodedInput === 'string') {
    if (value.decodedParts !== undefined || value.decodedInput.length > 8192) return record;
    const decodedParts = nestedParts(value.decodedInput);
    return decodedParts.length ? {...value, decodedParts} : record;
  }
  const preview = decodeCommandPreview(value.input);
  return preview ? { ...value, ...preview } : record;
}
