import type { IncomingMessage, ServerResponse } from 'node:http';
interface TransferRecord { id: string }
interface Cleanup { removed: boolean; retainedPath?: string; reason?: string }
export interface TransferReceipt {
  transferId: string;
  state: string;
  direction: 'push' | 'pull';
  verified: boolean;
  path?: string;
  bytes?: number;
  sha256?: string;
  archive?: boolean;
  tempPath?: string;
  cleanup?: Cleanup;
  error?: string;
}
export class AgentTransfers {
  get(id: string): TransferRecord;
  status(record: TransferRecord): TransferReceipt;
  prepare(spec: unknown): Promise<TransferReceipt>;
  upload(id: string, input: IncomingMessage): Promise<TransferReceipt>;
  download(id: string, response: ServerResponse): Promise<void>;
  cleanup(id: string): Promise<TransferReceipt>;
}
