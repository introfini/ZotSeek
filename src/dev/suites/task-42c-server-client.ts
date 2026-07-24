import { selfTest, scenario, assertTrue, assertEq } from '../self-test';
import { ServerEmbeddingClient, ServerUnavailableError } from '../../core/server-embedding-client';

selfTest.register('task-42c-server-client', async () => {
  return [
    await scenario('embed against a closed port throws ServerUnavailableError', async () => {
      const client = new ServerEmbeddingClient({
        baseUrl: 'http://127.0.0.1:9', serverModelName: 'whatever',
      });
      try {
        await client.embed(['test'], 0); // retries=0: fail fast for the test
        assertTrue(false, 'should have thrown');
      } catch (e: any) {
        assertEq(e?.code, 'SERVER_UNAVAILABLE');
        assertTrue(String(e?.message).includes('127.0.0.1:9'), 'message names the URL');
        assertTrue(!String(e?.message).includes('AbortController'), 'reached network, not an environment error');
      }
    }),
    await scenario('non-loopback baseUrl is rejected before any network I/O', async () => {
      const client = new ServerEmbeddingClient({
        baseUrl: 'http://example.com:1234', serverModelName: 'whatever',
      });
      try {
        await client.embed(['test'], 0);
        assertTrue(false, 'should have thrown');
      } catch (e: any) {
        assertEq(e?.code, 'LOOPBACK_REJECTED');
        assertTrue(String(e?.message).includes('example.com'), 'names the offending host');
      }
    }),
  ];
});
