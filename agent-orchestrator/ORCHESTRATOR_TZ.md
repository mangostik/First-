# FishCRM Agent Orchestrator — рабочая спецификация и checklist

Источник истины: утверждённое ТЗ из задачи FishCRM Agent Orchestrator. Этот файл фиксирует MVP-объём и не содержит секретов, приватных MCP URL или значений Railway variables.

## Постоянные ограничения

- [x] Не изменять `main`.
- [x] Не ломать `run_agent_review` и `orchestrator_status`.
- [x] Не создавать отдельные аккаунты агентов.
- [x] Не удалять старый GPT.
- [x] Не публиковать секреты, MCP-токены или приватные endpoints.
- [ ] Не выполнять production merge/deployment без отдельного разрешения.

## Checklist реализации

### Архитектура и Planner

- [x] Реестр ролей: Backend, QA, Frontend, Database, Security, Documentation, Reviewer; расширяемые role templates.
- [x] Planner с формированием структурированного плана.
- [x] Для задачи API-функции и тестов создаются Backend, QA и зависимый Reviewer.
- [partial] Полный реестр ролей из ТЗ: Planner, Backend, Frontend, Database, QA, Security, Documentation, Reviewer, Integrator; реализованы агентские role templates, Planner/Integrator остаются сервисными компонентами.
- [x] Шаблоны ролей Backend, Frontend, Database, QA, Security, Documentation и Reviewer с routing metadata и тестовыми критериями.
- [x] Planner routing по содержанию задачи, safe fallback для неизвестной задачи и сохранение dependencies.

### Параллельное выполнение

- [x] Канонические статусы job/subtask.
- [x] Атомарное JSON-хранилище job по `job_id`.
- [x] Dependency-aware scheduler.
- [x] Максимум 3 параллельные задачи.
- [x] Retry, timeout, cancel и обработка падения подзадачи.
- [x] Сохранение промежуточных результатов.
- [x] Полные структурированные job/subtask events, timestamps состояний, duration, attempts и безопасная redaction-наблюдаемость.
- [x] Cost/API safety limits: max subtasks, concurrency, retries, subtask/job timeout и сохранение нарушений в final result.

### Runner и выполнение кода

- [x] Adapter-интерфейс agent runner.
- [x] Конфигурация mock/real runner.
- [x] Существующий Claude/OpenAI review loop сохранён как reviewer; он больше не выдаётся за coding-agent executor.
- [x] Минимальный настоящий coding-agent executor запускает локальный Codex CLI в cwd отдельного worktree, передаёт точный список разрешённых файлов и проверяет фактический Git diff.
- [x] Пустой diff, изменение вне file boundary, попытка работы с `main`, ненулевой exit code, timeout и cancel не считаются успешным выполнением.
- [x] Timeout/cancel coding-процесса удерживает scheduler slot до закрытия дочернего процесса; перекрывающий retry не начинается.
- [x] Per-request timeout для Claude/OpenAI: по `120000` мс по умолчанию; общий GitHub timeout не увеличивается.
- [x] Ограниченные provider retries для 429/5xx и structured-output retries с явной причиной остановки.
- [x] AbortSignal/cancellation для provider requests и гарантированный structured failure JSON при timeout/error.
- [x] Верхнеуровневый MCP deadline ниже gateway timeout: timeout возвращает structured JSON с partial result, checkpoint, last provider/chunk/round и `ready_to_merge=false`.
- [x] Общий deadline provider review loop: `REVIEW_LOOP_TIMEOUT_MS=600000`; structured provider start/completion/timeout/error и loop-aborted events.
- [x] Оптимизирован review loop: один обязательный раунд по всем chunks, follow-up только для проблемных chunks, guard перед новым provider call и partial result при неполном покрытии; `ready_to_merge=false` до полного покрытия.
- [x] Deterministic mock runner для тестов.
- [x] Cost-aware review modes: `cheap` по умолчанию, `standard` для рискованных chunks и ручной `deep`; лимиты chunks/provider calls/output tokens/time/estimated cost, redacted usage metrics и structured `COST_LIMIT` partial result.
- [partial] Реальный параллельный запуск двух независимых coding-agent tasks: executor и управляемые subprocess/worktree tests готовы; один живой Codex CLI pilot ожидает отдельного подтверждения расхода account quota.
- [x] Real runner получает отдельный workspace descriptor каждой подзадачи; автоматический merge отсутствует.
- [x] Opt-in real-runner smoke test добавлен и отключён по умолчанию.
- [x] Integration lifecycle tests: `create → planning → running → completed/failed`.
- [x] Worktree/branch isolation для изменяющих код агентов.
- [x] Защита прямых изменений в `main` policy-тестом.
- [x] Отдельный workspace descriptor на subtask: `job_id`, `subtask_id`, path, branch, base ref, state.
- [x] Workspace safety: запрет `main`, path traversal, повторного пути и выхода за allowed root.
- [x] Workspace lifecycle подключён к service; normal completion не удаляет workspace.
- [x] Explicit idempotent cleanup и cancel workspace state покрыты тестами.
- [x] Workspace integration tests используют mock Git и не модифицируют реальный repository.

### Интеграция и review

- [x] Integrator: сбор результатов и конфликты.
- [x] Job-level Reviewer после интеграции.
- [x] Обязательный project test gate перед общим review.
- [x] Test runner adapter: mock/real режимы, timeout, exit code, stdout/stderr и статусы `passed`/`failed`/`timeout`/`error`.
- [x] Test evidence сохраняется в job result и требуется для approval Reviewer.
- [x] Единый итоговый отчёт: `summary`, `changed_files`, `tests`, `warnings`, `conflicts`, `remaining_work`, `final_decision`.
- [x] Review result сохраняет `final_decision`, `summary` и `review_findings`.
- [x] Mock и real job-level Reviewer adapters покрыты тестами.

### MCP API и качество

- [x] Сохранены legacy MCP-инструменты.
- [x] `create_orchestration_job`.
- [x] `get_job_status`.
- [x] `get_job_result`.
- [x] `cancel_job`.
- [x] Неблокирующая работа `create_orchestration_job` доказана на service/core уровне; MCP contract tests проходят в CI.
- [x] Unit-тесты статусов, store, Planner, scheduler, retry, timeout, cancel и зависимостей.
- [x] MCP contract tests проходят в CI; локальная среда по-прежнему ограничена `cache=only-if-cached` и Windows `spawn EPERM` для Node workers.
- [x] MCP server import-safe: HTTP listener создаётся и запускается только через `npm run start:mcp`; `/health`, MCP initialize и список tools сохранены.

### Read-only observability tracker

- [x] Read-only API: job list, job details и job events.
- [x] SSE-поток на базе существующей observability event model.
- [x] Dependency-free HTML-панель со статусами agents/subtasks, timeline, test evidence, warnings, limits, aggregate и review result.
- [x] Tracker access token, same-origin cookie, no CORS, redaction и отсутствие write/command operations.
- [x] Unit/API/SSE/security tests, включая invalid job id, unauthorized access и token leak protection.

### Deployment

- [x] Production hardening baseline: committed lockfile, reproducible `npm ci` Docker build, `.dockerignore`, mock-only safe defaults and dependency-free smoke checks.
- [x] Production smoke checks cover `/health`, authenticated `/tracker`, MCP initialization, `tools/list` and `orchestrator_status` without provider calls.
- [x] Ограничения production Docker зафиксированы: worktree isolation/real runner не готовы, job state локальный и эфемерный, `ORCHESTRATION_TRACKER_TOKEN` не хранится в Git.
- [ ] Production deployment нового MVP.
- [ ] Railway/Plugin проверка после отдельного разрешения.

## Текущий этап

### PR #7: доказательный разбор Agent Review #91

- [x] Конфликты с актуальным `stage4-mcp` сведены с сохранением ручного trusted reviewer и mock-only CI.
- [x] Подтверждённые findings закрыты regression-тестами: non-approved real agent result, межjobная отмена scheduler, timeout без перекрывающего retry, обход лимитов через options, отмена после scheduling, противоречивые схемы, provider timeout race, невалидный review deadline и smoke cleanup.
- [x] Псевдодефекты не исправлялись: tracker авторизует запросы в `ReadOnlyTracker.handle`; неполное cheap coverage уже блокируется в aggregate.
- [x] В полном локальном test suite обнаружена и исправлена нестабильность SSE-теста: ожидание события теперь ограничено дедлайном, а stream закрывается в `finally`.
- [ ] Merge PR #7, production deployment и реальные provider calls остаются отдельными решениями; test gate и CI обязательны перед обсуждением merge.

### Адресный аудит восьми findings Agent Review #92

- [x] Tracker authorization: ложное срабатывание. `mcp-server.js` передаёт tracker первым, но `ReadOnlyTracker.handle` сам проверяет bearer/cookie до store/API операций; добавлена regression-проверка Secure cookie.
- [x] Runner timeout/cancel: подтверждённый риск. Scheduler теперь не освобождает active slot до settle runner, не продолжает pipeline после timeout и не повторяет timed-out attempt; добавлен regression-тест с runner, игнорирующим AbortSignal.
- [x] `JsonJobStore.update`: подтверждённый дефект. Результат updater теперь повторно валидируется и не может изменить `job_id`; добавлен regression-тест.
- [x] Numeric limits/deadlines: подтверждённый edge case. Некорректный explicit MCP deadline отклоняется до запуска child process; scheduler использует конечные безопасные fallback-значения.
- [x] Dependency/deadlock race: подтверждённый риск. Dependency updates выполняются через актуальный serialized store snapshot, а deadlock проверяется после повторного чтения состояния.
- [x] Cancellation state/already-aborted signal: подтверждённый edge case. Cancellation marker очищается после обработки, `withTestTimeout` учитывает уже отменённый parent signal.
- [x] Workspace cleanup: подтверждённый edge case. Cleanup применяет ту же нормализацию `main` refs, что и создание workspace.
- [x] Tracker cookie: подтверждённое hardening-замечание. Cookie теперь получает `Secure` по умолчанию с явным env override только для локального HTTP.
- [x] Исправления `75bd116` перенесены в существующий PR #7 без отдельного PR; итоговая ветка содержит исходный PR7 (`04afb62`) и hardening-изменения.
- [partial] Agent Orchestrator CI: pull-request run на актуальном checkpoint зелёный; один push-run упал на шаге orchestration tests без доступного подробного лога, поэтому причина не доказана. Staging deployment для актуального SHA запущен, финальный статус и smoke ещё не подтверждены.
- [ ] Авторизованный staging MCP smoke остаётся незавершённым: режимы и токены не проверены, production deployment не разрешён.

### Локальный coding-agent pilot

- [x] Run2 подтвердил запуск двух Codex CLI процессов в разных Git worktree без retry; оба завершились штатно с exit code `0`, но не создали Git diff.
- [x] Доказанный диагностический пробел закрыт: `coding_agent_empty_diff` и non-zero process result сохраняют bounded stdout/stderr excerpts, exit code, signal и termination reason.
- [x] Диагностика редактирует secret assignments и известные token patterns до обрезки; long output и schema persistence покрыты бесплатными subprocess-тестами.
- [ ] Причина поведения Codex внутри run2 не может быть восстановлена из старого запуска, потому что исходный executor отбросил output; один новый real pilot требует отдельного подтверждения квоты.

Все изменения ограничены подтверждёнными сценариями; security-модель trusted reviewer, ручной workflow и legacy MCP-инструменты не менялись. Авторизованный staging MCP smoke остаётся незавершённым и блокирует production deployment.


Этап observability/limits и read-only web tracker реализованы и подтверждены зелёными CI runs #12/#13. Этап расширения role registry и Planner routing завершён и подтверждён зелёными CI runs #14 (push) и #15 (pull request). Production hardening подготовлен; merge/deployment не выполнялись. Provider review теперь поддерживает cost-aware режимы `cheap`/`standard`/`deep`: по умолчанию Claude делает один проход, OpenAI подключается только к findings и финальному adjudication, а provider calls, chunks, output tokens, time и estimated cost ограничены конфигурацией. Лимиты возвращают structured `COST_LIMIT` с usage metrics, partial result и `ready_to_merge=false`; mock CI не выполняет реальные provider calls. Автоматический review убран с `pull_request.synchronize`, поэтому review не повторяется на каждый push; `deep` доступен только через ручной `workflow_dispatch`. Существующий deadline/AbortSignal/retry/structured recovery path сохранён. MCP-level deadline `MCP_REVIEW_DEADLINE_MS=240000`, checkpoint прогресса и asynchronous orchestration tools остаются без изменений. Production deployment остаётся отдельным этапом и требует явного подтверждения.
