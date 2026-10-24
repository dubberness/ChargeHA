// Lightweight healthcheck script for Docker HEALTHCHECK. /health needs no
// session, so this keeps working when login is on.
const res = await fetch("http://localhost:8000/health");
Deno.exit(res.ok ? 0 : 1);
