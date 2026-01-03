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
 *    - ⚠️ 警告：這個功能可能導致正常響應被過濾，建議設為 false
 *
 *    - Some providers send empty chunks after tool_calls finish
 *    - This breaks AI SDK's stream parser
 *    - Need to filter out these extra empty chunks
 *    - ⚠️ Warning: This feature may cause normal responses to be filtered, recommend setting to false
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
   * ⚠️ 目前設為 false 以避免過度過濾
   * ⚠️ Currently set to false to avoid over-filtering
   *
   * 設為 true 可能導致：正常響應被錯誤過濾
   * Setting to true may cause: Normal responses being incorrectly filtered
   */
  filterEmptyChunksAfterToolCalls: false,

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
 * Gemini 3 thought_signature 狀態管理
 * Gemini 3 thought_signature state management
 *
 * 用途：在請求/響應循環間保存 thought_signature
 * Purpose: Preserve thought_signature across request/response cycles
 *
 * 為什麼需要這個？
 * Why is this needed?
 * - Gemini 3 模型在 function calling 時會返回 thought_signature
 * - 必須在下一次請求中將這個 signature 傳回給 API
 * - 缺少 signature 會導致 400 錯誤："Function call is missing a thought_signature"
 *
 * - Gemini 3 models return thought_signature during function calling
 * - This signature MUST be passed back to the API in the next request
 * - Missing signature causes 400 error: "Function call is missing a thought_signature"
 *
 * @example
 * const state: ThoughtSignatureState = { value: undefined };
 * // After extracting from response:
 * state.value = "encrypted_signature_string";
 * // In next request, inject this value
 */
type ThoughtSignatureState = {
  /**
   * 最近提取的 thought_signature 值（加密字符串，不可修改）
   * Most recently extracted thought_signature value (encrypted string, immutable)
   */
  value: string | undefined;
};

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
 * - 例如：從響應中提取 thought_signature（Gemini 3 專用）
 *
 * - SSE stream is processed chunk by chunk, need to remember state across chunks
 * - Example: Remember if we've seen finish_reason: "tool_calls"
 * - Example: Remember assigned indices for each tool call
 * - Example: Extract thought_signature from response (Gemini 3 specific)
 */
type StreamState = {
  /** 所有 choice 的 tool call 索引狀態 / Tool call index state for all choices */
  toolCallState: ToolCallState;
  /** 是否已看到 finish_reason: "tool_calls" / Whether we've seen finish_reason: "tool_calls" */
  sawToolCallsFinish: boolean;
  /** 已處理的 chunk 數量（用於 debug） / Number of chunks processed (for debugging) */
  chunkCount: number;
  /**
   * 從當前串流中提取的 thought_signature（如果有）
   * Thought signature extracted from current stream (if any)
   *
   * Gemini 3 專用：function calling 時會在響應中包含此字段
   * Gemini 3 specific: Included in responses during function calling
   */
  thoughtSignature: string | undefined;
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
   * 是否處理 Gemini 3 的 thought_signature（思考簽名）
   * Whether to handle Gemini 3's thought_signature
   *
   * 用途：為 Gemini 3 Flash/Pro 模型啟用 function calling 支援
   * Purpose: Enable function calling support for Gemini 3 Flash/Pro models
   *
   * 啟用時的行為：
   * When enabled:
   * - 從響應的 SSE chunk 中提取 thought_signature 字段
   * - 將提取的 signature 存儲在閉包狀態中
   * - 在下一次請求時，將 signature 注入到 assistant message 的 tool_calls 中
   * - 注入位置：tool_calls[0].extra_content.google.thought_signature
   *
   * - Extract thought_signature field from response SSE chunks
   * - Store extracted signature in closure state
   * - In next request, inject signature into assistant message's tool_calls
   * - Injection location: tool_calls[0].extra_content.google.thought_signature
   *
   * 為什麼需要這個？
   * Why is this needed?
   * - Gemini 3 在使用 function calling 時強制要求 thought_signature
   * - 缺少此字段會導致 400 錯誤："Function call is missing a thought_signature"
   * - 這是 Gemini 3 的新要求，Gemini 2.5 不需要
   *
   * - Gemini 3 strictly requires thought_signature when using function calling
   * - Missing this field causes 400 error: "Function call is missing a thought_signature"
   * - This is a new requirement for Gemini 3, not needed for Gemini 2.5
   *
   * 設為 false 時：
   * When set to false:
   * - 不會提取或注入 thought_signature
   * - Gemini 3 的 function calling 會失敗
   * - 其他 provider 不受影響
   *
   * - Won't extract or inject thought_signature
   * - Gemini 3 function calling will fail
   * - Other providers are not affected
   *
   * @default false
   */
  handleThoughtSignature?: boolean;

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
 * 檢查值是否為陣列（可以為空）
 * Check if a value is an array (can be empty)
 *
 * 用途：驗證一個值是陣列類型，不管是否有內容。
 * Purpose: Verify a value is an array type, regardless of whether it has content.
 *
 * @param value - 要檢查的值 / Value to check
 * @returns 是否為陣列 / Whether it's an array
 *
 * @example
 * isArray([1, 2, 3])  // true
 * isArray([])         // true
 * isArray(null)       // false
 * isArray("string")   // false
 */
function isArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
 * - 某些情況下需要確保陣列有內容才處理
 * - 可以避免不必要的迴圈和處理
 *
 * - In some cases need to ensure array has content before processing
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
// Gemini 3 thought_signature Support / Gemini 3 思考簽名支援
// ============================================================================
//
// 這個區塊提供 Gemini 3 thought_signature 的提取和注入功能。
// This section provides extraction and injection for Gemini 3 thought_signature.
//
// 背景 / Background:
// - Gemini 3 模型在 function calling 時會返回 thought_signature
// - 必須在下一次請求時將此 signature 傳回，否則會報 400 錯誤
// - Gemini 3 models return thought_signature during function calling
// - This signature MUST be passed back in next request, or 400 error occurs
//
// 處理流程 / Processing flow:
// 1. 提取：從 SSE response chunk 中找到 thought_signature
// 2. 存儲：保存在閉包狀態中（跨請求持久化）
// 3. 注入：在下一次請求時注入到 message history 中
//
// 1. Extract: Find thought_signature from SSE response chunks
// 2. Store: Save in closure state (persists across requests)
// 3. Inject: Inject into message history in next request
// ============================================================================

/**
 * 從 SSE chunk 的 choices 中提取 thought_signature
 * Extract thought_signature from SSE chunk choices
 *
 * 用途：檢查多個可能的位置以提取 Gemini 3 的 thought_signature
 * Purpose: Check multiple possible locations to extract Gemini 3's thought_signature
 *
 * 為什麼需要檢查多個位置？
 * Why check multiple locations?
 * - OpenAI-compatible API 的格式可能會變化
 * - Gemini 可能將 signature 放在不同的嵌套層級
 * - 通過檢查多個位置來確保兼容性
 *
 * - OpenAI-compatible API format may vary
 * - Gemini might place signature at different nesting levels
 * - Checking multiple locations ensures compatibility
 *
 * 檢查位置 / Check locations:
 * 1. choices[i].delta.thought_signature (直接在 delta 層級)
 * 2. choices[i].delta.tool_calls[0].extra_content.google.thought_signature (嵌套在 tool_calls 中)
 *
 * 1. choices[i].delta.thought_signature (direct at delta level)
 * 2. choices[i].delta.tool_calls[0].extra_content.google.thought_signature (nested in tool_calls)
 *
 * 防禦性設計 / Defensive design:
 * - 使用 safeGet() 安全訪問嵌套屬性
 * - 驗證類型（必須是非空字符串）
 * - 如果找不到則返回 undefined
 *
 * - Use safeGet() for safe nested property access
 * - Validate type (must be non-empty string)
 * - Return undefined if not found
 *
 * @param choices - SSE chunk 中的 choices 陣列 / Array of choice objects from SSE chunk
 * @returns 找到的 thought_signature 字符串，或 undefined / thought_signature string if found, or undefined
 *
 * @example
 * const choices = [{
 *   delta: {
 *     thought_signature: "encrypted_sig_123",
 *     tool_calls: [...]
 *   }
 * }];
 * const sig = extractThoughtSignature(choices);
 * // sig === "encrypted_sig_123"
 */
function extractThoughtSignature(choices: unknown[]): string | undefined {
  // 遍歷每個 choice（通常只有一個）
  // Iterate through each choice (usually only one)
  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;

    // 獲取 delta 物件（SSE streaming 格式）
    // Get delta object (SSE streaming format)
    const delta = safeGet<Record<string, unknown>>(choice, ["delta"]);
    if (!isPlainObject(delta)) continue;

    // 位置 1：直接在 delta 下（最可能的位置）
    // Location 1: Directly under delta (most likely location)
    // 格式：choices[0].delta.thought_signature
    const directSig = safeGet<string>(delta, ["thought_signature"]);
    if (typeof directSig === "string" && directSig.length > 0) {
      debugLog("[thought_signature] Found at delta.thought_signature");
      return directSig;
    }

    // 位置 2：嵌套在 tool_calls[0] 中（備選位置）
    // Location 2: Nested in tool_calls[0] (alternative location)
    // 格式：choices[0].delta.tool_calls[0].extra_content.google.thought_signature
    const toolCalls = safeGet<unknown[]>(delta, ["tool_calls"]);
    if (isValidArray(toolCalls)) {
      const firstCall = toolCalls[0];
      if (isPlainObject(firstCall)) {
        const nestedSig = safeGet<string>(firstCall, [
          "extra_content",
          "google",
          "thought_signature",
        ]);
        if (typeof nestedSig === "string" && nestedSig.length > 0) {
          debugLog("[thought_signature] Found at delta.tool_calls[0].extra_content.google");
          return nestedSig;
        }
      }
    }
  }

  // 沒有找到 thought_signature（這是正常的，如果不是 function calling 的話）
  // No thought_signature found (this is normal if not function calling)
  return undefined;
}

/**
 * 將 thought_signature 注入到請求 body 的 messages 中
 * Inject thought_signature into request body messages
 *
 * 用途：找到最後一個帶有 tool_calls 的 assistant message，並將 signature 注入其中
 * Purpose: Find the last assistant message with tool_calls and inject signature into it
 *
 * 為什麼需要這樣做？
 * Why is this needed?
 * - Gemini 3 要求在對話歷史中包含之前的 thought_signature
 * - Signature 必須附加在發起 function call 的 assistant message 上
 * - 格式必須符合：tool_calls[0].extra_content.google.thought_signature
 *
 * - Gemini 3 requires previous thought_signature in conversation history
 * - Signature must be attached to the assistant message that initiated function call
 * - Format must comply with: tool_calls[0].extra_content.google.thought_signature
 *
 * 注入策略 / Injection strategy:
 * 1. 解析請求 body 為 JSON
 * 2. 找到 messages 陣列
 * 3. 從後往前查找 role === "assistant" 且有 tool_calls 的 message
 * 4. 在該 message 的第一個 tool_call 中創建 extra_content.google.thought_signature
 *
 * 1. Parse request body as JSON
 * 2. Find messages array
 * 3. Search backwards for message with role === "assistant" and tool_calls
 * 4. Create extra_content.google.thought_signature in first tool_call of that message
 *
 * 防禦性設計 / Defensive design:
 * - try-catch 保護整個函數
 * - 如果注入失敗，返回原始 body（不會破壞請求）
 * - 使用 safeGet() 安全訪問
 * - 驗證每一步的類型
 *
 * - try-catch protects entire function
 * - If injection fails, return original body (won't break request)
 * - Use safeGet() for safe access
 * - Validate type at each step
 *
 * @param body - 請求 body JSON 字符串 / Request body JSON string
 * @param thoughtSignature - 要注入的 signature / Signature to inject
 * @returns 修改後的 body，或原始 body（如果注入不可行）/ Modified body or original if injection not possible
 *
 * @example
 * const body = JSON.stringify({
 *   messages: [
 *     { role: "user", content: "Check flight" },
 *     { role: "assistant", tool_calls: [{ id: "1", function: {...} }] },
 *     { role: "user", content: [...] } // function response
 *   ]
 * });
 * const newBody = injectThoughtSignature(body, "sig_abc123");
 * // Now tool_calls[0].extra_content.google.thought_signature === "sig_abc123"
 */
function injectThoughtSignature(body: string, thoughtSignature: string): string {
  try {
    // 解析請求 body
    // Parse request body
    const json = JSON.parse(body);

    // 獲取 messages 陣列（對話歷史）
    // Get messages array (conversation history)
    const messages = safeGet<unknown[]>(json, ["messages"]);
    if (!isArray(messages) || messages.length === 0) {
      debugLog("[thought_signature] No messages array, skipping injection");
      return body;
    }

    // 從後往前查找最後一個 assistant message with tool_calls
    // Search backwards for last assistant message with tool_calls
    // 為什麼從後往前？因為我們要找最近的一次 function call
    // Why backwards? Because we want the most recent function call
    let targetIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (!isPlainObject(msg)) continue;

      const role = safeGet<string>(msg, ["role"]);
      const toolCalls = safeGet<unknown[]>(msg, ["tool_calls"]);

      // 找到了：role 是 "assistant" 且有 tool_calls
      // Found it: role is "assistant" and has tool_calls
      if (role === "assistant" && isValidArray(toolCalls)) {
        targetIndex = i;
        debugLog(`[thought_signature] Found target message at index ${i}`);
        break;
      }
    }

    // 沒找到合適的 message（這是正常的，如果當前請求不涉及 function calling）
    // No suitable message found (normal if current request doesn't involve function calling)
    if (targetIndex === -1) {
      debugLog("[thought_signature] No assistant message with tool_calls found");
      return body;
    }

    // 獲取目標 message 和其 tool_calls
    // Get target message and its tool_calls
    const message = messages[targetIndex] as Record<string, unknown>;
    const toolCalls = message.tool_calls as Array<Record<string, unknown>>;

    // 根據 Gemini 文檔，只需要在第一個 tool_call 中注入 signature
    // According to Gemini docs, only need to inject signature in first tool_call
    const firstCall = toolCalls[0];
    if (!isPlainObject(firstCall)) {
      debugLog("[thought_signature] First tool_call is not a plain object");
      return body;
    }

    // 創建嵌套結構：extra_content.google.thought_signature
    // Create nested structure: extra_content.google.thought_signature
    // 注意：必須按照 Gemini 的格式要求來創建
    // Note: Must create according to Gemini's format requirements

    if (!firstCall.extra_content) {
      firstCall.extra_content = {};
    }
    const extraContent = firstCall.extra_content as Record<string, unknown>;

    if (!extraContent.google) {
      extraContent.google = {};
    }
    const google = extraContent.google as Record<string, unknown>;

    // 注入 thought_signature
    // Inject thought_signature
    google.thought_signature = thoughtSignature;

    debugLog(`[thought_signature] Injected into message[${targetIndex}].tool_calls[0]`);

    // 返回修改後的 JSON
    // Return modified JSON
    return JSON.stringify(json);
  } catch (e) {
    // 捕獲任何錯誤，返回原始 body
    // Catch any errors, return original body
    // 這確保即使注入失敗，也不會破壞請求
    // This ensures that even if injection fails, request won't be broken
    debugLog("[thought_signature] Failed to inject:", e);
    return body;
  }
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
      const transform = options.keywordTransforms[key]!; // Non-null assertion: we checked with 'in' operator
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
    // 注意：tools 必須是非空陣列才需要轉換
    // Note: tools must be a non-empty array to need transformation
    const tools = safeGet<unknown[]>(json, ["tools"]);
    if (!isArray(tools) || tools.length === 0) {
      debugLog("No tools array found or empty, skipping transformation");
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
  state: StreamState,
  config: { handleThoughtSignature: boolean }
): { patched: string | null; shouldFilter: boolean } {
  try {
    const json = JSON.parse(payload);

    // Defensive: check for expected structure
    // 注意：choices 可以是空陣列，這是正常的（例如純文本響應）
    // Note: choices can be an empty array, this is normal (e.g., pure text responses)
    const choices = safeGet<unknown[]>(json, ["choices"]);
    if (!isArray(choices)) {
      return { patched: null, shouldFilter: false };
    }

    // 如果 choices 是空陣列，直接返回不處理
    // If choices is an empty array, return directly without processing
    if (choices.length === 0) {
      return { patched: null, shouldFilter: false };
    }

    debugLog("Processing chunk with", choices.length, "choices");

    // 提取 Gemini 3 thought_signature（如果啟用）
    if (config.handleThoughtSignature) {
      const sig = extractThoughtSignature(choices);
      if (sig) {
        debugLog("[thought_signature] Extracted:", sig.slice(0, 30) + "...");
        state.thoughtSignature = sig;
      }
    }

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
 *
 * 過濾邏輯：
 * Filtering logic:
 * - 只有當所有 choice 的 delta 都是空的（沒有 content 也沒有 tool_calls）時才過濾
 * - Only filter when all choice deltas are empty (no content and no tool_calls)
 * - 如果無法判斷（結構異常），保守地不過濾
 * - If unable to determine (abnormal structure), conservatively don't filter
 */
function shouldFilterEmptyChunk(choices: unknown[]): boolean {
  let hasValidChoice = false;  // 是否有至少一個有效的 choice
  let allChoicesEmpty = true;  // 所有有效的 choice 是否都為空

  for (const choice of choices) {
    if (!isPlainObject(choice)) continue;

    const delta = safeGet<Record<string, unknown>>(choice, ["delta"]);
    if (!isPlainObject(delta)) continue;

    // 這是一個有效的 choice（有 delta 物件）
    hasValidChoice = true;

    const toolCalls = safeGet<unknown[]>(delta, ["tool_calls"]);
    const content = safeGet<string>(delta, ["content"]);

    // 如果有 tool calls（即使是空陣列也算有內容）
    // If there are tool calls (even empty array counts as having content)
    if (isArray(toolCalls) && toolCalls.length > 0) {
      allChoicesEmpty = false;
      break;
    }

    // 如果有非空 content
    // If there's non-empty content
    if (typeof content === "string" && content.length > 0) {
      allChoicesEmpty = false;
      break;
    }

    // 注意：content 可能是 null 或 undefined，這是正常的
    // Note: content can be null or undefined, this is normal
    // 只有當 content 明確是空字串時才認為這個 choice 是空的
    // Only consider this choice empty when content is explicitly an empty string
  }

  // 只有當：
  // Only filter when:
  // 1. 至少有一個有效的 choice（避免誤判結構異常的 chunk）
  // 2. 所有有效的 choice 都是空的
  // 1. At least one valid choice exists (avoid misjudging structurally abnormal chunks)
  // 2. All valid choices are empty
  return hasValidChoice && allChoicesEmpty;
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
function transformEvent(
  event: string,
  state: StreamState,
  config: { handleThoughtSignature: boolean }
): string | null {
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

  const result = patchChunkPayload(payload, state, config);

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
 *
 * Stores thought_signature in shared state for use in next request
 */
function patchSseStream(
  stream: ReadableStream<Uint8Array>,
  sharedSignatureState: ThoughtSignatureState,
  config: { handleThoughtSignature: boolean }
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const state: StreamState = {
    toolCallState: new Map(),
    sawToolCallsFinish: false,
    chunkCount: 0,
    thoughtSignature: undefined,
  };
  let buffer = "";

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          // Store thought_signature when stream completes
          if (config.handleThoughtSignature && state.thoughtSignature) {
            sharedSignatureState.value = state.thoughtSignature;
            debugLog("[thought_signature] Stored for next request");
          }

          // Flush remaining buffer
          if (buffer.trim().length > 0) {
            const transformed = transformEvent(buffer, state, config);
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
          const transformed = transformEvent(event, state, config);
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
    handleThoughtSignature: shouldHandleThoughtSignature = false,
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

  /**
   * Closure-level state for Gemini 3 thought_signature
   * Persists across request/response cycles within this fetch instance
   */
  const thoughtSignatureState: ThoughtSignatureState = { value: undefined };

  const patchedFetch = async (input: FetchInput, init?: FetchInit) => {
    debugLog("=== Fetch Request ===");
    debugLog("URL:", typeof input === "string" ? input : input.toString());

    // Transform request body if needed
    if (init?.body && typeof init.body === "string") {
      let transformedBody = init.body;

      // Apply JSON Schema transformations for provider compatibility
      if (shouldTransformTools) {
        transformedBody = transformRequestBody(transformedBody, {
          keywordsToRemove,
          keywordTransforms,
        });
      }

      // Inject Gemini 3 thought_signature if available
      if (shouldHandleThoughtSignature && thoughtSignatureState.value) {
        debugLog("[thought_signature] Injecting into request");
        transformedBody = injectThoughtSignature(
          transformedBody,
          thoughtSignatureState.value
        );
        // Keep signature for potential retries
        // Only clear after successful response extraction
      }

      init = { ...init, body: transformedBody };
    }

    // Execute request
    const response = await baseFetch(input, init);
    const contentType = response.headers.get("content-type") || "";

    debugLog("Response status:", response.status);
    debugLog("Content-Type:", contentType);

    // Skip patching if all patches are disabled
    if (!shouldPatchToolCalls && !shouldHandleThoughtSignature) {
      debugLog("All patches disabled, passing through response");
      return response;
    }

    // Only patch SSE streams
    if (!contentType.includes("text/event-stream") || !response.body) {
      debugLog("Not SSE stream, passing through");
      return response;
    }

    // Patch the stream
    debugLog("=== Patching SSE stream ===");
    const patchedStream = patchSseStream(
      response.body,
      thoughtSignatureState,
      { handleThoughtSignature: shouldHandleThoughtSignature }
    );
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
  isArray,
  isValidArray,
  isPlainObject,
  shouldFilterEmptyChunk,
  patchToolCallIndices,
} : undefined;
