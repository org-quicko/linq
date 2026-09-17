-- `manager` is what the rung has always done: manage any link, not only its own.
--
-- RENAME VALUE rewrites no rows and keeps the value's sort position, so the
-- ladder order in packages/shared/src/roles.ts is still the enum's own order.
-- The generated drop-and-recreate is wrong here: it casts through text and
-- every existing 'editor' row fails against a type that no longer has the value.
ALTER TYPE "public"."role" RENAME VALUE 'editor' TO 'manager';
