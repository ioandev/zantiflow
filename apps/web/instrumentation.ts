// Next.js runs register() exactly once when the server process boots. We use it to print this web
// image's build identity to the console on startup — mirroring the backend/bot version logs — so
// `docker logs <web>` shows precisely which version is running. Guarded to the Node runtime (the Edge
// runtime has no startup log we care about here).
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { APP_VERSION, GIT_SHA } = await import('./lib/version')
    console.log(`[zantiflow web] starting — version=${APP_VERSION} commit=${GIT_SHA} node=${process.version}`)
  }
}
