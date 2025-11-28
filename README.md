# js-llmcord

A TypeScript port of [llmcord](https://github.com/jakobdylanc/llmcord/) Discord bot with some modifications.

## Notices

- `client_id` and other ids in `permissions` **MUST** be enclosed in quotes, otherwise they will be treated as numbers. And due to how numbers work in JavaScript, number bigger than `MAX_SAFE_INTEGER` will be inaccurate.
  - Other options with small numbers are fine, just that Discord ids are always larger than `MAX_SAFE_INTEGER` when treated as numbers.
- This project uses ai-sdk instead of OpenAI's SDK, so there might be some mismatch in provider specific options. Other options are fully compatible with the original project, and should just work.

## Additional features

- Auto upload big images (>1MB) to UploadThing (if configured), and a record is kept in a local SQLite database.
- Username support in all models.
- Remote and local MCP support.
- Optional RAG support via OpenAI's embedding API & `pgvector`. Only supports embedding models that use 1536 dimensions.

This project was created using `bun init` in bun v1.2.19. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## OpenAI-Compatible Provider Patches

### Tool Call Index Patch

Some OpenAI-compatible providers (e.g., Gemini via axolotl/veloera gateway) have compatibility issues when using tools with the AI SDK:

1. **`const` keyword not supported**: Gemini API doesn't support the `const` keyword in JSON Schema definitions, causing 400 errors.
2. **Extra SSE chunks after tool calls**: Some providers send empty chunks after `finish_reason: "tool_calls"`, which breaks AI SDK's stream parsing.

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

- **Request transformation**: Recursively removes all `const` keys from tool definitions and converts them to `enum` with a single value.
- **Response stream filtering**: Filters out empty SSE chunks that appear after `finish_reason: "tool_calls"`.
- **Zero impact when disabled**: If `patch_tool_call_index` is not set or `false`, the provider behaves exactly as before.

#### Debug mode

Set `DEBUG=patch` or `DEBUG=*` environment variable to see detailed logs:

```bash
DEBUG=patch bun run index.ts
```

### Development Notes

The patch is implemented as a fetch wrapper in `src/tool-call-index-patch.ts`:

- `transformConstToEnum()`: Recursively transforms JSON Schema to replace `const` with `enum`
- `patchSseStream()`: Filters SSE stream to remove problematic empty chunks
- `createToolCallIndexPatchedFetch()`: Main export that wraps the base fetch function

The patch is applied conditionally in `src/model-routing.ts` only for providers with `compatibility.patch_tool_call_index: true`.
