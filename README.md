<p align="center"><img src="https://raw.githubusercontent.com/pixlcore/xyext-mcp/refs/heads/main/logo.png" height="160" alt="MCP Server for xyOps"/></p>
<h1 align="center">MCP Server for xyOps</h1>

Connect your AI assistant directly to xyOps. This extension adds a Model Context Protocol (MCP) server at `/mcp` on your conductor's existing URL, with tools for events, jobs, tickets, alert invocations, monitoring snapshots, and servers.

The extension includes [xyCLI](https://github.com/pixlcore/xycli) as a dependency and runs its MCP HTTP server locally. It works with Docker and manual xyOps installations. You do not need a global CLI installation, a separate container, or an additional published port.

## Installation

Requires **xyOps 1.1.11 or later**.

Install **MCP Server** from the xyOps Marketplace. Installing the extension enables it automatically after the conductor restarts. No configuration is required for the default setup.

For unpublished development versions, use the [local extension development instructions](https://github.com/pixlcore/xyops/blob/main/docs/ext.md#local-development). The package name is `@pixlcore/xyext-mcp` and its runtime ID is `pixlcore-xyext-mcp`.

## Connect Your AI Assistant

Choose **Streamable HTTP** in your MCP client and use your conductor's URL with `/mcp` appended:

```text
https://xyops.example.com/mcp
```

Configure this request header in your client:

```text
Authorization: Bearer YOUR_XYOPS_API_KEY
```

Each client supplies its own xyOps API key. The extension forwards it to xyCLI, and xyOps validates the key and enforces its permissions and resource restrictions when tools call the API. There is no shared server API key to configure. Choose the permissions you want to grant the assistant when creating its key in xyOps.

To explore the tool list and make calls manually, launch [MCP Inspector](https://github.com/modelcontextprotocol/inspector):

```sh
npx @modelcontextprotocol/inspector
```

Select Streamable HTTP, enter your conductor's `/mcp` URL, and configure the Bearer authorization header. See the [xyCLI MCP guide](https://github.com/pixlcore/xycli/blob/main/docs/mcp.md) for tool descriptions and more client examples.

## Existing SSO Setups

If you use the **xyOps OIDC Plugin**, no changes are needed. Its login capture applies to the home page, so MCP clients can use `/mcp` directly with their xyOps API keys.

If you use an external authentication proxy, update it to let the exact `/mcp` path bypass browser login:

- **OAuth2-Proxy (direct proxy):** Append `^/mcp$` to `OAUTH2_PROXY_SKIP_AUTH_ROUTES`. Set `OAUTH2_PROXY_PASS_BASIC_AUTH` and `OAUTH2_PROXY_PASS_AUTHORIZATION_HEADER` to `"false"` so client Bearer tokens are preserved.
- **Authentik:** Add `^/mcp$` to the provider's **Unauthenticated Paths**.
- **xyops-nginx-sso:** Update to v1.0.11+, then reload or restart Nginx. Changing only OAuth2-Proxy's skip list is not enough in this setup.

Any proxy in front of `/mcp` must preserve the client's `Authorization` header and allow SSE responses to stream without buffering or caching. Keep browser pages protected by SSO; xyOps still enforces API-key permissions for MCP tool calls. See the [SSO setup guide](https://github.com/pixlcore/xyops/blob/main/docs/sso.md#mcp-clients) for the complete examples.

## Configuration

The only setting is `port`, which defaults to `5524`. This is the private port used by the internal service on `127.0.0.1`. Clients always connect through the xyOps conductor's `/mcp` endpoint.

To choose another port, merge this into your xyOps configuration, preserving any existing extension settings:

```json
{
	"extensions": {
		"pixlcore-xyext-mcp": {
			"port": 5525
		}
	}
}
```

Restart the conductor to apply the change. Choose an unused port between `1` and `65535`, different from `WebServer.port`. In Docker, the equivalent environment option is:

```sh
-e XYOPS_extensions__pixlcore-xyext-mcp__port=5525
```

Remove the extension through the Marketplace when you no longer want the MCP endpoint.

## Deployment Notes

- The child connects back to xyOps at `http://127.0.0.1:PORT`. The conductor's HTTP listener must be accessible on loopback.
- External clients use the conductor's existing HTTPS listener or reverse proxy. Do not publish the internal MCP child port.
- Browser requests with an `Origin` header must match the origin of xyOps's `base_app_url`. Desktop agents that omit this header can connect normally.
- Extensions run on the primary conductor. In a multi-conductor cluster with a load balancer, route `/mcp` to the current primary.

The extension launches its dependency using the conductor's Node.js executable. Node's module resolution handles both ordinary NPM dependency layouts and development symlinks. Child diagnostics are written to `logs/Extension.log` with the category column set to `pixlcore-xyext-mcp`.

The endpoint returns `503` while the child is unavailable. An unexpected child exit is logged and requires a conductor restart; requests are not automatically replayed. During shutdown, the extension removes its URI handler, closes its proxy connections, and sends SIGTERM to the child without waiting for it.

## Development Tests

Install the package dependencies and run the tests against a development xyOps checkout:

```sh
XYOPS_ROOT=/path/to/xyops npm test
```

Without `XYOPS_ROOT`, the tests look for a sibling `xyops` checkout beside the parent `xyplugs` directory. They use that checkout's web-server dependencies, the extension's actual xyCLI dependency, and an isolated API fixture. They do not require a running conductor or real API keys.

The tests cover startup and shutdown, custom ports, port conflicts, concurrent client credentials, JSON and SSE forwarding, missing or invalid credentials, rejected origins, and disconnect cleanup.

## Privacy

This extension does not collect telemetry or send data to an external service. Tool requests and results travel between your MCP client and xyOps through a local child process. Your AI application may send results to its model provider according to that application's configuration and policies.

## License

MIT. See [LICENSE.md](LICENSE.md). xyCLI and its dependencies retain their own licenses.
