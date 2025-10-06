export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers }
  });
}

export function scheduleBackground(ctx, promise, label) {
  const prefix = `[Mixology] ${label}`;
  const handleError = (err) => {
    console.error(`${prefix} failed`, err);
  };
  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise.catch(handleError));
  } else {
    promise.catch(handleError);
  }
}
