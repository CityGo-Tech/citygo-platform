# CityGo Admin

Executable React workspace package, mounted at /admin by apps/web so it shares
the same origin and HttpOnly login. Explicit server-side ADMIN_USER_IDS allowlist
protects the API; hiding the page is not the access control.

Current scope: aggregate user/quest/XP counts and human-handoff requests.
Quest/prompt editing, human chat assignment and content moderation are not yet
implemented. This read-only surface cannot change XP or user records.
