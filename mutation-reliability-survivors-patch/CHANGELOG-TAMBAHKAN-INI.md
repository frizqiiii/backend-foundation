- **Analisis survivor mutation testing di `reliability/` (bulkhead/circuit-breaker/retry)**:
  dari 9 survivor, 4 diperbaiki (regresi nyata, tiap test dibuktikan mematikan mutannya lewat
  mutasi manual): bulkhead id=25 (`state.active -= 1` vs `+= 1` — kebocoran semaphore, slot
  tidak pernah benar-benar terbebas), circuit-breaker id=48 (batas `<` vs `<=` pada transisi
  HALF_OPEN), circuit-breaker id=65 (`breaker.state = 'CLOSED'` — panggilan sukses berturut
  bisa salah log "pulih"), retry.ts id=147 (percobaan terakhir yang gagal salah menghitung
  delay & log retry padahal tidak akan diulang lagi). 5 survivor SISANYA (pesan
  error/`.name` di 3 tempat, dan satu pasang mutan di circuit-breaker yang TERBUKTI setara/
  equivalent di bawah arsitektur sekarang) sengaja TIDAK dipaksakan test buatan — alasan
  lengkap tiap satu ada di `docs/mutation-survivors-reliability.md`. Suite penuh naik ke
  160/1332, nol regresi.
