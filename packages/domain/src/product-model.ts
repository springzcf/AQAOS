/**
 * Product Model 域契约（T-E02-07，DDD §4.3 / SRS FR-006）。
 *
 * Product Analyst 的结构化产出：URL/OpenAPI/产品文档 → 业务实体、用户角色、
 * 用户旅程、API 依赖、状态迁移。三个层次：
 * - ProductModelSchema：zod 契约（SDK outputFormat 单源 JSON Schema 由
 *   PRODUCT_MODEL_JSON_SCHEMA 派生，同 T-E02-06 Planner 模式）；
 * - validateProductModel：合同校验（引用完整性——旅程 actor/步骤实体/API
 *   引用、状态迁移实体都必须指向已声明集合；键批内唯一）；
 * - productModelToKnowledgeGraph：迁移 0004 knowledge_nodes/knowledge_edges
 *   的纯映射（置信标注存 properties.confidence；边关系值域由本文件定义——
 *   DDD §7.2 "值域由应用层定义"的应用层落点）。
 *
 * "无凭空事实"由 schema 强制：每个事实（实体/角色/旅程/API/状态迁移）必须
 * 携带 confidence ∈ confirmed | inferred | unknown（SRS L221）；inferred 事实
 * 应附 inferredFrom 依据，材料回答不了的进 openQuestions 而不是断言。
 */

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { FactConfidenceSchema } from "./enums.js";

/** 稳定标识约定：短、小写、连字符（与 planner 任务 id 同律）。 */
const KeySchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/, 'key must be lowercase-hyphenated (e.g. "order")');

/** 依据指针（inferred 事实的推导来源；confirmed 事实可省——材料即依据）。 */
const InferredFromSchema = z.string().min(1).max(500);

export const BusinessEntitySchema = z
    .object({
        key: KeySchema,
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(2000).optional(),
        confidence: FactConfidenceSchema,
        inferredFrom: InferredFromSchema.optional(),
    })
    .strict();
export type BusinessEntity = z.infer<typeof BusinessEntitySchema>;

export const UserRoleSchema = z
    .object({
        key: KeySchema,
        name: z.string().min(1).max(200),
        description: z.string().min(1).max(2000).optional(),
        /** 角色权限要点（自然语言短语，如 "can-checkout"、"admin-only"）。 */
        permissions: z.array(z.string().min(1).max(200)).max(50).default([]),
        confidence: FactConfidenceSchema,
        inferredFrom: InferredFromSchema.optional(),
    })
    .strict();
export type UserRole = z.infer<typeof UserRoleSchema>;

export const JourneyStepSchema = z
    .object({
        name: z.string().min(1).max(200),
        action: z.string().min(1).max(2000),
        /** 步骤操作的实体（引用 businessEntities.key）。 */
        targetEntity: KeySchema.optional(),
        /** 步骤调用的 API（引用 apiDependencies.key）。 */
        apiDependency: KeySchema.optional(),
    })
    .strict();
export type JourneyStep = z.infer<typeof JourneyStepSchema>;

export const UserJourneySchema = z
    .object({
        key: KeySchema,
        name: z.string().min(1).max(200),
        /** 执行者（引用 userRoles.key）。 */
        actor: KeySchema,
        steps: z.array(JourneyStepSchema).min(1).max(100),
        confidence: FactConfidenceSchema,
        inferredFrom: InferredFromSchema.optional(),
    })
    .strict();
export type UserJourney = z.infer<typeof UserJourneySchema>;

const HttpMethodSchema = z.enum(["get", "post", "put", "patch", "delete", "options", "head"]);

export const ApiDependencySchema = z
    .object({
        key: KeySchema,
        method: HttpMethodSchema,
        path: z.string().min(1).max(500),
        summary: z.string().min(1).max(2000).optional(),
        confidence: FactConfidenceSchema,
        inferredFrom: InferredFromSchema.optional(),
    })
    .strict();
export type ApiDependency = z.infer<typeof ApiDependencySchema>;

export const StateTransitionSchema = z
    .object({
        key: KeySchema,
        /** 状态所属实体（引用 businessEntities.key）。 */
        entity: KeySchema,
        /** 起始状态名（该实体的一个状态；如 "pending"）。 */
        from: z.string().min(1).max(100),
        /** 目标状态名。 */
        to: z.string().min(1).max(100),
        trigger: z.string().min(1).max(500).optional(),
        confidence: FactConfidenceSchema,
        inferredFrom: InferredFromSchema.optional(),
    })
    .strict();
export type StateTransition = z.infer<typeof StateTransitionSchema>;

export const ProductModelSchema = z
    .object({
        summary: z.string().min(1).max(2000),
        businessEntities: z.array(BusinessEntitySchema).min(1).max(200),
        userRoles: z.array(UserRoleSchema).min(1).max(100),
        journeys: z.array(UserJourneySchema).min(1).max(100),
        apiDependencies: z.array(ApiDependencySchema).max(500).default([]),
        stateTransitions: z.array(StateTransitionSchema).max(500).default([]),
        /** 材料回答不了的问题（喂给 Product Analyst 对话轮与 planner 假设）。 */
        openQuestions: z.array(z.string().min(1).max(500)).max(100).default([]),
    })
    .strict();
export type ProductModel = z.infer<typeof ProductModelSchema>;

/**
 * SDK outputFormat 单源 JSON Schema（T-E02-06 同模式）：
 * 不传 name 选项——传入会包一层 {$ref, definitions}，SDK 需要裸顶层对象。
 */
export const PRODUCT_MODEL_JSON_SCHEMA: Record<string, unknown> = zodToJsonSchema(
    ProductModelSchema,
) as Record<string, unknown>;

/** 合同校验问题（引用完整性/键唯一性；path 指向违约元素）。 */
export interface ProductModelIssue {
    readonly code:
        | "DUPLICATE_KEY"
        | "UNKNOWN_ACTOR"
        | "UNKNOWN_ENTITY"
        | "UNKNOWN_API"
        | "UNKNOWN_TRANSITION_ENTITY";
    readonly message: string;
    /** 违约元素定位（如 "journeys.checkout.actor"）。 */
    readonly path?: string;
}

function indexKeys(items: readonly { key: string }[]): Set<string> {
    return new Set(items.map((item) => item.key));
}

/**
 * 合同校验：集合内键唯一 + 交叉引用完整（旅程 actor → 角色；步骤
 * targetEntity → 实体；步骤 apiDependency → API；迁移实体 → 实体）。
 * 返回空数组 ⟺ 模型可作为知识图谱落库。
 */
export function validateProductModel(model: ProductModel): ProductModelIssue[] {
    const issues: ProductModelIssue[] = [];

    const collections: readonly { label: string; items: readonly { key: string }[] }[] = [
        { label: "businessEntities", items: model.businessEntities },
        { label: "userRoles", items: model.userRoles },
        { label: "journeys", items: model.journeys },
        { label: "apiDependencies", items: model.apiDependencies },
        { label: "stateTransitions", items: model.stateTransitions },
    ];
    for (const { label, items } of collections) {
        const seen = new Set<string>();
        for (const item of items) {
            if (seen.has(item.key)) {
                issues.push({
                    code: "DUPLICATE_KEY",
                    message: `duplicate key "${item.key}" in ${label}`,
                    path: `${label}.${item.key}`,
                });
            }
            seen.add(item.key);
        }
    }

    const roleKeys = indexKeys(model.userRoles);
    const entityKeys = indexKeys(model.businessEntities);
    const apiKeys = indexKeys(model.apiDependencies);

    for (const journey of model.journeys) {
        if (!roleKeys.has(journey.actor)) {
            issues.push({
                code: "UNKNOWN_ACTOR",
                message: `journey "${journey.key}" actor "${journey.actor}" is not a declared user role`,
                path: `journeys.${journey.key}.actor`,
            });
        }
        journey.steps.forEach((step, index) => {
            if (step.targetEntity !== undefined && !entityKeys.has(step.targetEntity)) {
                issues.push({
                    code: "UNKNOWN_ENTITY",
                    message: `journey "${journey.key}" step ${index} references undeclared entity "${step.targetEntity}"`,
                    path: `journeys.${journey.key}.steps[${index}].targetEntity`,
                });
            }
            if (step.apiDependency !== undefined && !apiKeys.has(step.apiDependency)) {
                issues.push({
                    code: "UNKNOWN_API",
                    message: `journey "${journey.key}" step ${index} references undeclared api dependency "${step.apiDependency}"`,
                    path: `journeys.${journey.key}.steps[${index}].apiDependency`,
                });
            }
        });
    }

    for (const transition of model.stateTransitions) {
        if (!entityKeys.has(transition.entity)) {
            issues.push({
                code: "UNKNOWN_TRANSITION_ENTITY",
                message: `transition "${transition.key}" entity "${transition.entity}" is not a declared business entity`,
                path: `stateTransitions.${transition.key}.entity`,
            });
        }
    }
    return issues;
}

/**
 * 知识图谱节点（迁移 0004 knowledge_nodes 的应用层形状；置信标注在
 * properties.confidence——表注释的既定约定）。
 */
export interface KnowledgeGraphNode {
    nodeType: string;
    externalKey: string;
    properties: Record<string, unknown>;
}

/** 知识图谱边（端点用 externalKey 引用本批节点；关系值域见 KNOWN_RELATIONS）。 */
export interface KnowledgeGraphEdge {
    sourceKey: string;
    targetKey: string;
    relation: string;
    properties: Record<string, unknown>;
}

export interface KnowledgeGraphPayload {
    nodes: KnowledgeGraphNode[];
    edges: KnowledgeGraphEdge[];
}

/** node_type 值域（迁移 0004 列为 TEXT，应用层在此定义合法值）。 */
export const KNOWLEDGE_NODE_TYPES = [
    "business-entity",
    "user-role",
    "journey",
    "api-endpoint",
    "entity-state",
] as const;
export type KnowledgeNodeType = (typeof KNOWLEDGE_NODE_TYPES)[number];

/**
 * 边关系值域（DDD §7.2 "值域由应用层定义"）：
 * - performed-by：journey → user-role（谁在走这条旅程）；
 * - covers：journey → business-entity（旅程步骤触达的实体）；
 * - calls：journey → api-endpoint（旅程步骤调用的 API）；
 * - transition：entity-state → entity-state（状态迁移，trigger 在边属性）。
 */
export const KNOWLEDGE_RELATIONS = ["performed-by", "covers", "calls", "transition"] as const;
export type KnowledgeRelation = (typeof KNOWLEDGE_RELATIONS)[number];

const ENTITY_STATE_NODE_TYPE = "entity-state";

function entityStateKey(entity: string, state: string): string {
    return `${ENTITY_STATE_NODE_TYPE}:${entity}:${state}`;
}

/**
 * Product Model → 知识图谱纯映射（幂等输入；写侧 upsert 按 externalKey）。
 *
 * 节点：五类（实体/角色/旅程/API/实体状态）；externalKey 约定
 * `<nodeType>:<key>`、实体状态 `entity-state:<entity>:<state>`。
 * 节点按 externalKey 去重（共享状态跨迁移只落一次——写侧批内
 * DUPLICATE_NODE_KEY 会拒绝重复键）；边按 (sourceKey, targetKey,
 * relation) 去重（同一条边跨步骤重复出现只落一次）。
 * 调用方应先过 validateProductModel（引用违约会产生悬空边）。
 */
export function productModelToKnowledgeGraph(model: ProductModel): KnowledgeGraphPayload {
    const nodes: KnowledgeGraphNode[] = [];
    const edges: KnowledgeGraphEdge[] = [];
    const seenNodes = new Set<string>();
    const seenEdges = new Set<string>();

    const pushNode = (node: KnowledgeGraphNode): void => {
        if (!seenNodes.has(node.externalKey)) {
            seenNodes.add(node.externalKey);
            nodes.push(node);
        }
    };

    const pushEdge = (edge: KnowledgeGraphEdge): void => {
        const dedupe = `${edge.sourceKey}→${edge.targetKey}→${edge.relation}`;
        if (!seenEdges.has(dedupe)) {
            seenEdges.add(dedupe);
            edges.push(edge);
        }
    };

    for (const entity of model.businessEntities) {
        pushNode({
            nodeType: "business-entity",
            externalKey: `business-entity:${entity.key}`,
            properties: compact({
                name: entity.name,
                description: entity.description,
                confidence: entity.confidence,
                inferredFrom: entity.inferredFrom,
            }),
        });
    }
    for (const role of model.userRoles) {
        pushNode({
            nodeType: "user-role",
            externalKey: `user-role:${role.key}`,
            properties: compact({
                name: role.name,
                description: role.description,
                permissions: role.permissions.length > 0 ? role.permissions : undefined,
                confidence: role.confidence,
                inferredFrom: role.inferredFrom,
            }),
        });
    }
    for (const journey of model.journeys) {
        pushNode({
            nodeType: "journey",
            externalKey: `journey:${journey.key}`,
            properties: compact({
                name: journey.name,
                actor: journey.actor,
                steps: journey.steps.map((step) =>
                    compact({ name: step.name, action: step.action }),
                ),
                confidence: journey.confidence,
                inferredFrom: journey.inferredFrom,
            }),
        });
        pushEdge({
            sourceKey: `journey:${journey.key}`,
            targetKey: `user-role:${journey.actor}`,
            relation: "performed-by",
            properties: { confidence: journey.confidence },
        });
        for (const step of journey.steps) {
            if (step.targetEntity !== undefined) {
                pushEdge({
                    sourceKey: `journey:${journey.key}`,
                    targetKey: `business-entity:${step.targetEntity}`,
                    relation: "covers",
                    properties: { confidence: journey.confidence },
                });
            }
            if (step.apiDependency !== undefined) {
                pushEdge({
                    sourceKey: `journey:${journey.key}`,
                    targetKey: `api-endpoint:${step.apiDependency}`,
                    relation: "calls",
                    properties: { confidence: journey.confidence },
                });
            }
        }
    }
    for (const api of model.apiDependencies) {
        pushNode({
            nodeType: "api-endpoint",
            externalKey: `api-endpoint:${api.key}`,
            properties: compact({
                name: `${api.method.toUpperCase()} ${api.path}`,
                method: api.method,
                path: api.path,
                summary: api.summary,
                confidence: api.confidence,
                inferredFrom: api.inferredFrom,
            }),
        });
    }
    for (const transition of model.stateTransitions) {
        // from/to 各成一个实体状态节点（pushNode 去重——共享状态只落一节点）。
        pushNode({
            nodeType: ENTITY_STATE_NODE_TYPE,
            externalKey: entityStateKey(transition.entity, transition.from),
            properties: { entity: transition.entity, state: transition.from },
        });
        pushNode({
            nodeType: ENTITY_STATE_NODE_TYPE,
            externalKey: entityStateKey(transition.entity, transition.to),
            properties: { entity: transition.entity, state: transition.to },
        });
        pushEdge({
            sourceKey: entityStateKey(transition.entity, transition.from),
            targetKey: entityStateKey(transition.entity, transition.to),
            relation: "transition",
            properties: compact({
                entity: transition.entity,
                trigger: transition.trigger,
                confidence: transition.confidence,
            }),
        });
    }
    return { nodes, edges };
}

/** 剔除 undefined 值（JSONB 落库不存空键）。 */
function compact(properties: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}
