# js-llmcord

A TypeScript Discord bot powered by the [Vercel AI SDK](https://ai-sdk.dev/), supporting multiple LLM providers with streaming responses, tool calling, MCP integration, and optional RAG capabilities.

Originally a port of [llmcord](https://github.com/jakobdylanc/llmcord/) with significant enhancements.

## Features

- **Multi-provider support** - OpenAI, Anthropic, xAI, Groq, OpenRouter, Google, Azure, Mistral, Ollama, LM Studio, vLLM, and any OpenAI-compatible endpoint
- **Streaming responses** - Real-time message updates with embed-based or plain text output
- **Tool calling** - Local and remote MCP servers, custom extensions, compatible mode for models without native tool support
- **RAG support** - Optional user memory via PostgreSQL + pgvector with semantic search
- **Per-channel models** - Optionally configure different models per channel/thread
- **Image handling** - Vision model support with optional automatic UploadThing upload for large images
- **Anthropic prompt caching** - Reduce costs with cache control on system messages and tools
- **Conversation threading** - Full context from reply chains and Discord threads

## Quick Start

### Docker (Recommended)

```bash
# Create config file
cp config-example.yaml config.yaml
# Edit config.yaml with your bot token and API keys

# Run
docker compose up -d
```

### Local Development

```bash
bun install
cp config-example.yaml config.yaml
# Edit config.yaml
bun run index.ts
```

## Configuration

Copy `config-example.yaml` to `config.yaml`. Key settings:

```yaml
bot_token: "your-discord-bot-token"
client_id: "123456789" # MUST be quoted (JavaScript number precision)

# Limits
max_messages: 25 # Conversation history length
max_steps: 10 # Max tool call iterations

# Features
per_channel_model: false
stats_for_nerds: false # Show token usage in responses
use_plain_responses: false

# Providers (configure API keys)
providers:
  openai:
    base_url: https://api.openai.com/v1
    api_key: sk-xxx

# Models (provider/model format)
models:
  openai/gpt-4o:
    temperature: 0.7
  anthropic/claude-sonnet-4:
    anthropic_cache_control: true
```

> **Important**: All Discord IDs (client_id, user IDs, channel IDs) **must be quoted** in YAML to avoid JavaScript number precision issues.

### Permissions

```yaml
permissions:
  users:
    admin_ids: ["123"] # Can change models via /model
    allowed_ids: [] # Whitelist (empty = allow all)
    blocked_ids: [] # Blacklist
  channels:
    allowed_ids: []
    blocked_ids: []
```

### Tools & MCP

```yaml
tools:
  include_summary: false # Append tool call summary to responses
  local_mcp:
    fetch:
      command: uvx
      args: ["mcp-server-fetch"]
  remote_mcp:
    context7:
      type: "http" # or "sse"
      url: https://mcp.context7.com/mcp
      headers:
        Authorization: Bearer xxx
```

### RAG (Optional)

Requires PostgreSQL with pgvector and OpenAI API for embeddings:

```yaml
rag:
  enable: true
  postgres_uri: "postgresql://user:pass@host:5432/db"
  embedding_model: "text-embedding-3-small"
```

Adds tools: `rememberUserContext`, `recallUserContext`, `forgetUserContext`

## Slash Commands

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `/model [model]`     | View or change the current model              |
| `/tools [tools]`     | Toggle tools on/off (comma-separated)         |
| `/list-tools [tool]` | List available tools or show tool description |
| `/reload-tools`      | Reload all MCP and extension tools            |

## Extensions

Create custom tools in the `extensions/` directory:

```typescript
// extensions/my-tool.ts
import z from "zod";
import { tool } from "ai";

export default async function MyTool() {
  return {
    myTool: tool({
      description: "Does something useful",
      inputSchema: z.object({
        input: z.string().describe("The input"),
      }),
      execute: async ({ input }) => {
        return `Result: ${input}`;
      },
    }),
  };
}
```

Extensions are automatically loaded on startup. Use `/reload-tools` to reload without restart.

## Model Configuration Options

```yaml
models:
  openai/gpt-4o:
    temperature: 0.7
    max_tokens: 4096
    tools: false          # Disable tools for this model
    tools: 'compatible'   # Use text-based tool calling

  anthropic/claude-sonnet-4:
    anthropic_cache_control: true
    anthropic_cache_ttl: "1h"
    thinking:
      type: enabled
      budget_tokens: 1500

  openai/o3:
    reasoning_effort: high    # low, medium, high
    reasoning_format: parsed  # parsed, raw, hidden
```

## OpenAI-Compatible Provider Patches

### Tool Call Index Patch

Some OpenAI-compatible providers (e.g., Gemini via axolotl/veloera gateway) have compatibility issues when using tools with the AI SDK:

1. **Unsupported JSON Schema keywords**: Gemini API doesn't support several JSON Schema keywords, causing 400 errors:
   - `const` → Converted to `enum` with single value
   - `propertyNames`, `patternProperties`, `dependencies` → Removed
   - `if`/`then`/`else`, `not` → Removed
   - `$ref`, `$id`, `$schema`, `$comment` → Removed
2. **Extra SSE chunks after tool calls**: Some providers send empty chunks after `finish_reason: "tool_calls"`, which breaks AI SDK's stream parsing.
3. **Missing tool call indices**: Some providers don't include `index` fields in streaming tool calls, causing parsing errors.

#### Usage

Add `compatibility.patch_tool_call_index: true` to the provider config:

```yaml
providers:
  my-openai-compatible-provider:
    base_url: http://your-gateway/v1
    api_key: your-api-key
    compatibility:
      patch_tool_call_index: true  # Enable the patch
```

#### What it does

- **Request transformation**: Recursively removes unsupported JSON Schema keywords from tool definitions and converts `const` to `enum`.
- **Response stream filtering**: Filters out empty SSE chunks that appear after `finish_reason: "tool_calls"`.
- **Index assignment**: Automatically assigns missing `index` fields to tool calls in streaming responses.
- **Zero impact when disabled**: If `patch_tool_call_index` is not set or `false`, the provider behaves exactly as before.

#### Debug mode

Set `DEBUG=patch` or `DEBUG=*` environment variable to see detailed logs:

```bash
DEBUG=patch bun run index.ts
```

#### Implementation

The patch is implemented as a modular, defensive fetch wrapper in `src/tool-call-index-patch.ts`:

**Architecture:**
- **Configuration Layer**: Centralized config for easy updates when API requirements change
  - `SCHEMA_TRANSFORM_CONFIG`: Keywords to remove/transform
  - `STREAM_PATCH_CONFIG`: Stream patching behavior
- **Utility Layer**: Defensive helpers for safe property access
  - `safeGet()`: Type-safe nested property access
  - `isValidArray()`, `isPlainObject()`: Type guards
- **Transformation Layer**: JSON Schema compatibility
  - `transformJsonSchema()`: Recursive schema transformation
  - `transformRequestBody()`: Request body preprocessing
- **Patching Layer**: Stream response handling
  - `patchSseStream()`: SSE stream transformation
  - `ensureToolCallIndex()`: Index assignment logic
- **Main Export**: `createToolCallIndexPatchedFetch()` with extensibility options

**Resilience Features:**
- Defensive error handling: Returns original data on any error
- Safe property access: No crashes on unexpected structures
- Extensible: Custom keywords and transforms via options
- Testable: Internal functions exported in debug mode

The patch is applied conditionally in `src/model-routing.ts` only for providers with `compatibility.patch_tool_call_index: true`.

#### Supported JSON Schema Keywords

The patch ensures compatibility with Gemini API by removing these unsupported keywords:
- `propertyNames` - Property name validation patterns
- `patternProperties` - Pattern-based property matching
- `dependencies` - Property dependencies
- `if`/`then`/`else` - Conditional schemas
- `not` - Schema negation
- `$ref`, `$id`, `$schema`, `$comment` - Schema references and metadata

The `const` keyword is converted to `enum` with a single value instead of being removed.

**Extensibility:** You can add custom keywords to remove or transform:
```typescript
createToolCallIndexPatchedFetch(fetch, {
  additionalKeywordsToRemove: ["customKeyword"],
  customKeywordTransforms: {
    myKeyword: (value) => ({ replacement: value })
  }
})
```

## Docker Compose with RAG

```yaml
services:
  js-llmcord:
    image: ghcr.io/stanley2058/js-llmcord:latest
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./config.yaml:/app/config.yaml:ro
      - ./data:/app/data
      - ./extensions:/app/extensions

  postgres-vector:
    image: pgvector/pgvector:pg18-trixie
    restart: unless-stopped
    volumes:
      - ./pg_data:/var/lib/postgresql/data
    environment:
      POSTGRES_USER: "js_llmcord"
      POSTGRES_PASSWORD: "your-password"
      POSTGRES_DB: "js_llmcord_rag"
```

## Development

```bash
# Run tests
bun test

# Run single test file
bun test tests/markdown-chunker.test.ts

# Run with pattern
bun test --test-name-pattern "should not drop"
```

## License

See [LICENSE](LICENSE).
