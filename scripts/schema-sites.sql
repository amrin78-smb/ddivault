-- DDIVault — Sites integration migration
-- Run: psql -U ddivault_user -d ddivault -f schema-sites.sql

-- Add site_id to ddi_servers (references NetVault sites table via cross-DB read)
-- We store just the ID — name is always fetched live from NetVault
ALTER TABLE ddi_servers
  ADD COLUMN IF NOT EXISTS site_id INT;

-- Add site_id to ipam_supernets
ALTER TABLE ipam_supernets
  ADD COLUMN IF NOT EXISTS site_id INT;

-- ipam_subnets already has site TEXT — add site_id alongside it
ALTER TABLE ipam_subnets
  ADD COLUMN IF NOT EXISTS site_id INT;

COMMENT ON COLUMN ddi_servers.site_id    IS 'References sites.id in netvault database';
COMMENT ON COLUMN ipam_supernets.site_id IS 'References sites.id in netvault database';
COMMENT ON COLUMN ipam_subnets.site_id   IS 'References sites.id in netvault database';
