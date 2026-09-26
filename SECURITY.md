# Security

- Lantern listens on 127.0.0.1 only. It checks the Host and Origin of every request, and anything that changes something needs a per-start token that only the same Windows user can read.
- Only the hub's **public** key belongs in the app. Lantern refuses a secret or service-role key.
- The hub's rules (Row Level Security) let people read only their own rows. Every write goes through checked functions.

If you find a security problem, please open a private security advisory on GitHub rather than a public issue.
