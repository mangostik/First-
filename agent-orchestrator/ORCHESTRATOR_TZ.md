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

- [x] Реестр MVP-ролей: Backend, QA, Reviewer; расширяемый реестр ролей.
- [x] Planner с формированием структурированного плана.
- [x] Для задачи API-функции и тестов создаются Backend, QA и зависимый Reviewer.
- [ ] Полный реестр ролей из ТЗ: Planner, Backend, Frontend, Database, QA, Security, Documentation, Reviewer, Integrator.
- [ ] Шаблоны всех типов FishCRM-задач.

### Параллельное выполнение

- [x] Канонические статусы job/subtask.
- [x] Атомарное JSON-хранилище job по `job_id`.
- [x] Dependency-aware scheduler.
- [x] Максимум 3 параллельные задачи.
- [x] Retry, timeout, cancel и обработка падения подзадачи.
- [x] Сохранение промежуточных результатов.
- [ ] Полные логи/прогресс и безопасная redaction-наблюдаемость.
- [ ] Cost/API limits.

### Runner и выполнение кода

- [x] Adapter-интерфейс agent runner.
- [x] Конфигурация mock/real runner.
- [x] Подключение существующего Claude/OpenAI review loop как real runner.
- [x] Deterministic mock runner для тестов.
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
- [partial] Неблокирующая работа `create_orchestration_job` доказана на service/core уровне; MCP runtime-проверка заблокирована отсутствующими зависимостями.
- [x] Unit-тесты статусов, store, Planner, scheduler, retry, timeout, cancel и зависимостей.
- [blocked] Полностью исполняемые MCP contract tests: `npm install` требует пакет из registry, но среда работает с `npm cache=only-if-cached`, пакета в cache нет.

### Deployment

- [ ] Production deployment нового MVP.
- [ ] Railway/Plugin проверка после отдельного разрешения.

## Текущий этап

Этап Integrator, обязательный project test gate и job-level Reviewer завершён. Lifecycle: `subtasks completed → integrating → project tests → reviewing → completed/failed`; test evidence сохраняется в job result, а Reviewer отклоняет job без успешных тестов. Следующий безопасный этап — полные role templates/наблюдаемость и cost/API limits; MCP contract/runtime verification остаётся заблокированной отдельной средой без зависимостей.
