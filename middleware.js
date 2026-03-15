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
    return fetch(url.toString(), { headers: req.headers });
  }
}

export const config = {
  matcher: '/',
};
