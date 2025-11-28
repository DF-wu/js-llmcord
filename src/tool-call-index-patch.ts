import type { FetchFunction } from "@ai-sdk/provider-utils";

const DEBUG = process.env.DEBUG?.includes("patch") || process.env.DEBUG === "*";

type ChoiceIndexState = {
  nextIndex: number;
  assigned: Map<string, number>;
};

type ToolCallState = Map<number, ChoiceIndexState>;
type MutableToolCall = Record<string, unknown> & { index?: number | string };

type StreamState = {
  toolCallState: ToolCallState;
  sawToolCallsFinish: boolean; // Track if we've seen finish_reason: "tool_calls"
  chunkCount: number; // Count chunks for debugging
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.log("[tool-call-patch]", ...args);
  }
}

function getChoiceState(state: ToolCallState, choiceIndex: number) {
  let choiceState = state.get(choiceIndex);
  if (!choiceState) {
    choiceState = { nextIndex: 0, assigned: new Map() };
    state.set(choiceIndex, choiceState);
  }
  return choiceState;
}

function getToolCallKey(call: unknown) {
  if (!call || typeof call !== "object") return null;
  const maybeWithId = call as { id?: unknown; function?: { name?: unknown } };
  if (typeof maybeWithId.id === "string" && maybeWithId.id.length > 0) {
    return maybeWithId.id;
  }
  if (
    maybeWithId.function &&
    typeof maybeWithId.function === "object" &&
    typeof maybeWithId.function.name === "string" &&
    maybeWithId.function.name.length > 0
  ) {
    return `fn:${maybeWithId.function.name}`;
  }
  return null;
}

function ensureToolCallIndex(state: ChoiceIndexState, call: MutableToolCall) {
  let mutated = false;
  const key = getToolCallKey(call);

  // Convert string index to number if needed
  if (typeof call.index === "string") {
    const numIndex = parseInt(call.index, 10);
    debugLog("Converting string index to number:", call.index, "->", numIndex);
    call.index = numIndex;
    mutated = true;
  }

  if (typeof call.index === "number") {
    state.nextIndex = Math.max(state.nextIndex, call.index + 1);
    if (key) state.assigned.set(key, call.index);
    return mutated;
  }

  if (key && state.assigned.has(key)) {
    call.index = state.assigned.get(key);
    debugLog("Assigned index from key:", key, "->", call.index);
    return true;
  }

  const index = state.nextIndex++;
  call.index = index;
  if (key) state.assigned.set(key, index);
  debugLog("Assigned new index:", index, "for key:", key);
  mutated = true;
  return mutated;
}

function patchChunkPayload(payload: string, state: StreamState): { patched: string | null; shouldFilter: boolean } {
  try {
    const json = JSON.parse(payload);
    if (!json || typeof json !== "object") return { patched: null, shouldFilter: false };
    if (!Array.isArray((json as { choices?: unknown }).choices)) return { patched: null, shouldFilter: false };

    const choices = (json as { choices: Array<Record<string, unknown>> }).choices;
    
    debugLog("Processing chunk with", choices.length, "choices");
    
    // Check if this chunk should be filtered
    // If we've already seen tool_calls finish_reason, filter out subsequent empty chunks
    if (state.sawToolCallsFinish) {
      // Check if this is an empty delta with finish_reason: "stop" or null
      for (const choice of choices) {
        const delta = (choice as { delta?: Record<string, unknown> }).delta;
        const finishReason = choice.finish_reason;
        const toolCalls = delta?.tool_calls;
        
        // If there's no meaningful content (no tool_calls, empty or no content), skip this chunk
        if (!toolCalls || (Array.isArray(toolCalls) && toolCalls.length === 0)) {
          const content = delta?.content;
          if (!content || (typeof content === "string" && content === "")) {
            // This is an empty chunk after tool_calls, filter it out
            debugLog("Filtering empty chunk after tool_calls, finish_reason:", finishReason);
            return { patched: null, shouldFilter: true };
          }
        }
      }
    }

    let mutated = false;
    for (const choice of choices) {
      if (!choice || typeof choice !== "object") continue;
      
      // Track if we see finish_reason: "tool_calls"
      if (choice.finish_reason === "tool_calls") {
        debugLog("Detected finish_reason: tool_calls");
        state.sawToolCallsFinish = true;
      }
      
      const delta = (choice as { delta?: Record<string, unknown> }).delta;
      if (!delta || typeof delta !== "object") continue;
      const toolCalls = (delta as { tool_calls?: unknown }).tool_calls;
      if (!Array.isArray(toolCalls) || toolCalls.length === 0) continue;
      
      debugLog("Found", toolCalls.length, "tool_calls in delta");
      
      const stateForChoice = getChoiceState(
        state.toolCallState,
        typeof choice.index === "number" ? choice.index : 0,
      );
      for (const call of toolCalls) {
        if (!call || typeof call !== "object") continue;
        debugLog("Processing tool call:", JSON.stringify(call).slice(0, 200));
        mutated = ensureToolCallIndex(
          stateForChoice,
          call as MutableToolCall,
        ) || mutated;
      }
    }

    if (!mutated) {
      debugLog("No mutations needed");
      return { patched: null, shouldFilter: false };
    }
    debugLog("Chunk mutated, returning patched version");
    return { patched: JSON.stringify(json), shouldFilter: false };
  } catch {
    return { patched: null, shouldFilter: false };
  }
}

function transformEvent(event: string, state: StreamState): string | null {
  if (!event.trim()) return event;
  
  state.chunkCount++;
  debugLog(`[Chunk ${state.chunkCount}] Raw event:`, event.slice(0, 300));
  
  const lines = event.split("\n");
  const dataLines = lines.filter((line) => line.startsWith("data:"));
  if (dataLines.length === 0) return event;
  const payload = dataLines
    .map((line) => line.slice(5).replace(/^\s/, ""))
    .join("\n");
  if (!payload || payload === "[DONE]") {
    debugLog(`[Chunk ${state.chunkCount}] Payload is [DONE] or empty`);
    return event;
  }
  
  debugLog(`[Chunk ${state.chunkCount}] Payload:`, payload.slice(0, 500));
  
  const result = patchChunkPayload(payload, state);
  
  // If this chunk should be filtered out, return null
  if (result.shouldFilter) return null;
  
  // If no patching was done, return original
  if (!result.patched) return event;
  
  const otherLines = lines.filter((line) => !line.startsWith("data:"));
  const patchedLines = result.patched
    .split("\n")
    .map((line: string) => `data: ${line}`);
  return [...otherLines, ...patchedLines].join("\n");
}

function patchSseStream(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const state: StreamState = {
    toolCallState: new Map(),
    sawToolCallsFinish: false,
    chunkCount: 0,
  };
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.trim().length > 0) {
          const transformed = transformEvent(buffer, state);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(`${transformed}\n\n`));
          }
        }
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const transformed = transformEvent(event, state);
        // Only enqueue if not filtered out
        if (transformed !== null) {
          controller.enqueue(encoder.encode(`${transformed}\n\n`));
        }
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {});
    },
  });
}

type FetchInput = Parameters<FetchFunction>[0];
type FetchInit = Parameters<FetchFunction>[1];

/**
 * Recursively remove all "const" keys from a JSON object and convert to "enum"
 * This is needed because Gemini API doesn't support the "const" keyword in JSON Schema
 */
function transformConstToEnum(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  
  if (Array.isArray(obj)) {
    return obj.map(transformConstToEnum);
  }
  
  if (typeof obj !== 'object') {
    return obj;
  }

  const result: Record<string, unknown> = {};
  const objRecord = obj as Record<string, unknown>;

  for (const [key, value] of Object.entries(objRecord)) {
    if (key === 'const') {
      // Convert "const" to "enum" with single value
      result.enum = [value];
    } else if (value !== null && typeof value === 'object') {
      // Recursively transform nested objects
      result[key] = transformConstToEnum(value);
    } else {
      result[key] = value;
    }
  }

  return result;
}

/**
 * Transform the request body to make it Gemini-compatible
 */
function transformRequestBodyForGemini(body: string): string {
  try {
    const json = JSON.parse(body);
    
    // Only transform if there are tools
    if (!json.tools || !Array.isArray(json.tools)) {
      return body;
    }
    
    // Transform the tools array
    json.tools = transformConstToEnum(json.tools);
    
    const transformed = JSON.stringify(json);
    
    if (DEBUG) {
      // Check if any "const" remains
      const constCount = (transformed.match(/"const":/g) || []).length;
      if (constCount > 0) {
        console.log(`[tool-call-patch] WARNING: ${constCount} "const" keys still remain after transformation`);
      } else {
        console.log(`[tool-call-patch] Successfully removed all "const" keys from request body`);
      }
    }
    
    return transformed;
  } catch (e) {
    debugLog("Failed to parse/transform request body:", e);
    return body;
  }
}

export function createToolCallIndexPatchedFetch(
  baseFetch: FetchFunction,
): FetchFunction {
  const patchedFetch = async (input: FetchInput, init?: FetchInit) => {
    debugLog("=== Fetch Request ===");
    debugLog("URL:", typeof input === "string" ? input : input.toString());
    
    // Transform request body for Gemini compatibility (remove "const" keywords)
    if (init?.body && typeof init.body === 'string') {
      const transformedBody = transformRequestBodyForGemini(init.body);
      init = { ...init, body: transformedBody };
    }
    
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") || "";
    
    debugLog("Response status:", response.status);
    debugLog("Content-Type:", contentType);
    
    if (!contentType.includes("text/event-stream") || !response.body) {
      debugLog("Not SSE stream, passing through");
      return response;
    }
    
    debugLog("=== Patching SSE stream ===");
    const patchedStream = patchSseStream(response.body);
    const headers = new Headers(response.headers);
    return new Response(patchedStream, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
  
  return patchedFetch as FetchFunction;
}

