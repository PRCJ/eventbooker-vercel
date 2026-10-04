/** Vercel entrypoint. vercel.json rewrites every path here. */
import { handle } from 'hono/vercel';
import { app } from '../src/app.js';
import { assertProductionSafety } from '../src/config.js';

assertProductionSafety();

export const config = { runtime: 'nodejs' };

export default handle(app);
