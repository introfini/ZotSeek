import { selfTest, scenario, assertTrue } from '../self-test';
import { assertLoopbackUrl } from '../../core/loopback-url';

function throws(fn: () => void): boolean {
  try { fn(); return false; } catch { return true; }
}

selfTest.register('task-42a-loopback', async () => {
  return [
    await scenario('accepts loopback URLs', async () => {
      assertTrue(!!assertLoopbackUrl('http://127.0.0.1:1234'), 'ipv4 loopback');
      assertTrue(!!assertLoopbackUrl('http://localhost:11434/v1/embeddings'), 'localhost');
      assertTrue(!!assertLoopbackUrl('http://[::1]:8080'), 'ipv6 loopback');
      assertTrue(!!assertLoopbackUrl('https://127.0.0.1:8443'), 'https loopback');
    }),
    await scenario('rejects non-loopback hosts', async () => {
      assertTrue(throws(() => assertLoopbackUrl('http://evil.com')), 'plain remote');
      assertTrue(throws(() => assertLoopbackUrl('http://127.0.0.1.evil.com')), 'loopback-prefixed domain');
      assertTrue(throws(() => assertLoopbackUrl('http://0.0.0.0:1234')), '0.0.0.0');
      assertTrue(throws(() => assertLoopbackUrl('http://[::ffff:8.8.8.8]')), 'ipv6-mapped remote');
      assertTrue(throws(() => assertLoopbackUrl('http://192.168.1.10:1234')), 'LAN address');
    }),
    await scenario('rejects bad schemes, credentials, garbage', async () => {
      assertTrue(throws(() => assertLoopbackUrl('ftp://127.0.0.1')), 'ftp scheme');
      assertTrue(throws(() => assertLoopbackUrl('file:///etc/passwd')), 'file scheme');
      assertTrue(throws(() => assertLoopbackUrl('http://user:pw@127.0.0.1')), 'credentials in URL');
      assertTrue(throws(() => assertLoopbackUrl('not a url')), 'unparseable');
    }),
  ];
});
