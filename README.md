# Naylence Runtime TypeScript

Complete TypeScript/JavaScript implementation of the Naylence Fame runtime, providing cross-platform messaging, agent orchestration, and async task management capabilities.

## Features

### ✅ Complete Fame Protocol Support

- **Core Fame Protocol** - Full implementation of envelopes, frames, and messaging
- **Connector abstractions** - Base classes for building transport connectors
- **Flow control mechanisms** - Backpressure and credit-based flow management
- **Security framework** - Encryption, signing, and authentication support
- **Service abstractions** - RPC and message-based service patterns

### ✅ Cross-Platform Logging

- **Structured logging** with processors (similar to Python's structlog)
- **Cross-platform support** - works in both Node.js and browser environments
- **Envelope context injection** - automatic context propagation for distributed tracing
- **Multiple log levels** including custom TRACE level
- **Configurable transports** - console, JSON, or Pino (Node.js only)
- **Child loggers** with bound context

### ✅ Async Task Management

- **TaskSpawner** - Promise-based task management (equivalent to Python's asyncio)
- **Cancellation support** - AbortSignal-based task cancellation
- **Graceful shutdown** - Clean task termination with configurable timeouts
- **Error handling** - Comprehensive error classification and reporting
- **Concurrency limits** - Control maximum concurrent tasks
- **Task utilities** - retry, debounce, throttle, race conditions, and more

## Installation

```bash
npm install naylence-runtime
```

## Quick Start

### Complete Runtime Example

```typescript
import { 
  // Core Fame protocol
  createFameEnvelope,
  ConnectorState,
  generateId,
  // Task management
  TaskSpawner,
  delay,
  retryWithBackoff,
  // Logging  
  getLogger,
  basicConfig,
  LogLevel,
  withEnvelopeContextAsync
} from 'naylence-runtime';

// Configure logging
basicConfig({ level: LogLevel.DEBUG });
const logger = getLogger('example');

async function demonstrateRuntime() {
  // Create a Fame envelope
  const envelope = createFameEnvelope({
    to: 'service@remote',
    frame: {
      type: 'Data',
      payload: { message: 'Hello Fame!' }
    }
  });

  // Use TaskSpawner for async task management
  const spawner = new TaskSpawner();
  
  try {
    // Process within envelope context 
    await withEnvelopeContextAsync(envelope, async () => {
      logger.info('Processing envelope');
      
      // Spawn concurrent tasks
      const validationTask = spawner.spawn(async () => {
        await delay(100);
        return 'validation_passed';
      }, { name: 'validate' });
      
      const authTask = spawner.spawn(async () => {
        await delay(150);  
        return 'auth_approved';
      }, { name: 'authorize' });
      
      const [validation, auth] = await Promise.all([
        validationTask.promise,
        authTask.promise
      ]);
      
      logger.info('Processing completed', { validation, auth });
    });
    
  } finally {
    await spawner.shutdownTasks();
  }
}
```

### Fame Protocol Usage

```typescript
import { 
  createFameEnvelope,
  FameAddress,
  Priority,
  ConnectorState,
  ConnectorStateHelper
} from 'naylence-runtime';

// Create envelopes
const envelope = createFameEnvelope({
  to: 'user-service@cloud',
  frame: {
    type: 'Data',
    payload: { action: 'get_profile', user_id: '123' }
  }
});

// Work with connector states
const helper = new ConnectorStateHelper(ConnectorState.STARTED);
console.log(helper.isActive); // true
console.log(helper.canStart); // false
```

### Advanced Task Management

```typescript
import { TaskSpawner, retryWithBackoff, waitForAny, throttle } from 'naylence-runtime';

const spawner = new TaskSpawner({ maxConcurrent: 5 });

// Retry with exponential backoff
const result = await retryWithBackoff(async () => {
  // Operation that might fail
  const response = await fetch('/api/data');
  if (!response.ok) throw new Error('API failed');
  return response.json();
}, {
  maxRetries: 3,
  baseDelayMs: 100,
  backoffMultiplier: 2
});

// Race multiple tasks
const tasks = [
  spawner.spawn(() => fetchFromCache(), { name: 'cache' }),
  spawner.spawn(() => fetchFromAPI(), { name: 'api' }),
  spawner.spawn(() => fetchFromBackup(), { name: 'backup' })
];

const winner = await waitForAny(tasks);

// Throttle function calls
const throttledSave = throttle(async (data) => {
  await saveToDatabase(data);
}, 1000);
```

### Structured Logging

```typescript
import { getLogger, withEnvelopeContext } from 'naylence-runtime';

const logger = getLogger('auth.service');

// Log with structured data
logger.info('User login', {
  user_id: 'user123',
  ip_address: '192.168.1.1',
  success: true,
  duration_ms: 150
});

// Create child loggers with bound context
const userLogger = logger.child({ user_id: 'user123', session_id: 'sess456' });
userLogger.info('Profile updated'); // Automatically includes user_id and session_id
```

## Architecture

This implementation provides a complete Fame runtime that closely mirrors the Python version:

- **Complete Fame Protocol** - All core types, envelopes, frames, and messaging patterns
- **Cross-platform compatibility** - single codebase for Node.js and browser
- **Promise-based async** - TaskSpawner provides asyncio-like task management
- **Structured logging** with configurable processors and context propagation  
- **Modular design** - easily extensible with custom connectors and services

## Key Components

### Core Protocol
- **Envelopes & Frames** - Complete message structure implementation
- **Addressing** - Fame address parsing and validation

### Storage Providers
- **Configurable factories** – `InMemoryStorageProviderFactory`, `SQLiteStorageProviderFactory`, and `StorageProfileFactory` mirror the Python runtime profiles (`memory`, `sqlite`, `encrypted-sqlite`).
- **Schema validation** – Storage factory inputs are validated with Zod before instantiation, ensuring early feedback on misconfiguration.
- **Parity note** – The encrypted key-value store in this port exposes an explicit `update` method while the Python implementation still delegates updates via `set`. We retain the method here for backwards compatibility and will upstream an equivalent helper to Python in a follow-up release.
- **Security** - Encryption, signing, and authentication headers
- **Flow Control** - Credit-based backpressure management

### Node Placement
- **Static placement strategy** – `StaticNodePlacementStrategy` deterministically assigns child nodes under a configured parent system and path, returning structured metadata equal to the Python implementation.
- **Factory parity** – `StaticNodePlacementStrategyFactory` and `WebSocketPlacementStrategyFactory` register with the shared factory registry, including a default static strategy and a deprecated alias that still issues a `DeprecationWarning` like the Python runtime.
- **Legacy compatibility** – Configuration dictionaries using the historical `WebSocketNodePlacementStrategy` type are automatically normalized to the static strategy while preserving snake_case fields and parity semantics.

### Task Management  
- **TaskSpawner** - Spawn and manage concurrent async tasks
- **Cancellation** - Proper AbortSignal support throughout
- **Error Handling** - Comprehensive error classification
- **Utilities** - retry, debounce, throttle, timeouts, and more

### Logging & Observability
- **Structured Logging** - JSON/pretty output with processors
- **Context Propagation** - Envelope context injection for tracing
- **Cross-Platform** - Adapts to Node.js (Pino) or browser (console)

### Integration
- **Service Patterns** - RPC and message-based service abstractions  
- **Connector Framework** - Base classes for transport implementations
- **Factory Pattern** - Configurable resource and service factories

## Migration from Python

The TypeScript API maintains compatibility with Python patterns:

| Python | TypeScript |
|--------|------------|
| `from naylence.fame.core import createFameEnvelope` | `import { createFameEnvelope } from 'naylence-runtime'` |
| `spawner = TaskSpawner()` | `const spawner = new TaskSpawner()` |
| `task = spawner.spawn(coro(), name="task")` | `const task = spawner.spawn(async () => {}, { name: "task" })` |
| `await spawner.shutdown_tasks()` | `await spawner.shutdownTasks()` |
| `with envelope_context(env):` | `withEnvelopeContext(env, () => {` |

## Development

```bash
# Install dependencies
npm install

# Build the project  
npm run build

# Run tests
npm test

# Run examples
npx tsx examples/complete-runtime-example.ts
npx tsx examples/task-spawner-example.ts
npx tsx examples/logging-example.ts

# Development mode
npm run dev

# Lint and format
npm run lint
npm run format
```

## Dependencies

- **naylence-core** - Core Fame protocol implementation
- **zod** - Runtime type validation
- **pino** (optional) - High-performance logging in Node.js

## License

Apache-2.0 - See [LICENSE](LICENSE) file for details.