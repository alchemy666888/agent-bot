export interface PersistenceStore {
  listFiles(prefixes: string[]): Promise<{ relativePath: string }[]>;
  download(relativePath: string): Promise<Buffer>;
  upload(relativePath: string, body: Buffer): Promise<void>;
  delete(relativePath: string): Promise<void>;
}
