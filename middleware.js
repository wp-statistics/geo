export default function middleware(req) {
  const url = new URL(req.url);

  // Only intercept the root path
  if (url.pathname !== '/') return;

  const ua = (req.headers.get('user-agent') || '').toLowerCase();
  const cliAgents = ['curl/', 'wget/', 'httpie/', 'go-http-client', 'python-requests', 'powershell', 'libwww-perl', 'python-urllib'];
  const isCLI = cliAgents.some(agent => ua.includes(agent));

  if (isCLI) {
    url.pathname = '/api/lookup';
    return fetch(url.toString(), { headers: req.headers });
  }
}

export const config = {
  matcher: '/',
};
