// MCP Extension for xyOps
// Copyright (c) 2026 PixlCore LLC
// MIT License

const cp = require('child_process');
const http = require('http');

module.exports = {
	
	init() {
		// Extensions are loaded on the primary. Installing this package enables
		// MCP without any additional service or global CLI installation.
		this.shut = false;
		this.xy.web.addURIHandler('/mcp', '@pixlcore/xyext-mcp', this.handleMCP.bind(this));
		this.startLocalMCP();
	},
	
	startLocalMCP() {
		// One long-lived HTTP server, with credentials scoped to each request.
		if (this.mcpChild || this.shut) return;
		const webPort = Number(this.server.config.getPath('WebServer.port'));
		
		const port = Number(this.config.port ?? 5524);
		if (!Number.isInteger(port) || port < 1 || port > 65535 || port === webPort) {
			return this.logDebug(1, 'Cannot launch local MCP: Invalid MCP port (must differ from WebServer.port).');
		}
		
		// Strip conductor settings BEFORE adding CLI settings. Do not supply a
		// service API key: every HTTP caller must provide its own Bearer token.
		const env = this.xy.cleanEnv();
		env.XYOPS_BASE_URL = 'http://127.0.0.1:' + webPort;
		env.XYOPS_API_KEY = '';
		
		// The SDK must reach the conductor directly, even on hosts configured
		// with a corporate outbound proxy. Set both spellings for compatibility.
		env.NO_PROXY = env.no_proxy = '127.0.0.1,localhost,::1';
		env.XYOPS_MCP_TLS_CERT = '';
		env.XYOPS_MCP_TLS_KEY = '';
		
		let origin;
		try { origin = new URL(this.server.config.get('base_app_url')).origin; }
		catch (err) { return this.logDebug(1, 'Cannot launch local MCP: Invalid base_app_url.'); }
		env.XYOPS_MCP = JSON.stringify({ allowed_hosts: ['127.0.0.1'], allowed_origins: [origin] });
		
		this.mcpPort = port;
		this.mcpReady = false;
		this.mcpRequests = new Set();
		let child;
		
		try {
			// Resolve from this package so NPM hoisting and development symlinks
			// both work. Use the conductor's Node executable, never a global xy.
			const entry = require.resolve('@pixlcore/xycli');
			child = cp.spawn(process.execPath, [entry, 'mcp', 'serve', '--host', '127.0.0.1', '--port', String(port)], {
				env, stdio: ['ignore', 'pipe', 'pipe']
			});
		}
		catch (err) {
			this.logDebug(1, 'Cannot launch local MCP: ' + err.message);
			return;
		}
		
		this.mcpChild = child;
		this.logDebug(2, 'Starting local MCP HTTP server on loopback port ' + port);
		
		// Only mark ready after this child announces its successful bind. A
		// service already occupying the port must never receive client keys.
		const readyLine = 'xy mcp: Listening at http://127.0.0.1:' + port + '/mcp';
		
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding('utf8');
			let pending = '';
			
			stream.on('data', chunk => {
				pending += chunk;
				let index;
				
				while ((index = pending.indexOf('\n')) >= 0) {
					const line = pending.slice(0, index).trim();
					pending = pending.slice(index + 1);
					
					if (line === readyLine && !this.shut && child.exitCode === null && child.signalCode === null) this.mcpReady = true;
					if (line) this.logDebug(5, 'MCP: ' + line);
				}
				
				// Bound buffering even if a diagnostic never includes a newline.
				if (pending.length > 8192) { this.logDebug(5, 'MCP: ' + pending.slice(0, 8192)); pending = ''; }
			});
			stream.on('end', () => { if (pending) this.logDebug(5, 'MCP: ' + pending); });
		}
		
		child.on('error', err => {
			this.mcpReady = false;
			this.logDebug(1, 'Local MCP process error: ' + err.message);
		});
		
		child.on('exit', (code, signal) => {
			this.mcpReady = false;
			for (const request of this.mcpRequests) request.destroy();
			this.logDebug(this.shut ? 3 : 1, 'Local MCP process exited', { code, signal });
		});
		
		child.on('close', () => { if (this.mcpChild === child) this.mcpChild = null; });
	},
	
	handleMCP(args, callback) {
		// The web server has already consumed the request body. Reuse its bytes
		// and calculate a fresh Content-Length instead of piping an empty input.
		const { request, response } = args;
		const fail = (status, message) => callback(status, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }, message);
		
		if (!this.xy.master || this.xy.shut || this.shut || !this.mcpReady) return fail('503 Service Unavailable', 'Local MCP server is unavailable.');
		
		if (!['POST', 'GET', 'DELETE'].includes(request.method)) {
			return callback('405 Method Not Allowed', { Allow: 'POST, GET, DELETE' }, 'Method not allowed.');
		}
		
		if (request.method === 'POST' && !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) {
			return fail('415 Unsupported Media Type', 'MCP requests must use application/json.');
		}
		
		// Preserve MCP and authentication headers only. Cookies, forwarded
		// identity headers, and hop-by-hop headers do not belong on this hop.
		// Modern MCP requests require method/name headers matching the body.
		const headers = {};
		for (const name of ['authorization', 'accept', 'content-type', 'content-encoding', 'origin', 'mcp-protocol-version', 'mcp-method', 'mcp-name', 'mcp-session-id', 'last-event-id']) {
			if (request.headers[name] !== undefined) headers[name] = request.headers[name];
		}
		
		const body = request.method === 'POST' ? (request.body || Buffer.from(JSON.stringify(args.params))) : null;
		if (body) headers['content-length'] = body.length;
		
		let completed = false;
		let upstream;
		
		const finish = () => {
			if (completed) return;
			completed = true;
			this.mcpRequests.delete(upstream);
			response.removeListener('finish', finish);
			response.removeListener('close', disconnect);
			args.perf.end('process');
			callback(true);
		};
		
		const disconnect = () => { upstream.destroy(); finish(); };
		
		upstream = http.request({
			hostname: '127.0.0.1', port: this.mcpPort, path: '/mcp',
			method: request.method, headers, agent: false
		}, incoming => {
			// Stream JSON or SSE verbatim. Strip connection-specific headers,
			// including any additional names nominated by Connection itself.
			const excluded = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
			for (const name of String(incoming.headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
			
			const output = {};
			for (const name in incoming.headers) { if (!excluded.has(name)) output[name] = incoming.headers[name]; }
			
			response.writeHead(incoming.statusCode, output);
			response.flushHeaders();
			
			incoming.on('data', chunk => args.perf.count('bytes_out', chunk.length));
			incoming.on('error', () => response.destroy());
			incoming.pipe(response);
		});
		
		this.mcpRequests.add(upstream);
		
		response.once('finish', finish);
		response.once('close', disconnect);
		
		upstream.setTimeout(120000, () => upstream.destroy(new Error('MCP upstream timeout')));
		
		upstream.on('error', err => {
			if (completed) return;
			this.logDebug(3, 'MCP upstream request failed: ' + err.message);
			if (response.headersSent) response.destroy();
			else {
				response.writeHead(502, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
				response.end('Local MCP server request failed.');
			}
		});
		
		upstream.end(body);
	},
	
	shutdown() {
		// Extension shutdown is fire-and-forget. Stop admitting requests, remove
		// our route and signal the attached child without blocking the conductor.
		this.shut = true;
		this.mcpReady = false;
		this.xy.web.removeURIHandler('@pixlcore/xyext-mcp');
		
		for (const request of this.mcpRequests || []) request.destroy();
		
		const child = this.mcpChild;
		if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
	}
	
};
