import { createHash } from 'node:crypto';

export type StoredRecord = {
  epoch: number;
  inputsHash: string;
  derivedHash: string; // sha256 of the derived lockfile, hex
  toolVersion: string;
  pnpmVersion: string;
  timestamp: string; // ISO-8601
};

/** SHA-256 of a buffer, hex. Used to hash the committed and derived lockfiles. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}
