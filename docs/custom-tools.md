# Custom Tools (API)

This document covers custom tool integration for API clients (e.g., Home Assistant, Open WebUI).

For CLI local actions (file operations, code execution), see [local-actions.md](local-actions.md).

---

## Warning

Custom tool support is experimental. Tool calls can fail because of:

- **Too many tools**: Lumo gets confused when the client provides many tools or (very) long instructions.
- **Misrouted calls**: Lumo routes custom tools through its native pipeline, which fails server-side and drops the arguments. lumo-tamer detects this and bounces the call back so Lumo re-emits it as JSON text with arguments (see [Misrouted Tool Calls](#misrouted-tool-calls)).
- **Wrong tool/arguments**: Lumo sets the wrong tool name or arguments.
- **Detection failures**: JSON code blocks are not properly detected or parsed.

This requires trial and error. Experiment with `server.instructions` settings to improve results.

**Privacy note**: When Lumo misroutes a tool call, the tool name and arguments are sent to Proton's servers via the native tool pipeline. This data may be processed unencrypted server-side and could appear in Proton's logs. If your tools handle sensitive data, be aware of this risk. Tool results are not affected: they flow through the normal message pipeline with encryption.


---

## Quick Start

1. Enable custom tools in `config.yaml`:
   ```yaml
   server:
     customTools:
       enabled: true
   ```

2. Configure your API client (Home Assistant, Open WebUI, etc.) to use tools as normal.

3. lumo-tamer intercepts Lumo's responses, detects tool calls, and returns them in OpenAI format for your client to execute.

---

---

## Configuration

### Enable Custom Tools

```yaml
server:
  customTools:
    # Enable detection of JSON tool calls in Lumo's responses
    enabled: true

    # Prefix added to custom tool names to distinguish from Lumo's native tools.
    # Applied to tool definitions sent to Lumo, stripped from tool calls returned to client.
    # Set to "" to disable prefixing.
    prefix: "user:"
```

### Instructions Template

The instructions sent to Lumo are assembled from a template:

```yaml
server:
  instructions:
    # Template for assembling instructions.
    # Uses Handlebars-like syntax: {{varName}}, {{#if varName}}...{{/if}}
    # Available variables:
    #   - tools: JSON-stringified tool definitions (truthy when tools provided)
    #   - clientInstructions: system/developer message from request
    #   - forTools: the forTools block below (pre-interpolated with {{prefix}})
    #   - fallback: the fallback block below
    #   - prefix: tool prefix from customTools.prefix
    template: |
      {{#if tools}}
      {{forTools}}
      {{/if}}

      {{#if clientInstructions}}
      {{clientInstructions}}
      {{else}}
      {{fallback}}
      {{/if}}

      {{#if tools}}
      Below are all the custom tools you can use. Remember, all tools prefixed with `{{prefix}}` are custom tools and must be called by outputting the JSON to the user.

      {{tools}}
      {{/if}}

    # Fallback instructions when no system/developer message is provided
    fallback: |
      Always answer in plain text. Don't use tables, quote blocks, lists, etc. Be concise.

    # Instructions prepended when tools are provided in the request.
    # Can use {{prefix}} variable.
    forTools: |
      === CUSTOM TOOL PROTOCOL ===
      The tools below are CUSTOM tools, prefixed with `{{prefix}}`.

      IMPORTANT: Custom tools are NOT part of your built-in tool system.
      You MUST call them by outputting JSON as text in a code block to the user, like this:
      ```json
      {"name": "{{prefix}}example_tool", "arguments": {"param": "value"}}
      ```
      DO NOT try to call custom tools through your internal tool mechanism, it will fail with error:true.
      DO NOT remove the `{{prefix}}` prefix when calling these tools.

      The user's system will execute them and return results.
      === END PROTOCOL ===

    # Bounce instruction sent when Lumo routes a custom tool through its native pipeline.
    forToolBounce: |
      You tried to call a custom tool using your built-in tool system, but custom tools must be called by outputting JSON text within a code block. Please output the tool call as JSON, like this:
```

### Instruction Replace Patterns

Clean up client instructions that might confuse Lumo:

```yaml
server:
  instructions:
    # Search/replace patterns applied to client instructions (case-insensitive regex).
    # Useful for removing or rewriting phrases that may confuse Lumo about tool calling.
    # Each entry: { pattern: "regex", replacement: "text" } - omit replacement to strip.
    replacePatterns:
      - pattern: "(?<=(?:(?:native|custom|internal|external)\\s)?)(?=tool)"
        replacement: "custom "
```


## Troubleshooting

**Tool calls not detected**
- Ensure `customTools.enabled: true`
- Check that Lumo is outputting valid JSON in code fences
- Review `instructions.forTools` - Lumo may need clearer instructions

**Wrong tool names**
- Check `customTools.prefix` - it's added to definitions and stripped from responses
- If prefix is causing issues, set to `""` to disable

**Lumo says "I don't have access to that tool"**
- This is a misrouted call being bounced. lumo-tamer asks Lumo to re-emit it as JSON text; it usually resolves automatically.
- If persistent, check logs for `Bouncing misrouted tool call` and whether the bounced response contains valid JSON.

---

## Native Tools

Lumo has built-in tools executed server-side by Proton:

| Tool | Description |
|------|-------------|
| `proton_info` | Proton product information (always enabled) |
| `web_search` | Web search via Proton's backend |
| `weather` | Weather data |
| `stock` | Stock prices |
| `cryptocurrency` | Cryptocurrency prices |

Enable/disable external native tools:

```yaml
server:
  # Enable Lumo's native web_search tool (and other external tools)
  enableWebSearch: true
```

Native and custom tools work together: native tools execute server-side, custom tools are detected client-side.

---

## How Custom Tools Work

1. **Tool definitions are prefixed** with `customTools.prefix` (e.g., `get_weather` becomes `user:get_weather`)
2. **Instructions are assembled** from `instructions.template` with tool definitions as JSON
3. **Instructions are prepended** to a user message as `[Project instructions: ...]`
   - `instructions.injectInto: "first"` (default): inject into first user message (less token usage in multi-turn)
   - `instructions.injectInto: "last"`: inject into last user message each request (matches WebClient)
4. **Lumo outputs tool calls** as JSON in code fences:
   ````
   I'll check the weather for you.
   ```json
   {"name": "user:get_weather", "arguments": {"city": "Paris"}}
   ```
   ````
   *If Lumo misroutes the tool call through its native pipeline, lumo-tamer bounces it so Lumo re-emits it as JSON text with arguments. See [Misrouted Tool Calls](#misrouted-tool-calls).*
5. **lumo-tamer detects and extracts** tool calls, strips the prefix, and returns in OpenAI format
6. **Your client executes** the tool and sends results back

### Response Format

```json
{
  "choices": [{
    "message": {
      "role": "assistant",
      "content": "I'll check the weather for you.",
      "tool_calls": [{
        "id": "call_abc123",
        "type": "function",
        "function": {
          "name": "get_weather",
          "arguments": "{\"city\": \"Paris\"}"
        }
      }]
    }
  }]
}
```

---

## Misrouted Tool Calls

Sometimes Lumo routes a custom tool through its native SSE pipeline instead of outputting JSON text. This always fails server-side because Proton's backend doesn't know the tool. Crucially, the native `tool_call` event **drops the custom-tool arguments** (Lumo doesn't know the client-defined schema), so forwarding it directly produces an argument-less, broken call. Lumo's text/JSON path, by contrast, reliably carries the arguments.

### What Happens

1. lumo-tamer detects the misrouted call (tool name not in `KNOWN_NATIVE_TOOLS`)
2. Aborts the stream early and suppresses Lumo's error fallback ("I don't have access to that tool...")
3. **Bounces** the call: sends a follow-up request with `instructions.forToolBounce` plus the call as a JSON example, asking Lumo to re-emit it as JSON text
4. Lumo re-emits the call (now with arguments) on the text path; the `StreamingToolDetector` parses it and forwards it to the client

This is transparent to API clients (it costs one extra round-trip). Bouncing is capped at one retry to avoid loops.

> Note: a previous version forwarded the misrouted native call directly. That was reverted because the native channel omits the arguments, so clients like OpenCode received calls with missing required parameters (e.g. `glob` without `pattern`) and rejected them.

---

## Key Code

| File | Purpose |
|------|---------|
| `src/api/instructions.ts` | Instruction template assembly |
| `src/api/tools/streaming-tool-detector.ts` | `StreamingToolDetector` for streaming text detection |
| `src/api/tools/native-tool-call-processor.ts` | Native SSE tool call parsing + misroute detection |
| `src/lumo-client/client.ts` | Misrouted tool bounce logic; stream idle timeout |
