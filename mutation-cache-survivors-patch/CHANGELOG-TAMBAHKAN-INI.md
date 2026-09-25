- **Analisis survivor mutation testing di `cache.ts` (6/6 diperbaiki)**: semua 6 survivor
  ternyata satu akar masalah yang sama di 3 tempat — guard `if (!redisClient)` di
  `getOrSetCache`/`invalidateCache`/`invalidateByPattern` tidak pernah diuji jalur "Redis
  tidak dikonfigurasi" (`cache.spec.ts` selalu mock `redisClient` sebagai truthy). File baru
  `cache.no-redis.spec.ts` menguji ketiganya dengan `redisClient: null`. Keenam mutan
  dibuktikan mati satu per satu lewat mutasi manual. Lihat `docs/mutation-survivors.md`
  (sebelumnya `mutation-survivors-reliability.md`, diganti nama karena sekarang mencakup
  lebih dari satu folder). Suite naik ke 161/1337, nol regresi.
