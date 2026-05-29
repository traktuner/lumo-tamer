/**
 * Simple Lumo API client
 * Minimal implementation with U2L encryption support
 */

import { decryptString } from '@lumo/crypto/index.js';
import {
    DEFAULT_LUMO_PUB_KEY,
    encryptTurns,
} from '@lumo/lib/lumo-api-client/core/encryption.js';
import {
    generateRequestId,
    generateRequestKey,
    RequestEncryptionParams,
} from '@lumo/lib/lumo-api-client/core/encryptionParams.js';
import { StreamProcessor } from '@lumo/lib/lumo-api-client/core/streaming.js';
import { logger } from '../app/logger.js';
import {
    Role,
    type AesGcmCryptoKey,
    type ProtonApi,
    type GenerationResponseMessage,
    type LumoApiGenerationRequest,
    type RequestId,
    type ToolName,
    type Turn,
    type ParsedToolCall,
    type AssistantMessageData,
    type LumoClientOptions,
    type ChatResult,
} from './types.js';
import { getInstructionsConfig, getLogConfig, getConfigMode, getCustomToolsConfig, getEnableWebSearch, getLumoConfig } from '../app/config.js';
import { injectInstructionsIntoTurns } from './instructions.js';
import { NativeToolCallProcessor } from '../api/tools/native-tool-call-processor.js';
import { postProcessTitle } from '@lumo/lib/lumo-api-client/utils.js';

// Re-export types for external consumers
export type { LumoClientOptions, ChatResult };

const DEFAULT_INTERNAL_TOOLS: ToolName[] = ['proton_info'];
const DEFAULT_EXTERNAL_TOOLS: ToolName[] = ['web_search', 'weather', 'stock', 'cryptocurrency'];
const DEFAULT_ENDPOINT = 'ai/v1/chat';

/** Build the bounce instruction: config text + the misrouted tool call as a JSON example.
 *  Lumo's native (misrouted) tool_call channel drops the custom-tool arguments, so we ask
 *  Lumo to re-emit the call as JSON text - the text path reliably carries arguments. */
function buildBounceInstruction(toolCall: ParsedToolCall): string {
    const instruction = getInstructionsConfig().forToolBounce;

    // In server mode, re-add the prefix to the tool name in the example
    // (the name in toolCall has already been stripped).
    let toolName = toolCall.name;
    if (getConfigMode() === 'server') {
        const prefix = getCustomToolsConfig().prefix;
        if (prefix && !toolName.startsWith(prefix)) {
            toolName = `${prefix}${toolName}`;
        }
    }

    const toolCallJson = JSON.stringify({ name: toolName, arguments: toolCall.arguments }, null, 2);
    return `${instruction}\n${toolCallJson}`;
}

export class LumoClient {
    constructor(
        private protonApi: ProtonApi,
        private defaultOptions?: Partial<LumoClientOptions>,
    ) { }

    /**
     * Send a message and stream the response
     * @param message - User message
     * @param onChunk - Optional callback for each text chunk
     * @param options - Request options
     * @returns ChatResult with response text and optional title
     */
    async chat(
        message: string,
        onChunk?: (content: string) => void,
        options: LumoClientOptions = {}
    ): Promise<ChatResult> {

        const turns: Turn[] = [{ role: Role.User, content: message }];
        return this.chatWithHistory(turns, onChunk, options);

    }

    /**
     * Process SSE stream and extract response text and optional title
     *
     * Title generation inspired by WebClients redux.ts lines 49-110
     */
    private async processStream(
        stream: ReadableStream<Uint8Array>,
        onChunk?: (content: string) => void,
        encryptionContext?: {
            enableEncryption: boolean;
            requestKey?: AesGcmCryptoKey;
            requestId?: RequestId;
        },
        /** Aborts the upstream request when the stream stalls (idle timeout). */
        abortController?: AbortController,
        /** When true, ignore misrouted detection (this IS the bounce response). */
        isBounce = false,
    ): Promise<ChatResult> {
        const reader = stream.getReader();
        const decoder = new TextDecoder('utf-8');
        const processor = new StreamProcessor();
        let fullResponse = '';
        let fullTitle = '';

        // Native tool call processing (SSE tool_call/tool_result targets)
        const nativeToolProcessor = new NativeToolCallProcessor(isBounce);
        let suppressChunks = false;
        let abortEarly = false;

        const processMessage = async (msg: GenerationResponseMessage) => {
            if (msg.type === 'token_data') {
                let content = msg.content;

                // Decrypt if needed
                if (
                    msg.encrypted &&
                    encryptionContext?.enableEncryption &&
                    encryptionContext.requestKey &&
                    encryptionContext.requestId
                ) {
                    const adString = `lumo.response.${encryptionContext.requestId}.chunk`;
                    try {
                        content = await decryptString(
                            content,
                            encryptionContext.requestKey,
                            adString
                        );
                    } catch (error) {
                        logger.error(error, 'Failed to decrypt chunk:');
                        // Continue with encrypted content
                    }
                }

                if (msg.target === 'message') {
                    fullResponse += content;
                    if (!suppressChunks) {
                        onChunk?.(content);
                    }
                } else if (msg.target === 'title') {
                    // Accumulate title chunks (title streams before message)
                    fullTitle += content;
                } else if (msg.target === 'tool_call') {
                    if (nativeToolProcessor.feedToolCall(content)) {
                        suppressChunks = true;
                        abortEarly = true;
                    }
                } else if (msg.target === 'tool_result') {
                    nativeToolProcessor.feedToolResult(content);
                }
            } else if (
                msg.type === 'error' ||
                msg.type === 'rejected' ||
                msg.type === 'harmful' ||
                msg.type === 'timeout'
            ) {
                const detail = (msg as any).message;
                throw new Error(`API returned ${msg.type}${detail ? `: ${detail}` : ''}`);
            }
        };

        // Abort the upstream request and break the read loop if Lumo sends no
        // data for `idleTimeoutMs`. Prevents requests hanging forever when the
        // upstream stalls mid-stream. 0 disables the timeout.
        const idleTimeoutMs = getLumoConfig().streamIdleTimeoutMs;
        const readWithIdleTimeout = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
            if (idleTimeoutMs <= 0) return reader.read();

            const readPromise = reader.read();
            // Swallow the late rejection if the timeout wins the race (the abort
            // below rejects this read), so it doesn't surface as an unhandled rejection.
            readPromise.catch(() => { /* handled via timeout */ });

            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<never>((_, reject) => {
                timer = setTimeout(() => {
                    logger.warn({ idleTimeoutMs }, 'Lumo stream stalled, aborting');
                    abortController?.abort();
                    reject(new Error(`Lumo stream stalled: no data received for ${idleTimeoutMs}ms`));
                }, idleTimeoutMs);
            });
            try {
                return await Promise.race([readPromise, timeout]);
            } finally {
                if (timer) clearTimeout(timer);
            }
        };

        try {
            while (true) {
                const { done, value } = await readWithIdleTimeout();
                if (done) break;

                const chunk = decoder.decode(value, { stream: true });
                const messages = processor.processChunk(chunk);

                for (const msg of messages) {
                    await processMessage(msg);
                }
                if (abortEarly) break;
            }

            // Process any remaining data
            const finalMessages = processor.finalize();
            for (const msg of finalMessages) {
                await processMessage(msg);
            }

            // Finalize tracking and get result
            nativeToolProcessor.finalize();
            const nativeResult = nativeToolProcessor.getResult();

            // Build message data for persistence.
            // Only include native tool data when NOT misrouted: misrouted custom-tool
            // calls come through Lumo's native channel WITHOUT their arguments, so
            // forwarding them produces broken calls. They are bounced instead (see below).
            const message: AssistantMessageData = { content: fullResponse };
            if (nativeResult.toolCall && !nativeResult.misrouted) {
                message.toolCall = JSON.stringify({
                    name: nativeResult.toolCall.name,
                    arguments: nativeResult.toolCall.arguments,
                });
                if (nativeResult.toolResult) {
                    message.toolResult = nativeResult.toolResult;
                }
            }

            return {
                message,
                title: fullTitle || undefined,
                nativeToolCallFailed: nativeResult.toolCall ? nativeResult.failed : undefined,
                misrouted: nativeResult.misrouted,
                // Keep parsed tool call for bounce handling (internal use only)
                _nativeToolCallForBounce: nativeResult.misrouted ? nativeResult.toolCall : undefined,
            };
        } finally {
            // May throw if a read is still pending after an idle-timeout abort.
            try { reader.releaseLock(); } catch { /* ignore */ }
        }
    }

    /**
     * Multi-turn conversation support
     *
     * Title generation inspired by WebClients helper.ts:596 and client.ts:110
     */
    async chatWithHistory(
        turns: Turn[],
        onChunk?: (content: string) => void,
        options: LumoClientOptions = {},
        /** Internal: prevents infinite bounce loops. Do not set externally. */
        isBounce = false,
    ): Promise<ChatResult> {
        const {
            enableEncryption = this.defaultOptions?.enableEncryption ?? true,
            endpoint = DEFAULT_ENDPOINT,
            requestTitle = false,
            instructions,
            injectInstructionsInto = 'first',
        } = options;

        const turn = turns[turns.length - 1];
        const logConfig = getLogConfig();

        if (logConfig.messageContent) {
            logger.info(`[${turn.role}] ${turn.content && turn.content.length > 200
                ? turn.content.substring(0, 200) + '...'
                : turn.content
                } `);
        }

        // Read from config - applies to both server and CLI modes
        const tools: ToolName[] = getEnableWebSearch()
            ? [...DEFAULT_INTERNAL_TOOLS, ...DEFAULT_EXTERNAL_TOOLS]
            : DEFAULT_INTERNAL_TOOLS;

        // Inject instructions into turns at the last moment (before encryption/API call)
        // This keeps stored conversations clean - instructions are transient, not persisted
        const turnsWithInstructions = instructions
            ? injectInstructionsIntoTurns(turns, instructions, injectInstructionsInto)
            : turns;

        let encryptionParams: RequestEncryptionParams | undefined;
        let processedTurns: Turn[] = turnsWithInstructions;
        let requestKeyEncB64: string | undefined;

        if (enableEncryption) {
            const requestKey = await generateRequestKey();
            const requestId = generateRequestId();
            encryptionParams = new RequestEncryptionParams(requestKey, requestId);
            requestKeyEncB64 = await encryptionParams.encryptRequestKey(DEFAULT_LUMO_PUB_KEY);
            processedTurns = await encryptTurns(turnsWithInstructions, encryptionParams);
        }

        // Request title alongside message for new conversations
        // See WebClients client.ts:110: targets = requestTitle ? ['title', 'message'] : ['message']
        const targets: Array<'title' | 'message'> = requestTitle ? ['title', 'message'] : ['message'];

        const request: LumoApiGenerationRequest = {
            type: 'generation_request',
            turns: processedTurns,
            options: { tools },
            targets,
            ...(enableEncryption && requestKeyEncB64 && encryptionParams
                ? {
                    request_key: requestKeyEncB64,
                    request_id: encryptionParams.requestId,
                }
                : {}),
        };

        const payload = { Prompt: request };

        // AbortController lets the idle-timeout in processStream cancel the
        // underlying fetch when Lumo stalls mid-stream.
        const abortController = new AbortController();

        const stream = (await this.protonApi({
            url: endpoint,
            method: 'post',
            data: payload,
            output: 'stream',
            signal: abortController.signal,
        })) as ReadableStream<Uint8Array>;

        const result = await this.processStream(stream, onChunk, {
            enableEncryption,
            requestKey: encryptionParams?.requestKey,
            requestId: encryptionParams?.requestId,
        }, abortController, isBounce);

        // Log response
        if (logConfig.messageContent) {
            const responsePreview = result.message.content.length > 200
                ? result.message.content.substring(0, 200) + '...'
                : result.message.content;
            logger.info(`[Lumo] ${responsePreview}`);
            if (result.title) {
                logger.debug({ title: result.title }, 'Generated title');
            }
        }

        // Bounce misrouted tool calls: Lumo routed a custom tool through its native
        // pipeline (which drops the arguments). Ask it to re-emit the call as JSON
        // text - the text path reliably carries arguments. Capped at one retry via isBounce.
        if (!isBounce && result.misrouted && result._nativeToolCallForBounce) {
            const bounceInstruction = buildBounceInstruction(result._nativeToolCallForBounce);
            logger.info({ tool: result._nativeToolCallForBounce.name }, 'Bouncing misrouted tool call');

            const bounceTurns: Turn[] = [
                ...turns,
                { role: Role.Assistant, content: result.message.content },
                { role: Role.User, content: bounceInstruction },
            ];

            return this.chatWithHistory(bounceTurns, onChunk, options, true);
        }

        // Post-process title (remove quotes, trim, limit length)
        return {
            ...result,
            title: result.title ? postProcessTitle(result.title) : undefined,
            // Clear internal field from final result
            _nativeToolCallForBounce: undefined,
        };
    }
}
