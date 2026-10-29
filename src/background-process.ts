import childProcess, {
  type ChildProcess,
  type ExecFileException,
  type ExecFileOptionsWithStringEncoding,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
} from 'node:child_process';

type Callback = (error: ExecFileException | null, stdout: string, stderr: string) => void;

/** Non-interactive helpers only. PTY/ConPTY creation must keep its own launch path. */
export function execFile(file: string, args: readonly string[], callback: Callback): ChildProcess;
export function execFile(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding, callback: Callback): ChildProcess;
export function execFile(file: string, args: readonly string[], options: ExecFileOptionsWithStringEncoding | Callback, callback?: Callback): ChildProcess {
  const settings = typeof options === 'function' ? {} : options;
  const done = typeof options === 'function' ? options : callback;
  return childProcess.execFile(file, args, { ...settings, windowsHide: true }, done);
}

export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function execFileSync(file: string, args: readonly string[], options?: ExecFileSyncOptions): string | Buffer;
export function execFileSync(file: string, args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return childProcess.execFileSync(file, args, { ...options, windowsHide: true });
}
