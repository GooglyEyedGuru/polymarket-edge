/**
 * Local HTTP control server — lets start.bat/stop.bat and Telegram
 * commands manage the bot without needing to kill the process directly.
 *
 * Endpoints:
 *   GET  /status   → { status, uptime, positions }
 *   POST /shutdown → graceful shutdown (closes short-dated positions first)
 */
import http from 'http';

type ShutdownCallback = () => Promise<void> | void;

let _server: http.Server | null = null;

export function startControlServer(onShutdown: ShutdownCallback): void {
  _server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'running', uptime: Math.floor(process.uptime()) }));

    } else if (req.method === 'POST' && req.url === '/shutdown') {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: 'Shutting down...' }));
      console.log('\n🌙 Shutdown requested via control server');
      await onShutdown();
      process.exit(0);

    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });

  _server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.warn('⚠️  Control server port 3001 already in use — skipping (bot will run without it)');
      _server = null;
    } else {
      console.error('⚠️  Control server error:', err.message);
    }
  });

  _server.listen(3001, '127.0.0.1', () => {
    console.log('🎮 Control server: http://localhost:3001');
  });
}
