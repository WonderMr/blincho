const aliases = new Set(['blincho.com', 'www.blincho.com', 'www.blincho.app']);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (aliases.has(url.hostname) || (url.hostname === 'blincho.app' && url.protocol !== 'https:')) {
      url.protocol = 'https:';
      url.hostname = 'blincho.app';
      url.port = '';
      return Response.redirect(url.href, 308);
    }
    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method not allowed', {status: 405, headers: {Allow: 'GET, HEAD'}});
    }
    const upstream = await env.ASSETS.fetch(request);
    const response = new Response(upstream.body, upstream);
    response.headers.set('X-Content-Type-Options', 'nosniff');
    response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    response.headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    response.headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'");
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
    response.headers.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return response;
  }
};
