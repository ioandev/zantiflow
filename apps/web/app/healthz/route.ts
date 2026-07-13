// Liveness probe for the web tier (the compose healthcheck hits /healthz on :3000).
export const dynamic = 'force-static'

export function GET() {
  return Response.json({ status: 'ok' })
}
