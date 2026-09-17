-- Persist pre-cleanup page markdown and per-page cleanup state, so an optional
-- LLM cleanup pass can be re-run with a different prompt or model without
-- re-scraping the documentation site.
--
-- Nothing here costs anything until cleanup is enabled: raw_content is only
-- written when config.cleanup.enabled is true, so every existing row and every
-- deployment that leaves the feature off keeps these columns NULL.

-- @migration-step add cleanup columns to pages
ALTER TABLE pages ADD COLUMN raw_content TEXT;
ALTER TABLE pages ADD COLUMN cleanup_status TEXT;
ALTER TABLE pages ADD COLUMN cleanup_fingerprint TEXT;
ALTER TABLE pages ADD COLUMN cleanup_at DATETIME;

-- @migration-step index pages needing cleanup
-- The sweep asks one question repeatedly: which pages of this version are
-- missing cleanup, or were cleaned by a prompt/model we no longer use. Once a
-- library is clean that answer is empty, so a partial-shaped index over
-- (version_id, status, fingerprint) keeps the sweep cheap.
CREATE INDEX IF NOT EXISTS idx_pages_cleanup_status
  ON pages(version_id, cleanup_status, cleanup_fingerprint);
