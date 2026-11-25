export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (!url.pathname.startsWith("/api")) {
    return context.next();
  }
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  };
  if (context.request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }
  const res = await context.next();
  const headers = new Headers(res.headers);
  Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
  return new Response(res.body, { status: res.status, headers });
}
