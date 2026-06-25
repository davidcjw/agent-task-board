// Optional shared-token auth for the worker-facing endpoints (claim + result).
// When AGENT_TOKEN is unset the API is open (local/trusted-network mode);
// when set, those endpoints require `Authorization: Bearer <token>`.

export function authorized(req: Request): boolean {
  const token = process.env.AGENT_TOKEN;
  if (!token) return true;
  return req.headers.get("authorization") === `Bearer ${token}`;
}
