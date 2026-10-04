/**
 * Vercel entrypoint. vercel.json rewrites every path here.
 *
 * These are Web-standard handlers (Request -> Response), exported per HTTP
 * method. A `export default handle(app)` looks like it should work but does
 * not: Vercel's Node runtime treats a default export as `(req, res) => void`,
 * hands Hono a Node IncomingMessage whose headers have no `.get()`, and then
 * hangs until the function times out because nothing ever writes to `res`.
 */
import { app } from '../src/app.js';
import { assertProductionSafety } from '../src/config.js';

assertProductionSafety();

const handler = (request: Request): Response | Promise<Response> => app.fetch(request);

export {
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
  handler as OPTIONS,
  handler as HEAD,
};
