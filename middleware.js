export default function middleware(req) {
  const url = new URL(req.url);

  // Only intercept the root path
  if (url.pathname !== '/') return;

  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  const cliAgents = ['curl/', 'wget/', 'httpie/', 'go-http-client', 'python-requests', 'powershell', 'libwww-perl', 'python-urllib'];
  const accept = req.headers.get('accept') || '';
  const isCLI = cliAgents.some(agent => ua.includes(agent)) ||
    !accept.includes('text/html');

  if (isCLI) {
    const clientIP = req.headers.get('cf-connecting-ip') ||
      (req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    url.pathname = '/api/lookup';
    if (clientIP) url.searchParams.set('ip', clientIP);

    // Internal rewrite via Vercel's native middleware header. The previous
    // `fetch(url.toString())` made a second outbound HTTP round-trip back into
    // this same deployment, double-counting every CLI hit as an extra edge
    // request + function invocation. This rewrites in place with no extra call.
    return new Response(null, {
      headers: { 'x-middleware-rewrite': url.toString() },
    });
  }
}

export const config = {
  matcher: '/',
};
