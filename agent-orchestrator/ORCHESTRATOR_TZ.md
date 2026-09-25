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
- [x] Подключение существующего Claude/OpenAI review loop как real runner.
- [x] Таймаут Claude/OpenAI review loop увеличен до 15 минут (`900000` мс) в локальном default и CI-конфигурации.
- [x] Deterministic mock runner для тестов.
- [x] Реальный параллельный запуск двух независимых agent tasks через текущий scheduler с default `concurrency=2`.
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

### Read-only observability tracker

- [x] Read-only API: job list, job details и job events.
- [x] SSE-поток на базе существующей observability event model.
- [x] Dependency-free HTML-панель со статусами agents/subtasks, timeline, test evidence, warnings, limits, aggregate и review result.
- [x] Tracker access token, same-origin cookie, no CORS, redaction и отсутствие write/command operations.
- [x] Unit/API/SSE/security tests, включая invalid job id, unauthorized access и token leak protection.

### Deployment

- [ ] Production deployment нового MVP.
- [ ] Railway/Plugin проверка после отдельного разрешения.

## Текущий этап

Этап observability/limits и read-only web tracker реализованы и подтверждены зелёными CI runs #12/#13. Этап расширения role registry и Planner routing завершён и подтверждён зелёными CI runs #14 (push) и #15 (pull request): добавлены templates для Frontend, Database, Security и Documentation, routing шести рабочих ролей, safe fallback, независимый параллельный запуск и reviewer dependency. Архитектурный review не является блокером из-за исчерпанной OpenAI quota в существующем loop. Production merge/deployment не выполнялись.
