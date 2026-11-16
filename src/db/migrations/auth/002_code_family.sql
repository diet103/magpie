-- auth.db v2: remember which token family a code produced, so a replayed code revokes those tokens (RFC 6749 4.1.2).
ALTER TABLE auth_codes ADD COLUMN family_id TEXT;
