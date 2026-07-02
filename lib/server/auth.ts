// Optional shared-token auth for the API. When AGENT_TOKEN is unset the API
// is open (local/trusted-network mode); when set, EVERY /api endpoint requires
// `Authorization: Bearer <token>`.

import { timingSafeEqual } from "node:crypto";

export function authorized(req: Request): boolean {
  const token = process.env.AGENT_TOKEN;
  if (!token) return true;
  const header = req.headers.get("authorization") ?? "";
  const expected = Buffer.from(`Bearer ${token}`);
  const actual = Buffer.from(header);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
