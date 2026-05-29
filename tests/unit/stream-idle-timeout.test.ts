/**
 * Unit test for the stream idle timeout in LumoClient.
 *
 * When Lumo sends no data for `lumo.streamIdleTimeoutMs`, the client must abort
 * the upstream request and reject, instead of hanging forever.
 */

import { describe, it, expect } from 'vitest';
import { LumoClient } from '../../src/lumo-client/client.js';
import { getLumoConfig } from '../../src/app/config.js';
import type { ProtonApi } from '../../src/lumo-client/types.js';

describe('LumoClient stream idle timeout', () => {
  it('aborts the upstream request when no data arrives', async () => {
    const original = getLumoConfig().streamIdleTimeoutMs;
    (getLumoConfig() as { streamIdleTimeoutMs: number }).streamIdleTimeoutMs = 50;

    try {
      // A stream that never enqueues and never closes (simulates Lumo stalling).
      const stallingStream = new ReadableStream<Uint8Array>({ start() { /* never resolves */ } });

      let aborted = false;
      const fakeApi: ProtonApi = (async (opts) => {
        opts.signal?.addEventListener('abort', () => { aborted = true; });
        return stallingStream;
      }) as ProtonApi;

      const client = new LumoClient(fakeApi);

      await expect(
        client.chat('hello', undefined, { enableEncryption: false }),
      ).rejects.toThrow(/stalled/);

      expect(aborted).toBe(true);
    } finally {
      (getLumoConfig() as { streamIdleTimeoutMs: number }).streamIdleTimeoutMs = original;
    }
  });

  it('does not time out when disabled (0)', async () => {
    const original = getLumoConfig().streamIdleTimeoutMs;
    (getLumoConfig() as { streamIdleTimeoutMs: number }).streamIdleTimeoutMs = 0;

    try {
      // Stream that immediately closes with no data - should complete, not hang/throw.
      const emptyStream = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
      const fakeApi: ProtonApi = (async () => emptyStream) as ProtonApi;
      const client = new LumoClient(fakeApi);

      const result = await client.chat('hello', undefined, { enableEncryption: false });
      expect(result.message.content).toBe('');
    } finally {
      (getLumoConfig() as { streamIdleTimeoutMs: number }).streamIdleTimeoutMs = original;
    }
  });
});
