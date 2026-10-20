CREATE TABLE IF NOT EXISTS keychain (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  encrypted_payload TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS keychain_account_updated ON keychain(account_id, updated_at DESC);
