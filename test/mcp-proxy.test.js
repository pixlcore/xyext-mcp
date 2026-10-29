// Isolated MCP proxy checks. No live xyOps database or credentials required.
// Run with: node --test test/mcp-proxy.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const Path = require('path');
const http = require('http');
const { once, EventEmitter } = require('events');
const { PassThrough } = require('stream');
const cp = require('child_process');
// Integration tests borrow the web server from a development xyOps checkout.
// No test dependencies are added to the extension's published package.
const { createRequire } = require('module');
const xyopsRoot = process.env.XYOPS_ROOT || Path.resolve(__dirname, '../../../xyops');
const xyopsRequire = createRequire(Path.join(xyopsRoot, 'package.json'));
const PixlServer = xyopsRequire('pixl-server');
const MCP = require('../index');
const Util = xyopsRequire('./lib/util');

async function unusedPort() {
	const server = http.createServer();
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const port = server.address().port;
	await new Promise(resolve => server.close(resolve));
	return port;
}

async function waitFor(check) {
	const until = Date.now() + 10000;
	while (!check()) {
		if (Date.now() > until) throw new Error('Timed out waiting for MCP startup');
		await new Promise(resolve => setTimeout(resolve, 25));
	}
}

// MCP may return either ordinary JSON or an SSE message stream.
async function readRPC(response) {
	const body = await response.text();
	if (!(response.headers.get('content-type') || '').includes('text/event-stream')) return JSON.parse(body);
	const messages = body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
	return messages.find(message => message.id === 1);
}

// Tests await child exit for cleanup; the extension's own hook never waits.
async function stop(app) {
	const closed = app.mcpChild ? once(app.mcpChild, 'close') : Promise.resolve();
	app.shutdown();
	await closed;
}

test('local MCP lifecycle isolates configuration and handles launch failures', async t => {
	const app = { ...MCP };
	const logs = [];
	const routes = [];
	Object.assign(app, {
		config: {},
		server: { config: { get: () => 'https://xyops.example.com', getPath: () => 12345 } },
		xy: {
			master: true,
			cleanEnv: () => ({ PATH: process.env.PATH, KEEP_ME: 'yes' }),
			web: {
				addURIHandler: (...args) => routes.push(args),
				removeURIHandler: name => assert.equal(name, '@pixlcore/xyext-mcp')
			}
		},
		logDebug: (...args) => logs.push(args)
	});
	let launch;
	const child = new EventEmitter();
	Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null });
	child.kill = signal => {
		assert.equal(signal, 'SIGTERM');
		child.signalCode = signal;
		child.emit('exit', null, signal);
		child.emit('close');
	};
	t.mock.method(cp, 'spawn', (bin, args, options) => { launch = { bin, args, options }; return child; });
	app.init();
	assert.equal(routes[0][0], '/mcp');
	assert.equal(routes[0][1], '@pixlcore/xyext-mcp');
	assert.equal(launch.bin, process.execPath);
	assert.deepEqual(launch.args, [require.resolve('@pixlcore/xycli'), 'mcp', 'serve', '--host', '127.0.0.1', '--port', String(app.mcpPort)]);
	assert.equal(launch.options.env.XYOPS_BASE_URL, 'http://127.0.0.1:12345');
	assert.equal(launch.options.env.XYOPS_API_KEY, '');
	assert.equal(app.mcpPort, 5524);
	assert.equal(launch.options.env.no_proxy, '127.0.0.1,localhost,::1');
	assert.equal(launch.options.env.KEEP_ME, 'yes');
	assert.equal(launch.options.detached, undefined);
	assert.deepEqual(launch.options.stdio, ['ignore', 'pipe', 'pipe']);
	assert.deepEqual(JSON.parse(launch.options.env.XYOPS_MCP).allowed_origins, ['https://xyops.example.com']);
	assert.equal(app.mcpReady, false);
	await app.startLocalMCP();
	assert.equal(cp.spawn.mock.callCount(), 1);
	child.stderr.write('xy mcp: Listening at http://127.0.0.1:');
	child.stderr.write(app.mcpPort + '/mcp\n');
	assert.equal(app.mcpReady, true);
	app.shut = true;
	await stop(app);
	assert.equal(app.mcpChild, null);
	assert.equal(app.mcpReady, false);
	app.shut = false;
	cp.spawn.mock.restore();
	t.mock.method(cp, 'spawn', () => { throw new Error('spawn failure'); });
	await app.startLocalMCP();
	assert.match(logs.pop()[1], /spawn failure/);
	for (const port of [0, -1, 65536, 12345, 'invalid']) {
		app.config.port = port;
		await app.startLocalMCP();
		assert.match(logs.pop()[1], /Invalid MCP port/);
	}
});

test('MCP proxy through the real pixl-server-web URI/body handler', async t => {
	const dir = fs.mkdtempSync(Path.join(os.tmpdir(), 'xyops-mcp-'));
	const port = await unusedPort();
	const mcpPort = await unusedPort();
	const logs = [];
	const server = new PixlServer({
		__name: 'MCPProxyTest', __version: '1.0',
		config: {
			log_dir: dir, log_filename: 'test.log', pid_file: Path.join(dir, 'test.pid'),
			debug: true, echo: false, debug_level: 0, exit_on_shutdown: false,
			base_app_url: 'http://127.0.0.1:' + port,
			WebServer: { port, bind_address: '127.0.0.1', htdocs_dir: dir, temp_dir: dir, log_requests: false }
		},
		components: [xyopsRequire('pixl-server-web')]
	});
	await new Promise((resolve, reject) => server.startup(err => err ? reject(err) : resolve()));
	const app = { ...MCP };
	Object.assign(app, {
		config: { port: mcpPort }, server,
		xy: { master: true, web: server.WebServer, cleanEnv: Util.prototype.cleanEnv },
		logDebug: (...args) => logs.push(args)
	});
	// Register via the real init hook, but defer the child until after the
	// synthetic upstream checks below have released its configured port.
	const start = app.startLocalMCP;
	app.startLocalMCP = () => {};
	app.init();
	app.startLocalMCP = start;
	t.after(async () => {
		app.shut = true;
		await stop(app);
		await new Promise(resolve => server.shutdown(resolve));
		fs.rmSync(dir, { recursive: true, force: true });
	});
	const url = 'http://127.0.0.1:' + port + '/mcp';
	const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: 'Bearer test-key' };
	const rpc = (method, params, key = 'test-key') => fetch(url, {
		method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + key },
		body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
	});
	
	await t.test('disabled/not ready endpoint returns 503', async () => {
		assert.equal((await rpc('tools/list')).status, 503);
	});
	
	// A synthetic upstream checks transport details independently of the SDK.
	const captured = [];
	const upstream = http.createServer((request, response) => {
		const chunks = [];
		request.on('data', chunk => chunks.push(chunk));
		request.on('end', () => {
			captured.push({ headers: request.headers, body: Buffer.concat(chunks).toString() });
			response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Mcp-Session-Id': 'session-one', Connection: 'close, x-private', 'X-Private': 'hidden' });
			response.write('data: {"progress":1}\n\n');
			if (Buffer.concat(chunks).toString().includes('hold')) return;
			setTimeout(() => response.end('data: {"done":true}\n\n'), 30);
		});
	});
	upstream.listen(mcpPort, '127.0.0.1');
	await once(upstream, 'listening');
	app.mcpPort = mcpPort;
	app.mcpReady = true;
	app.mcpRequests = new Set();
	await t.test('preserves body bytes, protocol headers and SSE, strips cookies and hop headers', async () => {
		const body = '{ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": {"text":"雪"} }';
		const response = await fetch(url, { method: 'POST', headers: { ...headers, Cookie: 'secret=x', 'Mcp-Protocol-Version': '2025-11-25', 'Mcp-Session-Id': 'abc' }, body });
		assert.equal(response.headers.get('mcp-session-id'), 'session-one');
		assert.equal(response.headers.get('x-private'), null);
		assert.equal(await response.text(), 'data: {"progress":1}\n\ndata: {"done":true}\n\n');
		assert.equal(captured[0].body, body);
		assert.equal(captured[0].headers.authorization, 'Bearer test-key');
		assert.equal(captured[0].headers.cookie, undefined);
		assert.equal(captured[0].headers['mcp-session-id'], 'abc');
		assert.equal(captured[0].headers['mcp-protocol-version'], '2025-11-25');
		assert.equal(Number(captured[0].headers['content-length']), Buffer.byteLength(body));
		assert.equal(app.mcpRequests.size, 0);
	});
	await t.test('client disconnect releases the upstream stream', async () => {
		const abort = new AbortController();
		const response = await fetch(url, { method: 'POST', headers, body: '{"hold":true}', signal: abort.signal });
		const reader = response.body.getReader();
		await reader.read();
		abort.abort();
		await waitFor(() => app.mcpRequests.size === 0);
	});

	await t.test('occupied port cannot become ready or receive client credentials', async () => {
		const before = captured.length;
		await app.startLocalMCP();
		await once(app.mcpChild, 'close');
		assert.equal(app.mcpReady, false);
		assert.equal((await rpc('tools/list')).status, 503);
		assert.equal(captured.length, before);
		// Restore the synthetic upstream state for the connection failure check.
		app.mcpReady = true;
	});

	await new Promise(resolve => upstream.close(resolve));
	await t.test('connection failures return 502 and clean request tracking', async () => {
		assert.equal((await rpc('ping')).status, 502);
		assert.equal(app.mcpRequests.size, 0);
	});
	
	// Run the installed CLI against a tiny API fixture. Keys below are fake;
	// this exercises real MCP transport + SDK header forwarding, not a database.
	server.WebServer.addURIHandler('/api/app/get_events/v1', 'API fixture', (args, callback) => {
		const key = args.request.headers['x-api-key'];
		setTimeout(() => {
			if (key === 'invalid') return callback({ code: 'api', description: 'Invalid API Key' });
			callback({ code: 0, rows: [{ id: key, title: key, enabled: 1 }] });
		}, key === 'alpha' ? 40 : 5);
	});
	await app.startLocalMCP();
	await waitFor(() => app.mcpReady);
	const child = app.mcpChild;
	await t.test('real CLI initializes and lists its tools', async () => {
		const response = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
		assert.equal(response.status, 200);
		assert.equal((await readRPC(response)).result.serverInfo.name, 'xyops');
		const result = await readRPC(await rpc('tools/list'));
		assert.ok(result.result.tools.some(tool => tool.name === 'list_events'));
	});
	await t.test('simultaneous clients retain different API keys even with identical JSON-RPC IDs', async () => {
		const responses = await Promise.all(['alpha', 'beta'].map(key => rpc('tools/call', { name: 'list_events', arguments: {} }, key)));
		for (const [idx, response] of responses.entries()) {
			const result = await readRPC(response);
			assert.equal(result.id, 1);
			assert.equal(JSON.parse(result.result.content[0].text).rows[0].id, ['alpha', 'beta'][idx]);
		}
	});
	await t.test('missing keys, invalid keys and untrusted Origins are not elevated', async () => {
		assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
		assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
		const result = await readRPC(await rpc('tools/call', { name: 'list_events', arguments: {} }, 'invalid'));
		assert.equal(result.result.isError, true);
		assert.match(result.result.content[0].text, /Invalid API Key/);
	});
	await t.test('notification status and method errors pass through', async () => {
		const notification = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
		assert.equal(notification.status, 202);
		assert.equal((await fetch(url, { headers })).status, 405);
		assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 405);
		assert.equal(await notification.text(), '');
		assert.equal((await fetch(url, { method: 'PUT', headers, body: '{}' })).status, 405);
		assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
	});

	await t.test('backup conductors do not proxy and shutdown reaps the child', async () => {
		app.xy.master = false;
		assert.equal((await rpc('tools/list')).status, 503);
		app.xy.master = true;
		app.shut = true;
		await stop(app);
		assert.equal(app.mcpChild, null);
		assert.equal(app.mcpReady, false);
		assert.equal(server.WebServer.uriHandlers.some(handler => handler.name === '@pixlcore/xyext-mcp'), false);
		assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
	});
});
