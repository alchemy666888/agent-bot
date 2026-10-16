export interface PersistenceStore {
  listFiles(prefixes: string[]): Promise<{ relativePath: string }[]>;
  download(relativePath: string): Promise<Buffer>;
  upload(relativePath: string, body: Buffer): Promise<void>;
  /** Inserts the record only when the path is free. False means another writer owns it. */
  claim(relativePath: string, body: Buffer): Promise<boolean>;
  delete(relativePath: string): Promise<void>;
}
