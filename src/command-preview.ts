/** Optional display metadata only: no evaluation, shell parsing or recursive decoding. */
export interface CommandPreview { decodedInput: string; decodedEncoding: 'utf-8' | 'utf-16le'; decodedScope: 'wrapper-body' }
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
    return { decodedInput, decodedEncoding: encoding, decodedScope: 'wrapper-body' };
  } catch { return null; }
}
/** Legacy read-time compatibility; leaves stored records and their dedupe hashes untouched. */
export function withCommandPreview(record: unknown): unknown {
  if (!record || typeof record !== 'object') return record;
  const value = record as Record<string, unknown>;
  if (value.decodedInput !== undefined || typeof value.input !== 'string' || value.input === '[sensitive input]') return record;
  const preview = decodeCommandPreview(value.input);
  return preview ? { ...value, ...preview } : record;
}
