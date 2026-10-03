import { isRedisConnectionDown } from './connection-status';

describe('isRedisConnectionDown', () => {
  it('koneksi null (Redis tidak dikonfigurasi) → false (bukan "down", memang tidak ada)', () => {
    expect(isRedisConnectionDown(null)).toBe(false);
  });

  it('status "ready" → false', () => {
    expect(isRedisConnectionDown({ status: 'ready' })).toBe(false);
  });

  it.each(['connecting', 'connect', 'reconnecting', 'end', 'close', 'wait'])(
    'status "%s" (bukan ready) → true',
    (status) => {
      expect(isRedisConnectionDown({ status })).toBe(true);
    }
  );

  it('status tidak ada (mis. mock) → false: "tidak diketahui", pemanggil tetap mencoba', () => {
    expect(isRedisConnectionDown({})).toBe(false);
  });
});
