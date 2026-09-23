-- Links have no expiry sweeper, by design: read-time comparison in
-- redirect.ts is the enforcement, mirroring how apiKeys.expiresAt already
-- works.
ALTER TABLE "links" ADD COLUMN "expires_at" timestamp with time zone;