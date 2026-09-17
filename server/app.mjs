import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.join(__dirname, '..', 'web');
const indexHtmlPath = path.join(webRoot, 'index.html');

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '256kb' }));

async function invoke(req, capability, input) {
  const gatewayUrl = process.env.KNOWI_GATEWAY_URL;
  const token = req.header('X-Knowi-Capability-Token');
  const res = await fetch(`${gatewayUrl}/v1/capabilities`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Knowi-Capability-Token': token || '',
    },
    body: JSON.stringify({ capability, input }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && body.error) || `Capability ${capability} failed (${res.status})`;
    throw new Error(message);
  }
  return body;
}

app.get('/api/keywords', async (req, res) => {
  try {
    const result = await invoke(req, 'data.query', {
      binding: 'new-gsc',
      limit: 20000,
      fields: ['clicks', 'ctr', 'date', 'impressions', 'page', 'position', 'query', '_stream_time'],
      sort: [{ field: 'date', direction: 'desc' }],
    });
    res.json({ rows: result.rows || [], truncated: !!result.truncated });
  } catch (err) {
    res.status(502).json({ error: 'Could not load keyword data from Search Console.' });
  }
});

app.get('/api/dashboard', (req, res) => {
  res.status(501).json({ error: 'A Search Console dashboard is not configured for this app yet.' });
});

app.use(express.static(webRoot));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(indexHtmlPath);
});

const port = Number(process.env.PORT);
app.listen(port, '0.0.0.0', () => {
  console.log(`GSC service listening on ${port}`);
});
