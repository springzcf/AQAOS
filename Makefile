# AQAOS 开发入口（T-E01-03）。一键起全栈依赖：make dev

COMPOSE := docker compose -f docker/docker-compose.dev.yml

.PHONY: dev down logs ps psql redis-cli temporal-ui reset clean help

dev: ## 启动全部本地依赖（postgres+pgvector/redis/minio/temporal/litellm）
	$(COMPOSE) up -d
	@echo ""
	@echo "等待依赖就绪 ..."
	@$(COMPOSE) ps
	@echo ""
	@echo "端点："
	@echo "  postgres     localhost:5432 (aqaos/aqaos)"
	@echo "  redis        localhost:6379"
	@echo "  minio        http://localhost:9001 (aqaos/aqaos-secret)"
	@echo "  temporal     localhost:7233  ui: http://localhost:8085"
	@echo "  litellm      http://localhost:4000 (ANTHROPIC_BASE_URL)"

down: ## 停止并移除容器（保留数据卷）
	$(COMPOSE) down

logs: ## 跟踪全部依赖日志
	$(COMPOSE) logs -f --tail=100

ps: ## 查看依赖状态
	$(COMPOSE) ps

psql: ## 进入 psql（aqaos 库）
	$(COMPOSE) exec postgres psql -U aqaos -d aqaos

redis-cli: ## 进入 redis-cli
	$(COMPOSE) exec redis redis-cli

reset: ## 危险：清空数据卷并重启（本地开发重置）
	$(COMPOSE) down -v
	$(MAKE) dev

clean: ## 危险：移除全部容器、网络、数据卷
	$(COMPOSE) down -v --remove-orphans

help: ## 列出全部目标
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

.DEFAULT_GOAL := help
