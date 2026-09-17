-- Metafield backup: Shop, Product, Collection, Page, Blog and Article metafield
-- values plus their definitions, captured as one self-describing document per
-- restore point (schema `revertly-metafields-v1`).
--
-- `metafieldCount` counts metafield VALUES, not definitions, so it stays
-- parallel to the other per-resource counters (productCount, menuCount, …).
-- The definition count lives inside the JSON document, because definitions are
-- store-wide configuration rather than a per-owner resource and would make the
-- headline number on the restore-point card misleading.
--
-- Both columns are nullable/defaulted so existing restore points keep working
-- untouched: an older snapshot simply reports 0 metafields.
ALTER TABLE `RestorePoint`
  ADD COLUMN `metafieldCount` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `metafieldData` JSON NULL;
