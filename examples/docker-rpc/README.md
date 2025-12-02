# Docker RPC Sentinel Example

This example shows how to run a Fame sentinel in Docker and expose RPC operations
implemented with the Naylence Runtime. The compose stack mounts the calculator
sentinel script directly from this directory, so you can tweak the example
without rebuilding the Docker image.

## Prerequisites

- Docker Engine with Docker Compose v2
- Node.js 18+ available on the host (only required if you want to rebuild the
  runtime locally before running the example)

## Build the runtime (optional)

The Dockerfile already compiles the runtime and its local dependencies, but if
you want to iterate quickly you can pre-build everything on the host:

```bash
npm install
npm run build
```

## Start the sentinel

```bash
cd examples/docker-rpc
make up
```

The sentinel listens on `http://127.0.0.1:28000` and registers a calculator
service with the address `calculator@/test-sentinel`. The sentinel script loads
prebuilt modules from the mounted `dist/` directory, so you can rebuild the
runtime locally and rerun the container without rebuilding the image. Node runs
with `--experimental-specifier-resolution=node` and a tiny custom loader to
support extension-less imports emitted by the TypeScript build.

### Configuration

- `config/sentinel-config.yml` is mounted into the container at
  `/etc/fame/fame-config.yml`. Environment placeholders such as
  `${env:SENTINEL_HTTP_PORT}` are resolved at runtime, so you can keep secrets
  and ports outside of version control.
- `config/.env` provides default values for the sentinel. Feel free to edit this
  file or supply your own via `docker compose --env-file`.
- Any environment variables exported in `.env` are available to the sentinel
  process and can influence both the YAML config and runtime logging.

### Helpful Make targets

The included `Makefile` streamlines common workflows:

| Target              | Description                                                         |
| ------------------- | ------------------------------------------------------------------- |
| `make build`        | Compile the Naylence Runtime TypeScript sources into `dist/`.       |
| `make up`           | Compile (if needed) and run the sentinel in the foreground.         |
| `make up-detached`  | Same as `up`, but keeps containers running in the background.       |
| `make docker-build` | Rebuild the Docker image after compiling the framework locally.     |
| `make logs`         | Tail logs from the sentinel container.                              |
| `make clean`        | Tear down containers, networks, and volumes created by the example. |

The sentinel source code and the compiled `dist/` directory are mounted into the
container so you can iterate after running `make build` without rebuilding the
image.

## Inspecting the logs

The sentinel logs basic information about RPC calls, emitted using the runtime's
structured logging helpers. To stop the container, press `Ctrl+C` and Docker
Compose will shut down the stack.

## Trying the calculator manually

Once the sentinel is running, you can attach a Fame node from another process or
use the included RPC client to invoke the calculator service. In a second
terminal run:

```bash
make run
```

The client connects to the sentinel over WebSocket, performs a few calculator
operations, and prints the results. You can override its defaults with
environment variables before running `make run`:

| Variable                | Description                                  | Default                                             |
| ----------------------- | -------------------------------------------- | --------------------------------------------------- |
| `RPC_CLIENT_ID`         | Node identifier used during attach handshake | `ts-rpc-client`                                     |
| `RPC_DOWNSTREAM_WS_URL` | WebSocket URL exposed by the sentinel        | `ws://127.0.0.1:28000/fame/v1/attach/ws/downstream` |
| `RPC_TARGET_ADDRESS`    | Fame address of the calculator service       | `calculator@/test-sentinel`                         |
| `RPC_REQUESTED_LOGICAL` | Logical name requested during attach         | `calculator`                                        |
| `RPC_SENTINEL_HTTP_URL` | HTTP URL used to wait for sentinel readiness | `http://127.0.0.1:28000/`                           |
| `RPC_FIB_COUNT`         | Number of Fibonacci values to stream         | `10`                                                |
| `RPC_CLIENT_LOG_LEVEL`  | Log level (`DEBUG`, `INFO`, etc.)            | `INFO`                                              |

All requests go through the runtime's `RpcProxy.remoteByAddress` helper. The
example is designed for manual exploration and is not exercised by the
automated Jest suite.

## Cleaning up

```bash
cd examples/docker-rpc
docker compose down -v --remove-orphans
```

This removes the container and any temporary volumes created for the example.
