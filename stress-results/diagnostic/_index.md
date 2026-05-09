# Failure Diagnostic Index

Model: qwen3.5-9b (Q4_K_M)  Preset: thinking-coding  Run: 2026-05-08T12:17:22.969Z

| Case | Time | Tokens | Tools | Match | Status |
|------|------|--------|-------|-------|--------|
| [B1-off-by-one](B1-off-by-one.md) | 38.5s | in=16526 out=592 | 0 | 2/4 | 🟡 some match |
| [B2-missing-await](B2-missing-await.md) | 453.9s | in=745363 out=3905 | 27 | 4/4 | ❌ TIMEOUT |
| [B3-ts-narrowing](B3-ts-narrowing.md) | 28.9s | in=16516 out=400 | 0 | 0/5 | ❌ no match |
| [C3-if-else-switch](C3-if-else-switch.md) | 21.8s | in=16516 out=102 | 0 | 0/4 | ❌ no match |
| [E1-find-callers](E1-find-callers.md) | 101.6s | in=183661 out=968 | 7 | 1/4 | 🟡 some match |
| [F2-refusal-flight](F2-refusal-flight.md) | 27.8s | in=16517 out=339 | 0 | 0/4 | ❌ no match |
| [I1-retry-after-bash-fail](I1-retry-after-bash-fail.md) | 44.1s | in=71086 out=383 | 2 | 2/3 | 🟡 some match |
