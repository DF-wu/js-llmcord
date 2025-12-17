import type { FetchFunction } from "@ai-sdk/provider-utils";

// ============================================================================
// Configuration / 配置層
// ============================================================================
//
// 這個區塊集中管理所有 patch 的配置，使得未來需要調整時只需修改這裡。
// 設計原則：配置與實現分離，提高可維護性。
//
// This section centralizes all patch configurations, making future adjustments
// easier by only requiring changes here. Design principle: Separation of
// configuration and implementation for better maintainability.
// ============================================================================

/**
 * JSON Schema 轉換配置
 * JSON Schema transformation configuration
 *
 * 用途：定義哪些 JSON Schema 關鍵字需要被移除或轉換，以符合特定 API 的要求。
 * Purpose: Define which JSON Schema keywords need to be removed or transformed
 * to comply with specific API requirements.
 *
 * 為什麼需要這個？
 * Why is this needed?
 * - Gemini API 不支援某些 JSON Schema 關鍵字（如 propertyNames, const 等）
 * - 直接發送會導致 400 錯誤："Unknown name 'propertyNames'"
 * - 需要在發送前轉換 schema 以確保相容性
 *
 * - Gemini API doesn't support certain JSON Schema keywords (like propertyNames, const, etc.)
 * - Sending them directly causes 400 errors: "Unknown name 'propertyNames'"
 * - Need to transform schema before sending to ensure compatibility
 *
 * 如何擴展？
 * How to extend?
 * 1. 發現新的不支援關鍵字時，添加到 keywordsToRemove
 * 2. 需要轉換（而非移除）時，添加到 keywordTransforms
 *
 * 1. When discovering new unsupported keywords, add to keywordsToRemove
 * 2. When transformation (not removal) is needed, add to keywordTransforms
 */
const SCHEMA_TRANSFORM_CONFIG = {
  /**
   * 需要完全移除的 JSON Schema 關鍵字
   * JSON Schema keywords to remove entirely
   *
   * 這些關鍵字在 Gemini API 中不被支援，會導致請求失敗。
   * These keywords are not supported in Gemini API and will cause request failures.
   *
   * 關鍵字說明：
   * Keyword descriptions:
   * - propertyNames: 驗證屬性名稱的模式 / Validates property name patterns
   * - patternProperties: 基於模式的屬性匹配 / Pattern-based property matching
   * - dependencies: 屬性依賴關係 / Property dependencies
   * - if/then/else: 條件式 schema / Conditional schemas
   * - not: Schema 否定 / Schema negation
   * - $ref, $id, $schema, $comment: Schema 引用和元數據 / Schema references and metadata
   */
  keywordsToRemove: new Set([
    "propertyNames",      // 最常見的錯誤來源 / Most common error source
    "patternProperties",
    "dependencies",
    "if", "then", "else",
    "not",
    "$ref", "$id", "$schema", "$comment",
  ]),

  /**
   * 需要轉換為相容形式的關鍵字
   * Keywords to transform to compatible equivalents
   *
   * 格式 / Format: { 原始關鍵字: (值) => ({ 替換關鍵字: 轉換後的值 }) }
   *
   * 為什麼 const 要轉換成 enum？
   * Why transform const to enum?
   * - Gemini API 不支援 "const" 關鍵字
   * - 但支援 "enum" 關鍵字
   * - const: "value" 等價於 enum: ["value"]（單一值的枚舉）
   *
   * - Gemini API doesn't support "const" keyword
   * - But supports "enum" keyword
   * - const: "value" is equivalent to enum: ["value"] (single-value enum)
   */
  keywordTransforms: {
    const: (value: unknown) => ({ enum: [value] }),
  },
} as const;

/**
 * SSE 串流修補行為配置
 * SSE stream patching behavior configuration
 *
 * 用途：控制如何處理 Server-Sent Events (SSE) 串流中的問題。
 * Purpose: Control how to handle issues in Server-Sent Events (SSE) streams.
 *
 * 為什麼需要這些配置？
 * Why are these configurations needed?
 *
 * 1. filterEmptyChunksAfterToolCalls:
 *    - 某些 provider 在 tool_calls 完成後會發送空的 chunk
 *    - 這會導致 AI SDK 的串流解析器出錯
 *    - 需要過濾掉這些多餘的空 chunk
 *
 *    - Some providers send empty chunks after tool_calls finish
 *    - This breaks AI SDK's stream parser
 *    - Need to filter out these extra empty chunks
 *
 * 2. assignMissingIndices:
 *    - 某些 provider 不會在串流的 tool call 中包含 index 欄位
 *    - AI SDK 需要 index 來正確組裝多個 tool call
 *    - 需要自動分配缺失的 index
 *
 *    - Some providers don't include index field in streaming tool calls
 *    - AI SDK needs index to correctly assemble multiple tool calls
 *    - Need to automatically assign missing indices
 */
const STREAM_PATCH_CONFIG = {
  /**
   * 是否過濾 tool_calls 完成後的空 chunk
   * Whether to filter empty chunks after tool_calls finish
   *
   * 設為 false 可能導致：串流解析錯誤
   * Setting to false may cause: Stream parsing errors
   */
  filterEmptyChunksAfterToolCalls: true,

  /**
   * 是否為缺失 index 的 tool call 自動分配索引
   * Whether to assign missing indices to tool calls
   *
   * 設為 false 可能導致：tool call 無法正確組裝
   * Setting to false may cause: Tool calls cannot be assembled correctly
   */
  assignMissingIndices: true,
} as const;

/**
 * Debug 模式開關
 * Debug mode switch
 *
 * 啟用方式 / How to enable:
 * - DEBUG=patch bun run index.ts
 * - DEBUG=* bun run index.ts
 *
 * 啟用後會輸出詳細的轉換和修補日誌
 * When enabled, outputs detailed transformation and patching logs
 */
const DEBUG = process.env.DEBUG?.includes("patch") || process.env.DEBUG === "*";

// ============================================================================
// Type Definitions / 類型定義
// ============================================================================
//
// 這個區塊定義所有內部使用的類型，確保類型安全。
// This section defines all internal types to ensure type safety.
// ============================================================================

/**
 * Choice 的索引狀態
 * Index state for a choice
 *
 * 用途：追蹤單個 choice 中 tool call 的索引分配狀態。
 * Purpose: Track index assignment state for tool calls in a single choice.
 *
 * 為什麼需要這個？
 * Why is this needed?
 * - 在串流中，同一個 tool call 可能分多個 chunk 發送
 * - 需要確保同一個 tool call 在所有 chunk 中使用相同的 index
 * - 使用 Map 來記住已分配的 index，避免重複分配
 *
 * - In streaming, the same tool call may be sent across multiple chunks
 * - Need to ensure the same tool call uses the same index across all chunks
 * - Use Map to remember assigned indices and avoid duplicate assignments
 */
type ChoiceIndexState = {
  /** 下一個可用的索引號碼 / Next available index number */
  nextIndex: number;
  /** 已分配的索引映射表（key -> index） / Assigned index mapping (key -> index) */
  assigned: Map<string, number>;
};

/**
 * 所有 choice 的工具呼叫狀態
 * Tool call state for all choices
 *
 * Map<choice的index, 該choice的索引狀態>
 * Map<choice index, index state for that choice>
 */
type ToolCallState = Map<number, ChoiceIndexState>;

/**
 * 可變的 tool call 物件
 * Mutable tool call object
 *
 * 用途：表示一個可以被修改的 tool call，主要是添加或修改 index 欄位。
 * Purpose: Represents a tool call that can be modified, mainly for adding/modifying the index field.
 */
type MutableToolCall = Record<string, unknown> & { index?: number | string };

/**
 * 串流處理狀態
 * Stream processing state
 *
 * 用途：在處理整個 SSE 串流時維護的狀態。
 * Purpose: State maintained while processing the entire SSE stream.
 *
 * 為什麼需要維護狀態？
 * Why maintain state?
 * - SSE 串流是逐 chunk 處理的，需要跨 chunk 記住狀態
 * - 例如：記住是否已經看到 finish_reason: "tool_calls"
 * - 例如：記住每個 tool call 已分配的 index
 *
 * - SSE stream is processed chunk by chunk, need to remember state across chunks
 * - Example: Remember if we've seen finish_reason: "tool_calls"
 * - Example: Remember assigned indices for each tool call
 */
type StreamState = {
  /** 所有 choice 的 tool call 索引狀態 / Tool call index state for all choices */
  toolCallState: ToolCallState;
  /** 是否已看到 finish_reason: "tool_calls" / Whether we've seen finish_reason: "tool_calls" */
  sawToolCallsFinish: boolean;
  /** 已處理的 chunk 數量（用於 debug） / Number of chunks processed (for debugging) */
  chunkCount: number;
};

/**
 * Fetch 函數的輸入參數類型
 * Input parameter type for fetch function
 */
type FetchInput = Parameters<FetchFunction>[0];

/**
 * Fetch 函數的初始化選項類型
 * Initialization options type for fetch function
 */
type FetchInit = Parameters<FetchFunction>[1];

/**
 * Tool Call Patch 的選項配置
 * Options configuration for Tool Call Patch
 *
 * 用途：允許使用者自定義 patch 的行為。
 * Purpose: Allow users to customize patch behavior.
 *
 * 使用範例 / Usage example:
 * ```typescript
 * createToolCallIndexPatchedFetch(fetch, {
 *   transformConstToEnum: true,
 *   patchToolCallIndex: true,
 *   additionalKeywordsToRemove: ["myCustomKeyword"],
 *   customKeywordTransforms: {
 *     myKeyword: (value) => ({ replacement: value })
 *   }
 * })
 * ```
 */
export type ToolCallPatchOptions = {
  /**
   * 是否轉換 JSON Schema 以符合 provider 要求
   * Whether to transform JSON Schema to be compatible with the provider
   *
   * 設為 false 時：不會移除或轉換任何 JSON Schema 關鍵字
   * When set to false: Won't remove or transform any JSON Schema keywords
   *
   * @default true
   */
  transformConstToEnum?: boolean;

  /**
   * 是否修補串流響應中的 tool call 索引
   * Whether to patch tool call indices in streaming responses
   *
   * 設為 false 時：不會分配缺失的 index，也不會過濾空 chunk
   * When set to false: Won't assign missing indices or filter empty chunks
   *
   * @default true
   */
  patchToolCallIndex?: boolean;

  /**
   * 額外需要移除的 JSON Schema 關鍵字（在預設清單之外）
   * Custom keywords to remove from JSON Schema (in addition to defaults)
   *
   * 使用場景：當發現新的不支援關鍵字時，可以在這裡添加而不需要修改原始碼
   * Use case: When discovering new unsupported keywords, add them here without modifying source code
   *
   * @default []
   * @example ["myUnsupportedKeyword", "anotherKeyword"]
   */
  additionalKeywordsToRemove?: string[];

  /**
   * 自定義關鍵字轉換規則
   * Custom keyword transformations
   *
   * 使用場景：當需要將某個關鍵字轉換為另一種形式（而非直接移除）
   * Use case: When needing to transform a keyword to another form (instead of removing)
   *
   * @default {}
   * @example { myKeyword: (value) => ({ replacement: transformValue(value) }) }
   */
  customKeywordTransforms?: Record<string, (value: unknown) => Record<string, unknown>>;
};

// ============================================================================
// Utility Functions / 工具函數層
// ============================================================================
//
// 這個區塊提供防禦性的工具函數，確保在處理未知結構時不會崩潰。
// 設計原則：永遠不要假設數據結構是正確的，總是驗證後再使用。
//
// This section provides defensive utility functions to ensure no crashes
// when handling unknown structures. Design principle: Never assume data
// structure is correct, always validate before use.
// ============================================================================

/**
 * 文字編碼器（用於 SSE 串流）
 * Text encoder (for SSE streams)
 */
const encoder = new TextEncoder();

/**
 * 文字解碼器（用於 SSE 串流）
 * Text decoder (for SSE streams)
 */
const decoder = new TextDecoder();

/**
 * Debug 日誌輸出函數
 * Debug logging function
 *
 * 用途：在 DEBUG 模式下輸出詳細日誌，幫助診斷問題。
 * Purpose: Output detailed logs in DEBUG mode to help diagnose issues.
 *
 * 只有在 DEBUG=patch 或 DEBUG=* 時才會輸出
 * Only outputs when DEBUG=patch or DEBUG=*
 *
 * @param args - 要輸出的參數 / Arguments to output
 */
function debugLog(...args: unknown[]) {
  if (DEBUG) {
    console.log("[tool-call-patch]", ...args);
  }
}

/**
 * 安全地訪問嵌套屬性（帶類型檢查）
 * Safely access nested properties with type checking
 *
 * 用途：防禦性地訪問深層嵌套的屬性，避免 "Cannot read property of undefined" 錯誤。
 * Purpose: Defensively access deeply nested properties to avoid "Cannot read property of undefined" errors.
 *
 * 為什麼需要這個？
 * Why is this needed?
 * - AI SDK 或 provider 的響應結構可能會改變
 * - 直接訪問 obj.a.b.c 可能在任何一層崩潰
 * - 使用這個函數可以安全地訪問，失敗時返回 undefined
 *
 * - AI SDK or provider response structure may change
 * - Direct access like obj.a.b.c may crash at any level
 * - Using this function allows safe access, returning undefined on failure
 *
 * 使用範例 / Usage example:
 * ```typescript
 * // 不安全 / Unsafe:
 * const name = json.choices[0].delta.tool_calls[0].function.name;  // 可能崩潰 / May crash
 *
 * // 安全 / Safe:
 * const name = safeGet<string>(json, ["choices", "0", "delta", "tool_calls", "0", "function", "name"]);
 * if (name === undefined) {
 *   // 處理缺失的情況 / Handle missing case
 * }
 * ```
 *
 * @param obj - 要訪問的物件 / Object to access
 * @param path - 屬性路徑陣列 / Array of property path
 * @returns 屬性值或 undefined / Property value or undefined
 */
function safeGet<T>(obj: unknown, path: string[]): T | undefined {
  let current: unknown = obj;
  for (const key of path) {
    // 檢查當前值是否可以繼續訪問
    // Check if current value can be further accessed
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current as T;
}

/**
 * 檢查值是否為有效的陣列（非空）
 * Check if a value is a valid array (non-empty)
 *
 * 用途：驗證一個值不僅是陣列，而且有內容。
 * Purpose: Verify a value is not only an array, but also has content.
 *
 * 為什麼要檢查長度？
 * Why check length?
 * - 空陣列通常表示沒有數據，不需要處理
 * - 可以避免不必要的迴圈和處理
 *
 * - Empty arrays usually mean no data, no need to process
 * - Can avoid unnecessary loops and processing
 *
 * @param value - 要檢查的值 / Value to check
 * @returns 是否為非空陣列 / Whether it's a non-empty array
 *
 * @example
 * isValidArray([1, 2, 3])  // true
 * isValidArray([])         // false
 * isValidArray(null)       // false
 * isValidArray("string")   // false
 */
function isValidArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

/**
 * 檢查值是否為純物件（非 null、非陣列）
 * Check if a value is a plain object (not null, not array)
 *
 * 用途：驗證一個值是可以安全訪問屬性的物件。
 * Purpose: Verify a value is an object that can safely access properties.
 *
 * 為什麼要排除 null 和陣列？
 * Why exclude null and arrays?
 * - typeof null === "object" 是 JavaScript 的歷史遺留問題
 * - 陣列也是 object，但我們需要區分它們
 * - 只有純物件才能用 obj.property 或 obj["property"] 訪問
 *
 * - typeof null === "object" is a historical JavaScript quirk
 * - Arrays are also objects, but we need to distinguish them
 * - Only plain objects can be accessed with obj.property or obj["property"]
 *
 * @param value - 要檢查的值 / Value to check
 * @returns 是否為純物件 / Whether it's a plain object
 *
 * @example
 * isPlainObject({a: 1})    // true
 * isPlainObject([1, 2])    // false
 * isPlainObject(null)      // false
 * isPlainObject("string")  // false
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ============================================================================
// JSON Schema Transformation / JSON Schema 轉換層
// ============================================================================
//
// 這個區塊負責將 JSON Schema 轉換為 provider 相容的格式。
// 核心策略：遞迴遍歷整個 schema 樹，移除或轉換不支援的關鍵字。
//
// This section transforms JSON Schema to provider-compatible format.
// Core strategy: Recursively traverse the entire schema tree, removing or
// transforming unsupported keywords.
// ============================================================================

/**
 * 遞迴轉換 JSON Schema 以符合 provider 要求
 * Recursively transform JSON Schema to be compatible with provider requirements
 *
 * 用途：這是核心轉換函數，處理所有 JSON Schema 的轉換邏輯。
 * Purpose: This is the core transformation function handling all JSON Schema transformation logic.
 *
 * 設計原則：
 * Design principles:
 * 1. 遞迴處理：能處理任意深度的嵌套結構
 * 2. 防禦性：對任何意外結構都能安全處理
 * 3. 可配置：透過 options 參數控制行為
 * 4. 不可變：不修改原始物件，返回新物件
 *
 * 1. Recursive: Can handle arbitrarily nested structures
 * 2. Defensive: Safely handles any unexpected structures
 * 3. Configurable: Behavior controlled via options parameter
 * 4. Immutable: Doesn't modify original object, returns new object
 *
 * 處理流程：
 * Processing flow:
 * 1. 基本類型（string, number, boolean, null）→ 直接返回
 * 2. 陣列 → 遞迴處理每個元素
 * 3. 物件 → 遍歷每個屬性：
 *    a. 如果是要移除的關鍵字 → 跳過（不加入結果）
 *    b. 如果是要轉換的關鍵字 → 應用轉換函數
 *    c. 如果是嵌套物件/陣列 → 遞迴處理
 *    d. 其他 → 直接複製
 *
 * 1. Primitives (string, number, boolean, null) → Return directly
 * 2. Arrays → Recursively process each element
 * 3. Objects → Iterate each property:
 *    a. If keyword to remove → Skip (don't add to result)
 *    b. If keyword to transform → Apply transformation function
 *    c. If nested object/array → Recursively process
 *    d. Others → Copy directly
 *
 * @param obj - 要轉換的物件 / Object to transform
 * @param options - 轉換選項 / Transformation options
 * @param options.keywordsToRemove - 要移除的關鍵字集合 / Set of keywords to remove
 * @param options.keywordTransforms - 關鍵字轉換函數映射 / Keyword transformation function mapping
 * @returns 轉換後的物件 / Transformed object
 *
 * @example
 * // 輸入 / Input:
 * {
 *   type: "object",
 *   properties: {
 *     name: { type: "string", const: "John" },
 *     age: { type: "number" }
 *   },
 *   propertyNames: { pattern: "^[a-z]+$" }
 * }
 *
 * // 輸出 / Output:
 * {
 *   type: "object",
 *   properties: {
 *     name: { type: "string", enum: ["John"] },  // const → enum
 *     age: { type: "number" }
 *   }
 *   // propertyNames 被移除 / propertyNames removed
 * }
 */
function transformJsonSchema(
  obj: unknown,
  options: {
    keywordsToRemove: Set<string>;
    keywordTransforms: Record<string, (value: unknown) => Record<string, unknown>>;
  }
): unknown {
  // 處理基本類型和 null/undefined
  // Handle primitives and null/undefined
  // 這些值不需要轉換，直接返回
  // These values don't need transformation, return directly
  if (obj === null || obj === undefined || typeof obj !== "object") {
    return obj;
  }

  // 處理陣列：遞迴轉換每個元素
  // Handle arrays: recursively transform each element
  // JSON Schema 中陣列常見於 enum, anyOf, oneOf, allOf 等
  // Arrays in JSON Schema are common in enum, anyOf, oneOf, allOf, etc.
  if (Array.isArray(obj)) {
    return obj.map((item) => transformJsonSchema(item, options));
  }

  // 處理物件：這是主要的轉換邏輯
  // Handle objects: this is the main transformation logic
  const result: Record<string, unknown> = {};
  const objRecord = obj as Record<string, unknown>;

  for (const [key, value] of Object.entries(objRecord)) {
    // 情況 1：需要移除的關鍵字
    // Case 1: Keywords to remove
    // 使用 continue 跳過，不加入結果物件
    // Use continue to skip, don't add to result object
    if (options.keywordsToRemove.has(key)) {
      debugLog(`Removing unsupported keyword: ${key}`);
      continue;
    }

    // 情況 2：需要轉換的關鍵字
    // Case 2: Keywords to transform
    // 例如：const: "value" → enum: ["value"]
    // Example: const: "value" → enum: ["value"]
    if (key in options.keywordTransforms) {
      const transform = options.keywordTransforms[key];
      const transformed = transform(value);
      // 使用 Object.assign 將轉換結果合併到 result
      // Use Object.assign to merge transformation result into result
      // 這允許一個關鍵字轉換為多個關鍵字
      // This allows one keyword to transform into multiple keywords
      Object.assign(result, transformed);
      debugLog(`Transformed keyword "${key}" to:`, Object.keys(transformed).join(", "));
      continue;
    }

    // 情況 3：嵌套的物件或陣列
    // Case 3: Nested objects or arrays
    // 遞迴處理以確保深層的關鍵字也被轉換
    // Recursively process to ensure deep keywords are also transformed
    if (value !== null && typeof value === "object") {
      result[key] = transformJsonSchema(value, options);
    } else {
      // 情況 4：其他值（字串、數字、布林等）
      // Case 4: Other values (strings, numbers, booleans, etc.)
      // 直接複製，不需要轉換
      // Copy directly, no transformation needed
      result[key] = value;
    }
  }

  return result;
}

/**
 * Transform request body to be compatible with provider
 * Defensive: returns original body if transformation fails
 */
function transformRequestBody(
  body: string,
  options: {
    keywordsToRemove: Set<string>;
    keywordTransforms: Record<string, (value: unknown) => Record<string, unknown>>;
  }
): string {
  try {
    const json = JSON.parse(body);

    // Only transform if there are tools
    const tools = safeGet<unknown[]>(json, ["tools"]);
    if (!isValidArray(tools)) {
      debugLog("No tools array found, skipping transformation");
      return body;
    }

    // Transform the tools array
    json.tools = transformJsonSchema(tools, options);

    const transformed = JSON.stringify(json);

    // Validation in debug mode
    if (DEBUG) {
      validateTransformation(transformed, options.keywordsToRemove);
    }

    return transformed;
  } catch (e) {
    debugLog("Failed to parse/transform request body:", e);
    // Return original body on error - defensive behavior
    return body;
  }
}

/**
 * Validate that transformation removed all unsupported keywords
 * Only runs in debug mode
 */
function validateTransformation(transformed: string, keywordsToRemove: Set<string>) {
  const remainingIssues: string[] = [];

  for (const keyword of keywordsToRemove) {
    const pattern = new RegExp(`"${keyword}":`, "g");
    const matches = transformed.match(pattern);
    if (matches && matches.length > 0) {
      remainingIssues.push(`${keyword} (${matches.length})`);
    }
  }

  // Also check for "const" which should be transformed
  const constMatches = transformed.match(/"const":/g);
  if (constMatches && constMatches.length > 0) {
    remainingIssues.push(`const (${constMatches.length})`);
  }

  if (remainingIssues.length > 0) {
    console.log(`[tool-call-patch] WARNING: Unsupported keywords still remain: ${remainingIssues.join(", ")}`);
  } else {
    console.log(`[tool-call-patch] Successfully removed all unsupported keywords from request body`);
  }
}

// ============================================================================
// Tool Call Index Assignment
// ============================================================================

function getChoiceState(state: ToolCallState, choiceIndex: number): ChoiceIndexState {
  let choiceState = state.get(choiceIndex);
  if (!choiceState) {
    choiceState = { nextIndex: 0, assigned: new Map() };
    state.set(choiceIndex, choiceState);
  }
  return choiceState;
}

/**
 * Generate a stable key for a tool call
 * Defensive: returns null if call structure is invalid
 */
function getToolCallKey(call: unknown): string | null {
  if (!isPlainObject(call)) return null;

  // Prefer ID if available
  const id = safeGet<string>(call, ["id"]);
  if (typeof id === "string" && id.length > 0) {
    return id;
  }

  // Fallback to function name
  const functionName = safeGet<string>(call, ["function", "name"]);
  if (typeof functionName === "string" && functionName.length > 0) {
    return `fn:${functionName}`;
  }

  return null;
}

/**
 * Ensure a tool call has a valid index
 * Defensive: handles invalid indices gracefully
 *
 * @returns true if the call was mutated, false otherwise
 */
function ensureToolCallIndex(state: ChoiceIndexState, call: MutableToolCall): boolean {
  let mutated = false;
  const key = getToolCallKey(call);

  // Convert string index to number if needed
  if (typeof call.index === "string") {
    const numIndex = parseInt(call.index, 10);
    if (!isNaN(numIndex) && isFinite(numIndex)) {
      debugLog("Converting string index to number:", call.index, "->", numIndex);
      call.index = numIndex;
      mutated = true;
    } else {
      debugLog("Invalid string index (NaN/Infinity), will assign new index:", call.index);
      call.index = undefined;
    }
  }

  // If we have a valid numeric index, update state and return
  if (typeof call.index === "number" && !isNaN(call.index) && isFinite(call.index)) {
    state.nextIndex = Math.max(state.nextIndex, call.index + 1);
    if (key) state.assigned.set(key, call.index);
    return mutated;
  }

  // Try to reuse index from previous occurrence of same tool call
  if (key && state.assigned.has(key)) {
    call.index = state.assigned.get(key);
    debugLog("Assigned index from key:", key, "->", call.index);
    return true;
  }

  // Assign new index
  const index = state.nextIndex++;
  call.index = index;
  if (key) state.assigned.set(key, index);
  debugLog("Assigned new index:", index, "for key:", key);
  return true;
}

// ============================================================================
// SSE Stream Patching
// ============================================================================

/**
 * Patch a single chunk payload
 * Defensive: returns original if structure is unexpected
 */
function patchChunkPayload(
  payload: string,
  state: StreamState
): { patched: string | null; shouldFilter: boolean } {
  try {
    const json = JSON.parse(payload);

    // Defensive: check for expected structure
    const choices = safeGet<unknown[]>(json, ["choices"]);
    if (!isValidArray(choices)) {
      return { patched: null, shouldFilter: false };
    }

    debugLog("Processing chunk with", choices.length, "choices");

    // Check if this chunk should be filtered
    if (STREAM_PATCH_CONFIG.filterEmptyChunksAfterToolCalls && state.sawToolCallsFinish) {
      const shouldFilter = shouldFilterEmptyChunk(choices);
      if (shouldFilter) {
        debugLog("Filtering empty chunk after tool_calls");
        return { patched: null, shouldFilter: true };
      }
    }

    // Patch tool call indices if needed
    let mutated = false;
    if (STREAM_PATCH_CONFIG.assignMissingIndices) {
      mutated = patchToolCallIndices(choices, state);
    }

    if (!mutated) {
      debugLog("No mutations needed");
      return { patched: null, shouldFilter: false };
    }

    debugLog("Chunk mutated, returning patched version");
    return { patched: JSON.stringify(json), shouldFilter: false };
  } catch (e) {
    debugLog("Failed to parse/patch chunk:", e);
    // Defensive: return original on error
    return { patched: null, shouldFilter: false };
  }
}

/**
 * Check if a chunk should be filtered out
 * Defensive: handles unexpected structures
 */
function shouldFilterEmptyChunk(choices: unknown[]): boolean {
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;

    const delta = safeGet<Record<string, unknown>>(choice, ["delta"]);
    if (!isPlainObject(delta)) continue;

    const toolCalls = safeGet<unknown[]>(delta, ["tool_calls"]);
    const content = safeGet<string>(delta, ["content"]);

    // If there are tool calls, don't filter
    if (isValidArray(toolCalls)) {
      return false;
    }

    // If there's non-empty content, don't filter
    if (typeof content === "string" && content.length > 0) {
      return false;
    }
  }

  // All choices are empty, filter this chunk
  return true;
}

/**
 * Patch tool call indices in choices
 * Defensive: handles unexpected structures
 *
 * @returns true if any mutations were made
 */
function patchToolCallIndices(choices: unknown[], state: StreamState): boolean {
  let mutated = false;

  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;

    // Track finish_reason
    const finishReason = safeGet<string>(choice, ["finish_reason"]);
    if (finishReason === "tool_calls") {
      debugLog("Detected finish_reason: tool_calls");
      state.sawToolCallsFinish = true;
    }

    // Get tool calls from delta
    const delta = safeGet<Record<string, unknown>>(choice, ["delta"]);
    if (!isPlainObject(delta)) continue;

    const toolCalls = safeGet<unknown[]>(delta, ["tool_calls"]);
    if (!isValidArray(toolCalls)) continue;

    debugLog("Found", toolCalls.length, "tool_calls in delta");

    // Get or create state for this choice
    const choiceIndex = safeGet<number>(choice, ["index"]) ?? 0;
    const stateForChoice = getChoiceState(state.toolCallState, choiceIndex);

    // Patch each tool call
    for (const call of toolCalls) {
      if (!isPlainObject(call)) continue;
      debugLog("Processing tool call:", JSON.stringify(call).slice(0, 200));
      const wasMutated = ensureToolCallIndex(stateForChoice, call as MutableToolCall);
      mutated = mutated || wasMutated;
    }
  }

  return mutated;
}

/**
 * Transform a single SSE event
 * Defensive: returns original if structure is unexpected
 */
function transformEvent(event: string, state: StreamState): string | null {
  if (!event.trim()) return event;

  state.chunkCount++;
  debugLog(`[Chunk ${state.chunkCount}] Raw event:`, event.slice(0, 300));

  // Parse SSE format
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

  // Filter out if needed
  if (result.shouldFilter) return null;

  // Return original if no patching was done
  if (!result.patched) return event;

  // Reconstruct SSE event with patched payload
  const otherLines = lines.filter((line) => !line.startsWith("data:"));
  const patchedLines = result.patched
    .split("\n")
    .map((line: string) => `data: ${line}`);
  return [...otherLines, ...patchedLines].join("\n");
}

/**
 * Patch an SSE stream
 * Defensive: handles stream errors gracefully
 */
function patchSseStream(stream: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const state: StreamState = {
    toolCallState: new Map(),
    sawToolCallsFinish: false,
    chunkCount: 0,
  };
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          // Flush remaining buffer
          if (buffer.trim().length > 0) {
            const transformed = transformEvent(buffer, state);
            if (transformed !== null) {
              controller.enqueue(encoder.encode(`${transformed}\n\n`));
            }
          }
          controller.close();
          return;
        }

        // Decode and normalize line endings
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        // Process complete events (separated by \n\n)
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const transformed = transformEvent(event, state);
          if (transformed !== null) {
            controller.enqueue(encoder.encode(`${transformed}\n\n`));
          }
        }
      } catch (error) {
        debugLog("Error in stream processing:", error);
        controller.error(error);
      }
    },
    cancel(reason) {
      reader.cancel(reason).catch(() => {
        // Ignore cancellation errors
      });
    },
  });
}

// ============================================================================
// Main Export
// ============================================================================

/**
 * Create a patched fetch function that transforms requests and responses
 * to be compatible with providers that have non-standard behavior
 *
 * This function is designed to be resilient to:
 * - Changes in AI SDK internal structure
 * - Changes in provider response format
 * - Unexpected data structures
 *
 * @param baseFetch - The original fetch function to wrap
 * @param options - Patch options
 * @returns Patched fetch function
 */
export function createToolCallIndexPatchedFetch(
  baseFetch: FetchFunction,
  options?: ToolCallPatchOptions,
): FetchFunction {
  const {
    transformConstToEnum: shouldTransformTools = true,
    patchToolCallIndex: shouldPatchToolCalls = true,
    additionalKeywordsToRemove = [],
    customKeywordTransforms = {},
  } = options ?? {};

  // Build transformation config
  const keywordsToRemove = new Set([
    ...SCHEMA_TRANSFORM_CONFIG.keywordsToRemove,
    ...additionalKeywordsToRemove,
  ]);

  const keywordTransforms = {
    ...SCHEMA_TRANSFORM_CONFIG.keywordTransforms,
    ...customKeywordTransforms,
  };

  const patchedFetch = async (input: FetchInput, init?: FetchInit) => {
    debugLog("=== Fetch Request ===");
    debugLog("URL:", typeof input === "string" ? input : input.toString());

    // Transform request body if needed
    if (shouldTransformTools && init?.body && typeof init.body === "string") {
      const transformedBody = transformRequestBody(init.body, {
        keywordsToRemove,
        keywordTransforms,
      });
      init = { ...init, body: transformedBody };
    }

    // Execute request
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") || "";

    debugLog("Response status:", response.status);
    debugLog("Content-Type:", contentType);

    // Skip patching if disabled
    if (!shouldPatchToolCalls) {
      debugLog("Tool-call patch disabled, passing through response");
      return response;
    }

    // Only patch SSE streams
    if (!contentType.includes("text/event-stream") || !response.body) {
      debugLog("Not SSE stream, passing through");
      return response;
    }

    // Patch the stream
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

// ============================================================================
// Exports for Testing
// ============================================================================

/**
 * Export internal functions for testing
 * These are not part of the public API
 */
export const __internal = DEBUG ? {
  transformJsonSchema,
  ensureToolCallIndex,
  getToolCallKey,
  safeGet,
  isValidArray,
  isPlainObject,
  shouldFilterEmptyChunk,
  patchToolCallIndices,
} : undefined;
